// =====================================================
// Live Browser Agent — Background Service Worker (Brain)
// =====================================================

let isRunning = false;
let currentLoopTimeout = null;
let agentMemory = {};
let actionHistory = [];
let stepCount = 0;
let retryCount = 0;
let pageLoadRetries = 0;
const MAX_RETRIES = 3;
const MAX_PAGE_LOAD_RETRIES = 5;

// ── Service Worker Keep-Alive ──────────────────────────
// Chromium suspends service workers after ~30s of inactivity.
// chrome.alarms fires every 24s to prevent that during active sessions.

function startKeepAlive() {
  chrome.alarms.create('keepAlive', { periodInMinutes: 0.4 });
}

function stopKeepAlive() {
  chrome.alarms.clear('keepAlive');
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepAlive' && isRunning) {
    console.log('[KEEP-ALIVE] Service worker ping');
  }
});

// ── Logging Helpers ────────────────────────────────────

function logToUI(text, level = 'system') {
  console.log(`[${level.toUpperCase()}] ${text}`);
  chrome.runtime.sendMessage({ type: 'LOG', payload: { text, level } }).catch(() => {});
}

function updateMemoryUI() {
  chrome.runtime.sendMessage({ type: 'UPDATE_MEMORY', payload: agentMemory }).catch(() => {});
}

function updateStepCount() {
  chrome.runtime.sendMessage({ type: 'STEP_COUNT', payload: stepCount }).catch(() => {});
}

// ── Tab Helper ─────────────────────────────────────────

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0];
}

// ── Stuck-Loop Detection ───────────────────────────────
// If the last 3 actions are identical (same action type on same element),
// inject a stern warning into the prompt to force a different approach.

function detectStuckLoop() {
  if (actionHistory.length < 3) return false;
  const last3 = actionHistory.slice(-3);
  const sig = (a) => `${a.action}::${a.elementId || ''}`;
  return last3.every(a => sig(a) === sig(last3[0]));
}

// ── LLM API Call ───────────────────────────────────────

async function callLLMModel(apiKey, provider, model, goal, domState) {
  const isGemini = provider === 'gemini';
  const isGroq = provider === 'groq';
  const isOllama = provider === 'ollama';

  const stuckWarning = detectStuckLoop()
    ? `\n⚠️ CRITICAL: You are STUCK IN A LOOP! You have repeated the same action 3 times. You MUST try something completely different — a different element, scroll the page, or navigate away.\n`
    : '';

  const systemPrompt = `You are an advanced, intelligent web browser automation agent.
Your ultimate goal is: "${goal}"

CORE RULES — Follow these strictly:
1. After typing in a search bar or chat box, ALWAYS set "submit": true to press Enter.
2. After submitting a prompt to any AI/LLM site, you MUST immediately use WAIT (15-30 seconds) for the response to generate before doing anything else.
3. To save generated text from the screen to memory, prefer EXTRACT_MEMORY. Use SAVE_MEMORY only for very short strings.
4. If you can't find what you need on screen, use SCROLL to reveal hidden elements.
5. NEVER repeat the same action on the same element more than 2 times.
6. Think step-by-step: state your sub-goal in the "reason" field before acting.
7. If you need to go to a specific website, your FIRST action MUST be NAVIGATE. Do NOT use TYPE to type a URL into a search bar.
${stuckWarning}
You have a MEMORY SCRATCHPAD to persist data across pages and tabs.
Current Memory:
${JSON.stringify(agentMemory, null, 2)}

Recent Action History (DO NOT repeat failed patterns!):
${actionHistory.slice(-8).map((a, i) => `  ${i + 1}. [${a.status || 'PENDING'}] ${a.action}${a.elementId ? ' [' + a.elementId + ']' : ''} — ${a.reason} ${a.feedback ? '(' + a.feedback + ')' : ''}`).join('\n')}

Respond with a SINGLE JSON object. No markdown, no explanation, no code fences. Just raw JSON.

Available actions:
1. {"action": "CLICK", "elementId": 123, "reason": "..."}
2. {"action": "TYPE", "elementId": 123, "text": "...", "submit": true, "reason": "..."} — Set submit:true to also press Enter
3. {"action": "PRESS_ENTER", "elementId": 123, "reason": "..."}
4. {"action": "NAVIGATE", "url": "https://...", "reason": "..."}
5. {"action": "NEW_TAB", "url": "https://...", "reason": "..."}
6. {"action": "SCROLL", "direction": "down", "reason": "..."} — direction can be "up" or "down"
7. {"action": "EXTRACT_MEMORY", "elementId": 0, "key": "script", "reason": "..."} — ALWAYS use elementId:0 to auto-grab the ENTIRE last AI response on screen. NEVER use a non-zero elementId for this action, as individual text blocks are truncated. This is the ONLY correct way to save long AI-generated text.
8. {"action": "TYPE_FROM_MEMORY", "elementId": 123, "memoryKey": "script", "prefix": "Based on this script:\n\n", "suffix": "\n\nNow generate 16:9 images for every scene.", "submit": true, "reason": "..."} — Types the FULL content of a memory key into a field. Use prefix/suffix to add instructions around the memory content. This is the ONLY way to pass saved scripts/text to a new AI chat without truncation.
8. {"action": "SAVE_MEMORY", "key": "name", "value": "short text", "reason": "..."} — Only for short strings.
9. {"action": "WAIT", "seconds": 15, "reason": "..."}
10. {"action": "HUMAN_NEEDED", "reason": "CAPTCHA detected. Please solve it and click Resume."} — PAUSE and ask human for help. Use when you detect: CAPTCHA, login wall, 2FA prompt, cookie consent blocking the page, or any interactive challenge you cannot solve. The agent will freeze until the human clicks Resume.
11. {"action": "DONE", "reason": "..."}

Current Page URL: ${domState.url}
Current Page Title: ${domState.title}

Visible Elements on Screen:
${domState.dom}

What is your next single action?`;

  let endpoint, fetchOptions;

  if (isGemini) {
    endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    fetchOptions = {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        system_instruction: {
          parts: { text: systemPrompt }
        },
        contents: [
          { role: "user", parts: [{ text: "Analyze the page and determine the single best next action." }] }
        ],
        safetySettings: [
          { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
          { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
          { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
          { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
        ],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 500,
          responseMimeType: "application/json"
        }
      })
    };
  } else if (isGroq) {
    endpoint = "https://api.groq.com/openai/v1/chat/completions";
    fetchOptions = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: "Analyze the page and determine the single best next action." }
        ],
        temperature: 0.1,
        max_tokens: 500
      })
    };
  } else if (isOllama) {
    const host = apiKey || "http://localhost:11434";
    endpoint = `${host}/api/chat`;
    fetchOptions = {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: "Analyze the page and determine the single best next action." }
        ],
        stream: false,
        options: {
          temperature: 0.1
        }
      })
    };
  } else {
    // GitHub Models
    endpoint = "https://models.inference.ai.azure.com/chat/completions";
    fetchOptions = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: "Analyze the page and determine the single best next action." }
        ],
        temperature: 0.1,
        max_tokens: 500
      })
    };
  }

  const response = await fetch(endpoint, fetchOptions);

  if (!response.ok) {
    const errorText = await response.text();
    const status = response.status;

    // Auto fallback to gemini-flash-latest on daily quota exhaustion for newer/experimental models
    if (isGemini && status === 429 && errorText.includes('GenerateRequestsPerDay')) {
      if (model !== 'gemini-flash-latest') {
        logToUI(`⚠️ Daily quota exhausted for ${model}. Auto-switching to gemini-flash-latest (generous free tier limit)...`, 'system');
        chrome.storage.local.set({ selectedModel: 'gemini-flash-latest' });
        return callLLMModel(apiKey, provider, 'gemini-flash-latest', goal, domState);
      }
    }

    // Retryable errors: rate-limit or server errors
    if ([429, 500, 502, 503].includes(status) && retryCount < MAX_RETRIES) {
      retryCount++;
      const backoffMs = Math.min(retryCount * 5000, 30000);
      logToUI(`⚠️ API Error ${status}. Retrying in ${backoffMs / 1000}s... (attempt ${retryCount}/${MAX_RETRIES})`, 'error');
      await new Promise(resolve => setTimeout(resolve, backoffMs));
      return callLLMModel(apiKey, provider, model, goal, domState);
    }

    throw new Error(`API Error ${status}: ${errorText}`);
  }

  retryCount = 0; // Reset on success
  const data = await response.json();
  let content = '';
  if (isGemini) {
    content = data.candidates[0].content.parts[0].text.trim();
  } else if (isOllama) {
    content = data.message.content.trim();
  } else {
    content = data.choices[0].message.content.trim();
  }

  try {
    const cleanedContent = content.replace(/```json/g, '').replace(/```/g, '').trim();
    return JSON.parse(cleanedContent);
  } catch (e) {
    throw new Error(`Failed to parse LLM response as JSON: ${content}`);
  }
}

// ── Main Agent Loop ────────────────────────────────────

async function runAgentLoop(apiKey, provider, model, goal) {
  if (!isRunning) return;

  try {
    stepCount++;
    updateStepCount();
    logToUI(`Step ${stepCount}: Extracting DOM...`, 'system');

    const tab = await getActiveTab();
    if (!tab) throw new Error("No active tab found.");
    const tabId = tab.id;

    // ── Get DOM State (handle restricted pages) ──
    let domState;
    if (tab.url && (tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://') || tab.url.startsWith('edge://') || tab.url.startsWith('about:'))) {
      domState = {
        dom: "[0] text_block: \"This is a restricted browser system page. You cannot interact with it. Use NAVIGATE to go to the website needed for your goal.\"",
        url: tab.url,
        title: 'Restricted Page'
      };
    } else {
      try {
        domState = await new Promise((resolve, reject) => {
          chrome.tabs.sendMessage(tabId, { type: 'EXTRACT_DOM' }, (response) => {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
            } else if (!response) {
              reject(new Error("Empty response"));
            } else {
              resolve(response);
            }
          });
        });
        pageLoadRetries = 0; // Reset on success
      } catch (e) {
        pageLoadRetries++;

        // After 3 failures, try to programmatically inject content.js
        if (pageLoadRetries === 3) {
          logToUI('⚙️ Injecting content script manually...', 'system');
          try {
            await chrome.scripting.executeScript({
              target: { tabId: tabId },
              files: ['content.js']
            });
          } catch (injectErr) {
            logToUI(`Could not inject script: ${injectErr.message}`, 'error');
          }
        }

        // After 5 failures, give up waiting and give the LLM a fallback DOM
        if (pageLoadRetries >= MAX_PAGE_LOAD_RETRIES) {
          logToUI('⚠️ Page unresponsive. Giving agent control to navigate away.', 'error');
          pageLoadRetries = 0;
          domState = {
            dom: `[0] text_block: "The current page (${tab.url || 'unknown'}) is not responding to the agent. The content script could not load. Use NAVIGATE to go directly to the website needed for your goal."`,
            url: tab.url || 'about:blank',
            title: 'Unresponsive Page'
          };
        } else {
          logToUI(`⏳ Waiting for page to load... (attempt ${pageLoadRetries}/${MAX_PAGE_LOAD_RETRIES})`, 'system');
          currentLoopTimeout = setTimeout(() => runAgentLoop(apiKey, provider, model, goal), 3000);
          return;
        }
      }
    }

    const elementCount = domState.dom.split('\n').filter(l => l.trim().length > 0).length;
    logToUI(`Found ${elementCount} elements. Thinking...`, 'system');

    // ── Ask the LLM ──
    const action = await callLLMModel(apiKey, provider, model, goal, domState);

    // Track action history (keep last 10)
    const currentActionEntry = {
      action: action.action,
      elementId: action.elementId,
      reason: action.reason || '',
      status: 'PENDING',
      feedback: ''
    };
    actionHistory.push(currentActionEntry);
    if (actionHistory.length > 10) actionHistory.shift();

    logToUI(`🤖 ${action.action} — ${action.reason}`, 'agent');

    let nextLoopDelay = 6500; // Default: respects ~10 RPM rate limit

    // ── Execute the chosen action ──
    if (action.action === 'DONE') {
      logToUI('✅ Goal achieved!', 'success');
      stopAgent();
      return;

    } else if (action.action === 'HUMAN_NEEDED') {
      // Pause the loop — popup will send RESUME_AGENT when the human is done
      logToUI(`🧑‍💻 Human input needed: ${action.reason}`, 'system');
      chrome.runtime.sendMessage({ type: 'HUMAN_NEEDED', reason: action.reason }).catch(() => {});
      currentActionEntry.status = 'SUCCESS';
      // Do NOT schedule the next loop tick — wait for RESUME_AGENT message
      return;

    } else if (action.action === 'WAIT') {
      const secs = Math.max(5, Math.min(action.seconds || 15, 60));
      logToUI(`⏳ Waiting ${secs}s for content to generate...`, 'system');
      nextLoopDelay = secs * 1000;

    } else if (action.action === 'SAVE_MEMORY') {
      agentMemory[action.key] = action.value;
      updateMemoryUI();
      logToUI(`💾 Saved to memory: "${action.key}"`, 'system');
      currentActionEntry.status = 'SUCCESS';

    } else if (action.action === 'NAVIGATE') {
      logToUI(`🌐 Navigating to ${action.url}`, 'system');
      await chrome.tabs.update(tabId, { url: action.url });
      nextLoopDelay = 5000;
      currentActionEntry.status = 'SUCCESS';

    } else if (action.action === 'NEW_TAB') {
      logToUI(`📑 Opening new tab: ${action.url}`, 'system');
      await chrome.tabs.create({ url: action.url, active: true });
      nextLoopDelay = 5000;
      currentActionEntry.status = 'SUCCESS';

    } else if (['CLICK', 'TYPE', 'PRESS_ENTER', 'SCROLL', 'EXTRACT_MEMORY', 'TYPE_FROM_MEMORY'].includes(action.action)) {

      // ── Resolve TYPE_FROM_MEMORY before sending to content.js ──
      // background.js is the ONLY place that has full access to agentMemory.
      // We resolve the memory key here and inject the full text as 'resolvedText'.
      if (action.action === 'TYPE_FROM_MEMORY') {
        const memVal = agentMemory[action.memoryKey];
        if (!memVal) {
          logToUI(`✗ TYPE_FROM_MEMORY: key "${action.memoryKey}" not found in memory`, 'error');
          currentActionEntry.status = 'FAILED';
          currentActionEntry.feedback = `Memory key "${action.memoryKey}" not found`;
          currentLoopTimeout = setTimeout(() => runAgentLoop(apiKey, provider, model, goal), nextLoopDelay);
          return;
        }
        const prefix = action.prefix || '';
        const suffix = action.suffix || '';
        action.resolvedText = prefix + memVal + suffix;
        logToUI(`📋 Resolving memory key "${action.memoryKey}" (${action.resolvedText.length} chars total)`, 'system');
      }

      const result = await new Promise((resolve) => {
        chrome.tabs.sendMessage(tabId, { type: 'EXECUTE_ACTION', payload: action }, (res) => {
          if (chrome.runtime.lastError) {
            resolve({ success: false, message: chrome.runtime.lastError.message });
          } else {
            resolve(res || { success: false, message: 'No response from content script' });
          }
        });
      });

      if (result && result.success) {
        if (action.action === 'EXTRACT_MEMORY' && result.extractedText) {
          agentMemory[action.key] = result.extractedText;
          updateMemoryUI();
          logToUI(`💾 Extracted to memory: "${action.key}" (${result.extractedText.length} chars)`, 'system');
        } else {
          logToUI(`✓ ${result.message}`, 'system');
        }
        currentActionEntry.status = 'SUCCESS';
      } else {
        const errorMsg = result ? result.message : 'Unknown error';
        logToUI(`✗ ${errorMsg}`, 'error');
        currentActionEntry.status = 'FAILED';
        currentActionEntry.feedback = errorMsg;
      }

    } else {
      logToUI(`❓ Unknown action: ${action.action}`, 'error');
      currentActionEntry.status = 'FAILED';
      currentActionEntry.feedback = 'Unknown action type';
    }

    currentLoopTimeout = setTimeout(() => runAgentLoop(apiKey, provider, model, goal), nextLoopDelay);

  } catch (error) {
    logToUI(`❌ ${error.message}`, 'error');
    stopAgent();
  }
}

// ── Stop Agent ─────────────────────────────────────────

function stopAgent() {
  isRunning = false;
  if (currentLoopTimeout) clearTimeout(currentLoopTimeout);
  stopKeepAlive();
  chrome.storage.local.set({ agentActive: false });
  chrome.runtime.sendMessage({ type: 'AGENT_DONE' }).catch(() => {});

  getActiveTab().then(tab => {
    if (tab && tab.id) {
      chrome.tabs.sendMessage(tab.id, { type: 'CLEAR_HIGHLIGHTS' }).catch(() => {});
    }
  });
}

// ── Message Listener ───────────────────────────────────

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'START_AGENT') {
    if (isRunning) return;
    isRunning = true;
    agentMemory = {};
    actionHistory = [];
    stepCount = 0;
    retryCount = 0;
    updateMemoryUI();
    updateStepCount();
    startKeepAlive();

    const { apiKey, provider, model, goal } = request.payload;
    runAgentLoop(apiKey, provider, model, goal);

  } else if (request.type === 'STOP_AGENT') {
    stopAgent();

  } else if (request.type === 'RESUME_AGENT') {
    if (isRunning) {
      logToUI('▶ Resuming after human input...', 'system');
      chrome.storage.local.get(['githubApiKey', 'selectedProvider', 'selectedModel', 'currentGoal'], (data) => {
        runAgentLoop(data.githubApiKey, data.selectedProvider, data.selectedModel, data.currentGoal);
      });
    }

  } else if (request.type === 'GET_MEMORY') {
    sendResponse(agentMemory);

  } else if (request.type === 'GET_STEP_COUNT') {
    sendResponse(stepCount);
  }
});
