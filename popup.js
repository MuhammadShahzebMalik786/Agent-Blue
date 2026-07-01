document.addEventListener('DOMContentLoaded', () => {
  const apiKeyInput = document.getElementById('api-key');
  const goalInput = document.getElementById('goal');
  const startBtn = document.getElementById('start-btn');
  const stopBtn = document.getElementById('stop-btn');
  const logsContainer = document.getElementById('logs');
  const statusIndicator = document.getElementById('status-indicator');
  const memoryView = document.getElementById('memory-view');
  const providerSelect = document.getElementById('provider-select');
  const modelSelect = document.getElementById('model-select');
  const apiKeyLabel = document.getElementById('api-key-label');
  const stepCounter = document.getElementById('step-counter');
  const clearLogsBtn = document.getElementById('clear-logs-btn');
  const fetchModelsBtn = document.getElementById('fetch-models-btn');
  const humanBanner = document.getElementById('human-banner');
  const resumeBtn = document.getElementById('resume-btn');
  const humanBannerReason = document.getElementById('human-banner-reason');

  let modelsByProvider = {
    gemini: [
      { value: 'gemini-flash-latest', text: 'Gemini Flash Latest (Fast, 1.5M/day)' },
      { value: 'gemini-2.5-flash', text: 'Gemini 2.5 Flash' }
    ],
    github: [
      { value: 'gpt-4o-mini', text: 'GPT-4o Mini (Fast, 150/day)' },
      { value: 'gpt-4o', text: 'GPT-4o (Smart, 50/day)' },
      { value: 'Meta-Llama-3-70B-Instruct', text: 'Llama 3 70B (Open)' },
      { value: 'Mistral-large', text: 'Mistral Large (Open)' }
    ],
    groq: [
      { value: 'llama3-70b-8192', text: 'Llama 3 70B' },
      { value: 'llama3-8b-8192', text: 'Llama 3 8B' },
      { value: 'mixtral-8x7b-32768', text: 'Mixtral 8x7B' }
    ],
    ollama: [
      { value: 'llama3', text: 'Llama 3 (Local)' },
      { value: 'llama3.1', text: 'Llama 3.1 (Local)' }
    ]
  };

  function updateModelOptions(selectedModel = null) {
    const provider = providerSelect.value;
    modelSelect.innerHTML = '';
    modelsByProvider[provider].forEach(m => {
      const opt = document.createElement('option');
      opt.value = m.value;
      opt.textContent = m.text;
      modelSelect.appendChild(opt);
    });

    if (selectedModel && modelsByProvider[provider].some(m => m.value === selectedModel)) {
      modelSelect.value = selectedModel;
    }

    if (provider === 'gemini') {
      apiKeyLabel.textContent = 'API Key (Gemini)';
      apiKeyInput.placeholder = 'AIza...';
    } else if (provider === 'github') {
      apiKeyLabel.textContent = 'API Key (GitHub Models)';
      apiKeyInput.placeholder = 'github_pat_...';
    } else if (provider === 'groq') {
      apiKeyLabel.textContent = 'API Key (Groq)';
      apiKeyInput.placeholder = 'gsk_...';
    } else if (provider === 'ollama') {
      apiKeyLabel.textContent = 'Ollama Host URL (Optional)';
      apiKeyInput.placeholder = 'http://localhost:11434';
    }
  }

  providerSelect.addEventListener('change', () => updateModelOptions());

  // ── Fetch Models Dynamically ──
  fetchModelsBtn.addEventListener('click', async () => {
    const provider = providerSelect.value;
    const apiKey = apiKeyInput.value.trim();
    if (!apiKey && provider !== 'ollama') return alert('Please enter an API Key to fetch models.');

    fetchModelsBtn.textContent = '...';
    try {
      let models = [];
      if (provider === 'gemini') {
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error?.message || 'Failed to fetch Gemini models');
        models = data.models
          .filter(m => m.supportedGenerationMethods.includes('generateContent'))
          .map(m => ({ value: m.name.replace('models/', ''), text: m.displayName || m.name.replace('models/', '') }));
      } else if (provider === 'groq') {
        const res = await fetch('https://api.groq.com/openai/v1/models', { headers: { 'Authorization': `Bearer ${apiKey}` } });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error?.message || 'Failed to fetch Groq models');
        models = data.data.map(m => ({ value: m.id, text: m.id }));
      } else if (provider === 'github') {
        const res = await fetch('https://models.inference.ai.azure.com/models', { headers: { 'Authorization': `Bearer ${apiKey}` } });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error?.message || 'Failed to fetch GitHub models');
        models = data.data.map(m => ({ value: m.id, text: m.name || m.id }));
      } else if (provider === 'ollama') {
        const host = apiKey || 'http://localhost:11434';
        const res = await fetch(`${host}/api/tags`);
        const data = await res.json();
        if (!res.ok) throw new Error('Failed to fetch Ollama models');
        models = data.models.map(m => ({ value: m.name, text: m.name }));
      }

      if (models.length > 0) {
        modelsByProvider[provider] = models;
        chrome.storage.local.set({ cachedModels: modelsByProvider });
        updateModelOptions(modelSelect.value);
      }
    } catch (err) {
      alert(err.message);
    } finally {
      fetchModelsBtn.textContent = 'Refresh';
    }
  });

  // ── Load Saved State ──
  chrome.storage.local.get(['githubApiKey', 'selectedProvider', 'selectedModel', 'currentGoal', 'agentActive', 'cachedModels'], (data) => {
    if (data.cachedModels) modelsByProvider = data.cachedModels;
    if (data.githubApiKey) apiKeyInput.value = data.githubApiKey;
    if (data.selectedProvider) providerSelect.value = data.selectedProvider;
    updateModelOptions(data.selectedModel);
    if (data.currentGoal) goalInput.value = data.currentGoal;

    if (data.agentActive) {
      setUIActive(true);
      chrome.runtime.sendMessage({ type: 'GET_MEMORY' }, (response) => {
        if (response) memoryView.textContent = JSON.stringify(response, null, 2);
      });
      chrome.runtime.sendMessage({ type: 'GET_STEP_COUNT' }, (count) => {
        if (count) stepCounter.textContent = `Step ${count}`;
      });
    }
  });

  // ── Helpers ──
  function getTimestamp() {
    const now = new Date();
    return now.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function logMessage(text, type = 'system') {
    const el = document.createElement('div');
    el.className = `log-entry ${type}`;

    const timestamp = document.createElement('span');
    timestamp.className = 'log-timestamp';
    timestamp.textContent = getTimestamp();

    const content = document.createElement('span');
    content.textContent = ` ${text}`;

    el.appendChild(timestamp);
    el.appendChild(content);

    logsContainer.appendChild(el);
    logsContainer.scrollTop = logsContainer.scrollHeight;
  }

  function setUIActive(isActive) {
    startBtn.style.display = isActive ? 'none' : 'flex';
    stopBtn.style.display = isActive ? 'flex' : 'none';
    statusIndicator.className = `status-indicator ${isActive ? 'active' : ''}`;
    apiKeyInput.disabled = isActive;
    goalInput.disabled = isActive;
    providerSelect.disabled = isActive;
    modelSelect.disabled = isActive;
    if (!isActive) humanBanner.style.display = 'none'; // Always hide banner when stopping
  }

  // ── Start Agent ──
  startBtn.addEventListener('click', () => {
    const apiKey = apiKeyInput.value.trim();
    const provider = providerSelect.value;
    const model = modelSelect.value;
    const goal = goalInput.value.trim();

    if (!apiKey && provider !== 'ollama') return alert('Please enter an API Key.');
    if (!goal) return alert('Please enter a goal.');

    chrome.storage.local.set({ 
      githubApiKey: apiKey, 
      selectedProvider: provider,
      selectedModel: model, 
      currentGoal: goal,
      agentActive: true
    });

    setUIActive(true);
    stepCounter.textContent = 'Step 0';
    logMessage('Agent started', 'system');
    logMessage(`Provider: ${provider}`, 'system');
    logMessage(`Model: ${model}`, 'system');
    logMessage(goal, 'user');

    chrome.runtime.sendMessage({ type: 'START_AGENT', payload: { apiKey, provider, model, goal } });
  });

  // ── Stop Agent ──
  stopBtn.addEventListener('click', () => {
    chrome.storage.local.set({ agentActive: false });
    setUIActive(false);
    logMessage('Agent stopped by user.', 'system');
    chrome.runtime.sendMessage({ type: 'STOP_AGENT' });
  });

  // ── Clear Logs ──
  clearLogsBtn.addEventListener('click', () => {
    logsContainer.innerHTML = '';
  });

  // ── Listen for Messages from Background ──
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'LOG') {
      logMessage(message.payload.text, message.payload.level);

    } else if (message.type === 'AGENT_DONE') {
      setUIActive(false);
      chrome.storage.local.set({ agentActive: false });
      logMessage('Task completed or stopped.', 'success');

    } else if (message.type === 'HUMAN_NEEDED') {
      // Show the pulsing Human Node banner and freeze UI until Resume is clicked
      humanBannerReason.textContent = message.reason || 'Please complete the required action on the page.';
      humanBanner.style.display = 'flex';
      logMessage(`🧑‍💻 Human input required: ${message.reason}`, 'system');

    } else if (message.type === 'UPDATE_MEMORY') {
      memoryView.textContent = JSON.stringify(message.payload, null, 2);

    } else if (message.type === 'STEP_COUNT') {
      stepCounter.textContent = `Step ${message.payload}`;
    }
  });

  // ── Resume Button ──
  resumeBtn.addEventListener('click', () => {
    humanBanner.style.display = 'none';
    logMessage('▶ Resuming agent after human input...', 'system');
    chrome.runtime.sendMessage({ type: 'RESUME_AGENT' });
  });
});
