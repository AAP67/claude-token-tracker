// Listen for messages from the interceptor
window.addEventListener("message", (event) => {
  if (event.data?.type !== "BATTERY_SAVER") return;

  const { event: eventType, data } = event.data;

  if (eventType === "prompt") {
    handlePrompt(data);
  }

  if (eventType === "response") {
    handleResponse(data);
  }

  if (eventType === "rate_limit") {
    handleRateLimit(data);
  }
});

function estimateTokens(charCount) {
  return Math.ceil(charCount / 4);
}

function handlePrompt(data) {
  const tokens = estimateTokens(data.charCount);

  chrome.storage.local.get(["session"], (result) => {
    const session = result.session || newSession(data.convoId);

    // Update if conversation changed
    if (session.convoId !== data.convoId) {
      // Save old session, start fresh
      archiveSession(session);
      Object.assign(session, newSession(data.convoId));
    }

    session.messageCount += 1;
    session.promptTokens += tokens;
    session.totalTokens += tokens;
    session.lastActivity = data.timestamp;

    chrome.storage.local.set({ session });
    console.log("[Battery Saver] Stored prompt:", tokens, "tokens");
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

    chrome.storage.local.set({ session });
    console.log("[Battery Saver] Stored response:", responseTokens, "tokens + thinking:", thinkingTokens, "tokens");
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

  chrome.storage.local.set({ rateLimit });
  console.log("[Battery Saver] Stored rate limit:", rateLimit.utilization5h * 100 + "% used (5h)");
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

console.log("[Battery Saver] Content script loaded");