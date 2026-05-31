// ── Process a message event ──

function processMessage(msg) {
  const { event: eventType, data } = msg;

  if (eventType === "prompt") handlePrompt(data);
  if (eventType === "response") handleResponse(data);
  if (eventType === "rate_limit") handleRateLimit(data);
  if (eventType === "history_load") handleHistoryLoad(data);
}

// ── Listen for messages from interceptor ──

window.addEventListener("message", (event) => {
  if (event.data?.type !== "BATTERY_SAVER") return;
  processMessage(event.data);
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
    if (data.model) session.model = data.model;

    chrome.storage.local.set({ session }, () => updateWidget());
  });

  // Log to IndexedDB
  saveMessage({
    convoId: data.convoId,
    role: "human",
    text: data.text,
    charCount: data.charCount,
    promptTokens: tokens,
    responseTokens: 0,
    thinkingTokens: 0,
    model: data.model || "",
    timestamp: data.timestamp
  }).catch(() => {});
}

function handleResponse(data) {
  const responseTokens = estimateTokens(data.responseChars);
  const thinkingTokens = estimateTokens(data.thinkingChars);

  chrome.storage.local.get(["session", "rateLimit"], (result) => {
    const session = result.session || newSession(data.convoId);

    session.responseTokens += responseTokens;
    session.thinkingTokens += thinkingTokens;
    session.totalTokens += responseTokens + thinkingTokens;
    session.lastActivity = data.timestamp;

    chrome.storage.local.set({ session }, () => {
      updateWidget();

      // Update conversation in IndexedDB
      saveConversation({
        convoId: session.convoId,
        name: session.name || "",
        model: session.model || "",
        messageCount: session.messageCount,
        promptTokens: session.promptTokens,
        responseTokens: session.responseTokens,
        thinkingTokens: session.thinkingTokens,
        totalTokens: session.totalTokens,
        firstMessageAt: session.startedAt,
        lastMessageAt: session.lastActivity,
        utilization5h: result.rateLimit?.utilization5h || 0
      }).catch(() => {});
    });
  });

  // Log to IndexedDB
  saveMessage({
    convoId: data.convoId,
    role: "assistant",
    promptTokens: 0,
    responseTokens: responseTokens,
    thinkingTokens: thinkingTokens,
    model: "",
    timestamp: data.timestamp
  }).catch(() => {});
}

function handleRateLimit(data) {
  const currentUtil = data.windows?.["5h"]?.utilization || 0;

  chrome.storage.local.get(["rateLimit", "usageTracker"], (result) => {
    const prevUtil = result.rateLimit?.utilization5h || 0;
    const tracker = result.usageTracker || { totalDelta: 0, messagesSent: 0, lastEstimate: 0, stableCount: 0, displayEstimate: null };

    const delta = currentUtil - prevUtil;
    if (delta < 0) {
      tracker.totalDelta = 0;
      tracker.messagesSent = 0;
      tracker.lastEstimate = 0;
      tracker.stableCount = 0;
      tracker.displayEstimate = null;
    } else {
      tracker.messagesSent += 1;
      if (delta > 0) {
        tracker.totalDelta += delta;
      }

      if (tracker.messagesSent >= 5 && tracker.totalDelta > 0) {
        const costPerMsg = tracker.totalDelta / tracker.messagesSent;
        const remaining = Math.floor((1 - currentUtil) / costPerMsg);

        if (tracker.lastEstimate > 0) {
          const changePercent = Math.abs(remaining - tracker.lastEstimate) / tracker.lastEstimate;
          if (changePercent <= 0.03) {
            tracker.stableCount += 1;
          } else {
            tracker.stableCount = 0;
          }
        }

        tracker.lastEstimate = remaining;

        if (tracker.stableCount >= 3) {
          tracker.displayEstimate = remaining;
        }
      }
    }

    const rateLimit = {
      status: data.type,
      utilization5h: currentUtil,
      utilization7d: data.windows?.["7d"]?.utilization || 0,
      resetsAt5h: data.windows?.["5h"]?.resets_at || null,
      resetsAt7d: data.windows?.["7d"]?.resets_at || null,
      updatedAt: Date.now()
    };

    chrome.storage.local.set({ rateLimit, usageTracker: tracker }, () => updateWidget());
  });
}

function handleHistoryLoad(data) {
  const promptTokens = estimateTokens(data.promptChars);
  const responseTokens = estimateTokens(data.responseChars);
  const thinkingTokens = estimateTokens(data.thinkingChars);

  const session = {
    convoId: data.convoId,
    name: data.name || "",
    model: data.model || "",
    messageCount: data.messageCount,
    promptTokens: promptTokens,
    responseTokens: responseTokens,
    thinkingTokens: thinkingTokens,
    totalTokens: promptTokens + responseTokens + thinkingTokens,
    startedAt: data.firstMessageAt || data.timestamp,
    lastActivity: data.lastMessageAt || data.timestamp
  };

  chrome.storage.local.set({ session }, () => updateWidget());

  // Save conversation to IndexedDB
  saveConversation({
    convoId: data.convoId,
    name: data.name || "",
    model: data.model || "",
    messageCount: data.messageCount,
    promptTokens: promptTokens,
    responseTokens: responseTokens,
    thinkingTokens: thinkingTokens,
    totalTokens: promptTokens + responseTokens + thinkingTokens,
    firstMessageAt: data.firstMessageAt || data.timestamp,
    lastMessageAt: data.lastMessageAt || data.timestamp,
    utilization5h: 0
  }).catch(() => {});

  console.log("[Battery Saver] Loaded history:", session.totalTokens, "tokens from", data.messageCount, "messages");
}

function newSession(convoId) {
  return {
    convoId: convoId,
    name: "",
    model: "",
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
        <rect id="bs-icon-fill" x="8" y="18" width="8" height="1" rx="1" fill="#22c55e"/>
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
        <div class="bs-sub" id="bs-msgs-remaining"></div>
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

      <div class="bs-section" style="text-align:center">
        <button id="bs-export" style="background:none;border:1px solid #333;color:#888;font-size:11px;padding:4px 12px;border-radius:4px;cursor:pointer;">Export Data</button>
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

  document.getElementById("bs-export").addEventListener("click", async () => {
    try {
      const data = await exportAll();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "battery-saver-export.json";
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error("[Battery Saver] Export failed:", e);
    }
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
  chrome.storage.local.get(["session", "rateLimit", "usageTracker"], (result) => {
    const session = result.session || {};
    const rl = result.rateLimit || {};
    const tracker = result.usageTracker || {};

    const pct5h = Math.round((rl.utilization5h || 0) * 100);
    const pct7d = Math.round((rl.utilization7d || 0) * 100);
    const color5h = getColor(pct5h);

    const toggle = document.getElementById("bs-toggle");
    if (toggle) {
      toggle.className = color5h;
      const icon = document.getElementById("bs-icon-fill");
      const colorHex = color5h === "red" ? "#ef4444" : color5h === "yellow" ? "#f59e0b" : "#22c55e";

      if (icon) {
        const maxHeight = 14;
        const remaining = 100 - pct5h;
        const fillHeight = Math.max(1, (remaining / 100) * maxHeight);
        const yPos = 18 - fillHeight;
        icon.setAttribute("y", yPos);
        icon.setAttribute("height", fillHeight);
        icon.setAttribute("fill", colorHex);
      }

      const iconStroke = toggle.querySelectorAll("rect, line");
      iconStroke.forEach(el => el.setAttribute("stroke", colorHex));
    }

    const el = (id) => document.getElementById(id);

    if (el("bs-5h-pct")) el("bs-5h-pct").textContent = pct5h;
    if (el("bs-5h-bar")) {
      el("bs-5h-bar").style.width = pct5h + "%";
      el("bs-5h-bar").className = "bs-bar-fill " + color5h;
    }
    if (el("bs-5h-reset")) el("bs-5h-reset").textContent = formatResetTime(rl.resetsAt5h);

    if (el("bs-msgs-remaining")) {
      if (tracker.displayEstimate) {
        el("bs-msgs-remaining").textContent = "~" + tracker.displayEstimate + " messages remaining";
      } else if (pct5h >= 90) {
        el("bs-msgs-remaining").textContent = "Almost at limit";
      } else if (pct5h >= 75) {
        el("bs-msgs-remaining").textContent = "Running low";
      } else if (pct5h >= 50) {
        el("bs-msgs-remaining").textContent = "Getting low";
      } else if (pct5h >= 25) {
        el("bs-msgs-remaining").textContent = "About half remaining";
      } else {
        el("bs-msgs-remaining").textContent = "Plenty of juice left";
      }
    }

    const color7d = getColor(pct7d);
    if (el("bs-7d-pct")) el("bs-7d-pct").textContent = pct7d;
    if (el("bs-7d-bar")) {
      el("bs-7d-bar").style.width = pct7d + "%";
      el("bs-7d-bar").className = "bs-bar-fill " + color7d;
    }
    if (el("bs-7d-reset")) el("bs-7d-reset").textContent = formatResetTime(rl.resetsAt7d);

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

  if (window.__batterySaverQueue && window.__batterySaverQueue.length > 0) {
    console.log("[Battery Saver] Processing", window.__batterySaverQueue.length, "queued messages");
    window.__batterySaverQueue.forEach(msg => processMessage(msg));
    window.__batterySaverQueue = [];
  }

  updateWidget();

  setInterval(updateWidget, 60000);

  chrome.storage.onChanged.addListener(() => {
    updateWidget();
  });

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