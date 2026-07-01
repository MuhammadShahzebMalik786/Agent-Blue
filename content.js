// =====================================================
// Live Browser Agent — Content Script (Eyes & Hands)
// =====================================================

let interactableElements = new Map();

// ── Visibility Check (Viewport Only) ───────────────────

function isElementVisible(el) {
  try {
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);

    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    if (rect.width === 0 || rect.height === 0) return false;

    // Only include elements currently visible in the viewport
    const vw = window.innerWidth || document.documentElement.clientWidth;
    const vh = window.innerHeight || document.documentElement.clientHeight;
    return rect.bottom >= 0 && rect.right >= 0 && rect.top <= vh && rect.left <= vw;
  } catch (e) {
    return false;
  }
}

// ── Recursive Element Discovery (pierces Shadow DOM) ───

function getInteractiveElements(root) {
  let elements = [];
  let nodes;
  try {
    nodes = root.querySelectorAll('*');
  } catch (e) {
    return elements;
  }

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];

    // Recurse into Shadow DOM
    if (node.shadowRoot) {
      elements = elements.concat(getInteractiveElements(node.shadowRoot));
    }

    const tag = node.tagName ? node.tagName.toLowerCase() : '';
    const role = node.getAttribute ? node.getAttribute('role') : null;

    const isInteractive =
      ['a', 'button', 'input', 'textarea', 'select'].includes(tag) ||
      role === 'button' || role === 'link' || role === 'textbox' || role === 'tab' || role === 'menuitem' ||
      (node.getAttribute && node.getAttribute('contenteditable') === 'true') ||
      (node.hasAttribute && node.hasAttribute('tabindex') && node.getAttribute('tabindex') !== '-1');

    // Also capture text-heavy elements so the agent can "read" the page
    let hasDirectText = false;
    if (!isInteractive && node.childNodes) {
      for (let j = 0; j < node.childNodes.length; j++) {
        const child = node.childNodes[j];
        if (child.nodeType === Node.TEXT_NODE && child.textContent.trim().length > 15) {
          hasDirectText = true;
          break;
        }
      }
    }

    if (isInteractive || hasDirectText) {
      node._isInteractive = isInteractive;
      elements.push(node);
    }
  }
  return elements;
}

// ── Extract Direct Text Only (avoids nested duplication) ──

function getDirectText(el) {
  let text = '';
  for (let i = 0; i < el.childNodes.length; i++) {
    if (el.childNodes[i].nodeType === Node.TEXT_NODE) {
      text += el.childNodes[i].textContent;
    }
  }
  return text.trim();
}

// ── Build Simplified DOM Snapshot ──────────────────────

function buildSimplifiedDOM() {
  // IMPORTANT: Clean up ALL old highlights before re-scanning
  clearHighlights();

  interactableElements.clear();
  let domText = '';
  let idCounter = 1;
  const addedTexts = new Set(); // Text deduplication tracker

  const elements = getInteractiveElements(document);

  for (let i = 0; i < elements.length; i++) {
    const el = elements[i];
    if (!isElementVisible(el)) continue;

    // ── Smart Text Extraction ──
    let text;
    if (!el._isInteractive) {
      // For text blocks, only use direct text to avoid pulling nested duplicates
      text = getDirectText(el);
    } else {
      // For interactive elements, use innerText/value/aria-label
      text = el.value || el.innerText || el.placeholder || (el.getAttribute && el.getAttribute('aria-label')) || el.alt || '';
    }
    text = text.trim().replace(/\s+/g, ' ');

    // Character limits: 200 for buttons/links, 500 for text blocks
    const charLimit = el._isInteractive ? 200 : 500;
    text = text.substring(0, charLimit);

    // ── Classify Element Type ──
    let type = el.tagName ? el.tagName.toLowerCase() : 'unknown';
    if (type === 'input') type = `input[${el.type || 'text'}]`;
    if (el.getAttribute && el.getAttribute('contenteditable') === 'true') type = 'contenteditable';
    if (!el._isInteractive) type = 'text_block';

    // Skip empty non-input elements
    if (text.length === 0 && !type.includes('input') && type !== 'contenteditable') continue;

    // ── Text Deduplication ──
    // Skip text_block elements whose text is already represented
    if (type === 'text_block' && text.length > 20) {
      const textKey = text.substring(0, 100);
      if (addedTexts.has(textKey)) continue;
      addedTexts.add(textKey);
    }

    const id = idCounter++;
    interactableElements.set(id, el);

    const entry = `[${id}] ${type}: "${text}"\n`;

    // Hard character cutoff (~25k chars ≈ ~6k tokens) to prevent API 413 errors
    if (domText.length + entry.length > 25000) {
      domText += '\n...[TRUNCATED: Too many elements. Use SCROLL to reveal more.]\n';
      break;
    }

    domText += entry;

    // ── Visual Highlight Overlays ──
    try {
      el.style.outline = '2px solid rgba(59, 130, 246, 0.4)';

      const label = document.createElement('div');
      label.className = 'agent-ui-label';
      label.style.cssText = `
        position: absolute;
        background: linear-gradient(135deg, #3b82f6, #8b5cf6);
        color: white;
        font-size: 9px;
        font-weight: 600;
        padding: 1px 4px;
        border-radius: 3px;
        z-index: 2147483647;
        pointer-events: none;
        font-family: monospace;
        line-height: 1.2;
      `;
      const rect = el.getBoundingClientRect();
      label.style.top = `${rect.top + window.scrollY - 14}px`;
      label.style.left = `${rect.left + window.scrollX}px`;
      label.textContent = id;
      document.body.appendChild(label);
    } catch (e) { /* skip if unable to highlight */ }
  }

  return domText;
}

// ── Clear All Highlights ──────────────────────────────

function clearHighlights() {
  interactableElements.forEach((el) => {
    try { el.style.outline = ''; } catch (e) { /* element may have been removed */ }
  });
  // Remove ALL label overlays at once
  document.querySelectorAll('.agent-ui-label').forEach(label => label.remove());
  interactableElements.clear();
}

// ── Human-Like Event Simulation ───────────────────────

function simulateClick(el) {
  const rect = el.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  const opts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y };

  el.dispatchEvent(new PointerEvent('pointerdown', opts));
  el.dispatchEvent(new MouseEvent('mousedown', opts));
  el.dispatchEvent(new PointerEvent('pointerup', opts));
  el.dispatchEvent(new MouseEvent('mouseup', opts));
  el.dispatchEvent(new MouseEvent('click', opts));
}

function simulateEnter(el) {
  const opts = { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter', keyCode: 13, which: 13 };
  el.dispatchEvent(new KeyboardEvent('keydown', opts));
  el.dispatchEvent(new KeyboardEvent('keypress', opts));
  el.dispatchEvent(new KeyboardEvent('keyup', opts));
}

// ── Set Input Value (React/Vue compatible) ────────────

function setNativeValue(el, value) {
  // React overrides the value setter; we need the native one to trigger onChange
  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
  if (descriptor && descriptor.set) {
    descriptor.set.call(el, value);
  } else {
    el.value = value;
  }
}

// ── Execute Actions ───────────────────────────────────

function executeAction(action) {
  return new Promise((resolve) => {

    // ── CLICK ──
    if (action.action === 'CLICK') {
      const el = interactableElements.get(action.elementId);
      if (!el) return resolve({ success: false, message: `Element [${action.elementId}] not found` });

      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setTimeout(() => {
        simulateClick(el);
        resolve({ success: true, message: `Clicked element [${action.elementId}]` });
      }, 250);

    // ── TYPE ──
    } else if (action.action === 'TYPE') {
      const el = interactableElements.get(action.elementId);
      if (!el) return resolve({ success: false, message: `Element [${action.elementId}] not found` });

      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.focus();
      simulateClick(el); // Some editors require a click to become truly active

      setTimeout(() => {
        if (el.getAttribute('contenteditable') === 'true' || el.isContentEditable) {
          // For rich text editors: select all → replace
          document.execCommand('selectAll', false, null);
          document.execCommand('insertText', false, action.text);
        } else {
          // For standard inputs: use native setter for React compatibility
          setNativeValue(el, action.text);
        }

        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));

        if (action.submit) {
          setTimeout(() => {
            simulateEnter(el);
            if (el.form) {
              try { el.form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); } catch (e) { }
            }
            resolve({ success: true, message: `Typed into [${action.elementId}] and submitted` });
          }, 150);
        } else {
          resolve({ success: true, message: `Typed into element [${action.elementId}]` });
        }
      }, 200);

    // ── TYPE_FROM_MEMORY ──
    // Injects pre-resolved memory content (sent by background.js) directly into a field.
    // This bypasses the LLM token limit since the text is never echoed in the JSON response.
    } else if (action.action === 'TYPE_FROM_MEMORY') {
      const el = interactableElements.get(action.elementId);
      if (!el) return resolve({ success: false, message: `Element [${action.elementId}] not found` });
      if (!action.resolvedText) return resolve({ success: false, message: 'TYPE_FROM_MEMORY: no resolvedText provided by background.js' });

      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.focus();
      simulateClick(el);

      setTimeout(() => {
        if (el.getAttribute('contenteditable') === 'true' || el.isContentEditable) {
          document.execCommand('selectAll', false, null);
          document.execCommand('insertText', false, action.resolvedText);
        } else {
          setNativeValue(el, action.resolvedText);
        }

        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));

        if (action.submit) {
          setTimeout(() => {
            simulateEnter(el);
            if (el.form) {
              try { el.form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); } catch (e) { }
            }
            resolve({ success: true, message: `Typed memory key "${action.memoryKey}" into [${action.elementId}] and submitted (${action.resolvedText.length} chars)` });
          }, 150);
        } else {
          resolve({ success: true, message: `Typed memory key "${action.memoryKey}" into element [${action.elementId}] (${action.resolvedText.length} chars)` });
        }
      }, 200);

    // ── PRESS_ENTER ──
    } else if (action.action === 'PRESS_ENTER') {
      const el = interactableElements.get(action.elementId);
      if (!el) return resolve({ success: false, message: `Element [${action.elementId}] not found` });

      el.focus();
      simulateEnter(el);
      if (el.form) {
        try { el.form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); } catch (e) { }
      }
      resolve({ success: true, message: `Pressed Enter on element [${action.elementId}]` });

    // ── EXTRACT_MEMORY ──
    } else if (action.action === 'EXTRACT_MEMORY') {
      // ── Auto-Find Mode (elementId: 0) ──
      // When elementId is 0 or absent, auto-find the last AI response on the page
      // using known selectors for Gemini, ChatGPT, Claude, AI Studio, etc.
      if (!action.elementId || action.elementId === 0) {
        const RESPONSE_SELECTORS = [
          // Gemini Web
          'model-response', 'message-content', 
          '[data-message-author-role="model"]',
          // Fallback: any large text block
          'article', '[class*="model"]', '[class*="response"]', '[class*="message"]'
        ];

        let foundEl = null;
        for (const sel of RESPONSE_SELECTORS) {
          const all = document.querySelectorAll(sel);
          if (all.length > 0) {
            foundEl = all[all.length - 1]; // Always grab the LAST response
            break;
          }
        }

        if (!foundEl) {
          return resolve({ success: false, message: 'Could not auto-find AI response container. Try specifying an elementId.' });
        }

        const text = (foundEl.innerText || foundEl.textContent || '').trim();
        return resolve({
          success: true,
          message: `Auto-extracted ${text.length} characters from last AI response`,
          extractedText: text,
          key: action.key
        });
      }

      // ── Manual Element Mode ──
      const el = interactableElements.get(action.elementId);
      if (!el) return resolve({ success: false, message: `Element [${action.elementId}] not found` });

      // Climb up from the targeted element to find the full response container
      let extractEl = el;
      if (!el._isInteractive) {
        let current = el;
        while (current && current.tagName !== 'BODY') {
          const tag = current.tagName.toLowerCase();
          const cls = (current.className || '').toString().toLowerCase();
          if (tag === 'article' || tag === 'main' ||
              cls.includes('model') || cls.includes('message') || 
              cls.includes('response') || cls.includes('markdown')) {
            extractEl = current;
            break;
          }
          current = current.parentElement;
        }
        // If still only the original element, go up 3 levels as a last resort
        if (extractEl === el) {
          let p = el.parentElement;
          for (let i = 0; i < 3 && p && p.tagName !== 'BODY'; i++) {
            p = p.parentElement;
          }
          if (p && p.tagName !== 'BODY') extractEl = p;
        }
      }

      const text = (extractEl.innerText || extractEl.textContent || extractEl.value || '').trim();
      resolve({ 
        success: true, 
        message: `Extracted ${text.length} characters from element [${action.elementId}] (expanded)`, 
        extractedText: text, 
        key: action.key 
      });

    // ── SCROLL ──
    } else if (action.action === 'SCROLL') {
      const amount = action.direction === 'up' ? -window.innerHeight * 0.75 : window.innerHeight * 0.75;
      window.scrollBy({ top: amount, behavior: 'smooth' });
      resolve({ success: true, message: `Scrolled ${action.direction}` });

    } else {
      resolve({ success: false, message: `Unknown action: ${action.action}` });
    }
  });
}

// ── Message Listener ──────────────────────────────────

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'EXTRACT_DOM') {
    const simplifiedDOM = buildSimplifiedDOM();
    sendResponse({ dom: simplifiedDOM, url: window.location.href, title: document.title });

  } else if (request.type === 'EXECUTE_ACTION') {
    executeAction(request.payload).then(result => {
      sendResponse(result);
    });
    return true; // Keep message channel open for async response

  } else if (request.type === 'CLEAR_HIGHLIGHTS') {
    clearHighlights();
    sendResponse({ success: true });
  }
});
