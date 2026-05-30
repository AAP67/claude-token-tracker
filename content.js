// ── Listen for messages from interceptor ──

window.addEventListener("message", (event) => {
  if (event.data?.type !== "BATTERY_SAVER") return;

  const { event: eventType, data } = event.data;

  if (eventType === "prompt") handlePrompt(data);
  if (eventType === "response") handleResponse(data);
  if (eventType === "rate_limit") handleRateLimit(data);
  if (eventType === "history_load") handleHistoryLoad(data);
});

// ── Token estimation ──

function estimateTokens(charCount) {
  return Math.ceil(charCount / 4);
}

// ── Storage handlers ──

function handlePrompt(data) {
  const tokens = estimateTokens(data.charCount);

  chrome.storage.local.get(["session"], (result) => {
    const session = result.session || newSession(data.convoId);

    if (session.convoId !== data.convoId) {
      archiveSession(session);
      Object.assign(session, newSession(data.convoId));
    }

    session.messageCount += 1;
    session.promptTokens += tokens;
    session.totalTokens += tokens;
    session.lastActivity = data.timestamp;

    chrome.storage.local.set({ session }, () => updateWidget());
  });
}

function handleResponse(data) {
  const responseTokens = estimateTokens(data.responseChars);
  const thinkingTokens = estimateTokens(data.thinkingChars);

  chrome.storage.local.get(["session"], (result) => {
    const session = result.session || newSession(data.convoId);

    session.responseTokens += responseTokens;
    session.thinkingTokens += thinkingTokens;
    session.totalTokens += responseTokens + thinkingTokens;
    session.lastActivity = data.timestamp;

    chrome.storage.local.set({ session }, () => updateWidget());
  });
}

function handleRateLimit(data) {
  const rateLimit = {
    status: data.type,
    utilization5h: data.windows?.["5h"]?.utilization || 0,
    utilization7d: data.windows?.["7d"]?.utilization || 0,
    resetsAt5h: data.windows?.["5h"]?.resets_at || null,
    resetsAt7d: data.windows?.["7d"]?.resets_at || null,
    updatedAt: Date.now()
  };

  chrome.storage.local.set({ rateLimit }, () => updateWidget());
}

function handleHistoryLoad(data) {
  const promptTokens = estimateTokens(data.promptChars);
  const responseTokens = estimateTokens(data.responseChars);
  const thinkingTokens = estimateTokens(data.thinkingChars);

  const session = {
    convoId: data.convoId,
    messageCount: data.messageCount,
    promptTokens: promptTokens,
    responseTokens: responseTokens,
    thinkingTokens: thinkingTokens,
    totalTokens: promptTokens + responseTokens + thinkingTokens,
    startedAt: data.timestamp,
    lastActivity: data.timestamp
  };

  chrome.storage.local.set({ session }, () => updateWidget());
  console.log("[Battery Saver] Loaded history:", session.totalTokens, "tokens from", data.messageCount, "messages");
}

function newSession(convoId) {
  return {
    convoId: convoId,
    messageCount: 0,
    promptTokens: 0,
    responseTokens: 0,
    thinkingTokens: 0,
    totalTokens: 0,
    startedAt: Date.now(),
    lastActivity: Date.now()
  };
}

function archiveSession(session) {
  chrome.storage.local.get(["history"], (result) => {
    const history = result.history || [];
    history.push({ ...session });
    if (history.length > 100) history.splice(0, history.length - 100);
    chrome.storage.local.set({ history });
  });
}

// ── Widget ──

function createWidget() {
  if (document.getElementById("bs-widget")) return;

  const widget = document.createElement("div");
  widget.id = "bs-widget";
  widget.innerHTML = `
    <div id="bs-toggle" class="green" title="Battery Saver">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <rect x="6" y="4" width="12" height="18" rx="2" stroke="#22c55e"/>
        <rect id="bs-icon-fill" x="8" y="14" width="8" height="6" rx="1" fill="#22c55e"/>
        <line x1="10" y1="2" x2="14" y2="2" stroke="#22c55e" stroke-width="2" stroke-linecap="round"/>
      </svg>
    </div>
    <div id="bs-panel">
      <div class="bs-header">
        <span class="bs-title">Battery Saver</span>
        <span class="bs-close" id="bs-close">&times;</span>
      </div>

      <div class="bs-section">
        <div class="bs-label">5-Hour Usage</div>
        <div class="bs-value"><span id="bs-5h-pct">0</span><span class="unit">% used</span></div>
        <div class="bs-bar-bg"><div class="bs-bar-fill green" id="bs-5h-bar" style="width:0%"></div></div>
        <div class="bs-sub" id="bs-5h-reset"></div>
      </div>

      <div class="bs-section">
        <div class="bs-label">7-Day Usage</div>
        <div class="bs-value"><span id="bs-7d-pct">0</span><span class="unit">% used</span></div>
        <div class="bs-bar-bg"><div class="bs-bar-fill green" id="bs-7d-bar" style="width:0%"></div></div>
        <div class="bs-sub" id="bs-7d-reset"></div>
      </div>

      <div class="bs-section">
        <div class="bs-label">This Conversation</div>
        <div class="bs-stat">
          <span class="bs-stat-label">Messages</span>
          <span class="bs-stat-value" id="bs-msgs">0</span>
        </div>
        <div class="bs-stat">
          <span class="bs-stat-label">Prompt tokens</span>
          <span class="bs-stat-value" id="bs-prompt-tok">0</span>
        </div>
        <div class="bs-stat">
          <span class="bs-stat-label">Response tokens</span>
          <span class="bs-stat-value" id="bs-resp-tok">0</span>
        </div>
        <div class="bs-stat">
          <span class="bs-stat-label">Thinking tokens</span>
          <span class="bs-stat-value" id="bs-think-tok">0</span>
        </div>
        <div class="bs-stat">
          <span class="bs-stat-label">Total tokens</span>
          <span class="bs-stat-value" id="bs-total-tok">0</span>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(widget);

  document.getElementById("bs-toggle").addEventListener("click", () => {
    document.getElementById("bs-panel").classList.toggle("open");
  });

  document.getElementById("bs-close").addEventListener("click", () => {
    document.getElementById("bs-panel").classList.remove("open");
  });
}

// ── Update widget from storage ──

function getColor(pct) {
  if (pct > 90) return "red";
  if (pct > 70) return "yellow";
  return "green";
}

function formatResetTime(timestamp) {
  if (!timestamp) return "";
  const diff = (timestamp * 1000) - Date.now();
  if (diff <= 0) return "Resetting soon...";
  const hours = Math.floor(diff / 3600000);
  const mins = Math.floor((diff % 3600000) / 60000);
  return "Resets in " + hours + "h " + mins + "m";
}

function updateWidget() {
  chrome.storage.local.get(["session", "rateLimit"], (result) => {
    const session = result.session || {};
    const rl = result.rateLimit || {};

    const pct5h = Math.round((rl.utilization5h || 0) * 100);
    const pct7d = Math.round((rl.utilization7d || 0) * 100);
    const color5h = getColor(pct5h);

    // Update toggle button color
    const toggle = document.getElementById("bs-toggle");
    if (toggle) {
      toggle.className = color5h;
      const icon = document.getElementById("bs-icon-fill");
      const iconStroke = toggle.querySelectorAll("rect, line");
      const colorHex = color5h === "red" ? "#ef4444" : color5h === "yellow" ? "#f59e0b" : "#22c55e";
      if (icon) icon.setAttribute("fill", colorHex);
      iconStroke.forEach(el => el.setAttribute("stroke", colorHex));
    }

    // 5-hour section
    const el = (id) => document.getElementById(id);
    if (el("bs-5h-pct")) el("bs-5h-pct").textContent = pct5h;
    if (el("bs-5h-bar")) {
      el("bs-5h-bar").style.width = pct5h + "%";
      el("bs-5h-bar").className = "bs-bar-fill " + color5h;
    }
    if (el("bs-5h-reset")) el("bs-5h-reset").textContent = formatResetTime(rl.resetsAt5h);

    // 7-day section
    const color7d = getColor(pct7d);
    if (el("bs-7d-pct")) el("bs-7d-pct").textContent = pct7d;
    if (el("bs-7d-bar")) {
      el("bs-7d-bar").style.width = pct7d + "%";
      el("bs-7d-bar").className = "bs-bar-fill " + color7d;
    }
    if (el("bs-7d-reset")) el("bs-7d-reset").textContent = formatResetTime(rl.resetsAt7d);

    // Session stats
    if (el("bs-msgs")) el("bs-msgs").textContent = session.messageCount || 0;
    if (el("bs-prompt-tok")) el("bs-prompt-tok").textContent = session.promptTokens || 0;
    if (el("bs-resp-tok")) el("bs-resp-tok").textContent = session.responseTokens || 0;
    if (el("bs-think-tok")) el("bs-think-tok").textContent = session.thinkingTokens || 0;
    if (el("bs-total-tok")) el("bs-total-tok").textContent = session.totalTokens || 0;
  });
}

// ── Init ──

function getConvoIdFromUrl() {
  const match = window.location.pathname.match(/\/chat\/([a-f0-9-]+)/);
  return match ? match[1] : null;
}

function init() {
  createWidget();

  // Load existing session or match to current URL
  const urlConvoId = getConvoIdFromUrl();

  chrome.storage.local.get(["session", "rateLimit"], (result) => {
    const session = result.session;

    if (session && urlConvoId && session.convoId !== urlConvoId) {
      archiveSession(session);
      const fresh = newSession(urlConvoId);
      chrome.storage.local.set({ session: fresh }, () => updateWidget());
    } else {
      updateWidget();
    }
  });

  // Refresh countdown every minute
  setInterval(updateWidget, 60000);

  // Sync across tabs
  chrome.storage.onChanged.addListener(() => {
    updateWidget();
  });

  // Detect conversation switches (SPA navigation)
  let lastUrl = location.href;
  const observer = new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      const newConvoId = getConvoIdFromUrl();
      if (newConvoId) {
        chrome.storage.local.get(["session"], (result) => {
          const session = result.session;
          if (session && session.convoId !== newConvoId) {
            archiveSession(session);
            const fresh = newSession(newConvoId);
            chrome.storage.local.set({ session: fresh }, () => updateWidget());
          }
        });
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

init();

console.log("[Battery Saver] Content script loaded");