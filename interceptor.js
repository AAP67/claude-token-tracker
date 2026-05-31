(function () {
  const originalFetch = window.fetch;
  window.__batterySaverQueue = [];

  window.fetch = async function (...args) {
    const [url, options] = args;
    const method = options?.method?.toUpperCase() || "GET";

    // ── Intercept completion POST requests ──
    if (typeof url === "string" && url.includes("/completion") && method === "POST") {
      const convoMatch = url.match(/chat_conversations\/([a-f0-9-]+)/);
      const convoId = convoMatch ? convoMatch[1] : "unknown";

      let prompt = "";
      let model = "";
      try {
        const body = JSON.parse(options.body);
        prompt = body.prompt || "";
        model = body.model || "";
      } catch (e) {}

      const msg = {
        type: "BATTERY_SAVER",
        event: "prompt",
        data: {
          convoId: convoId,
          text: prompt,
          charCount: prompt.length,
          model: model,
          timestamp: Date.now()
        }
      };
      window.__batterySaverQueue.push(msg);
      window.postMessage(msg, "*");

      const response = await originalFetch.apply(this, args);
      const clone = response.clone();
      readStream(clone, convoId);
      return response;
    }

    // ── Intercept conversation load GET requests ──
    if (typeof url === "string" && url.match(/chat_conversations\/[a-f0-9-]+\?/) && !url.includes("/completion") && method === "GET") {
      const response = await originalFetch.apply(this, args);
      const clone = response.clone();

      clone.json().then(data => {
        if (data.chat_messages) {
          const convoId = data.uuid;
          let promptChars = 0;
          let responseChars = 0;
          let thinkingChars = 0;
          let messageCount = 0;
          let firstMessageTime = null;
          let lastMessageTime = null;

          data.chat_messages.forEach(msg => {
            const msgTime = new Date(msg.created_at).getTime();
            if (!firstMessageTime) firstMessageTime = msgTime;
            lastMessageTime = msgTime;

            if (msg.sender === "human") {
              messageCount += 1;
              msg.content.forEach(block => {
                if (block.type === "text") promptChars += (block.text || "").length;
              });
            }
            if (msg.sender === "assistant") {
              msg.content.forEach(block => {
                if (block.type === "text") responseChars += (block.text || "").length;
                if (block.type === "thinking") thinkingChars += (block.thinking || "").length;
              });
            }
          });

          const msg = {
            type: "BATTERY_SAVER",
            event: "history_load",
            data: {
              convoId: convoId,
              name: data.name || "",
              model: data.model || "",
              messageCount: messageCount,
              promptChars: promptChars,
              responseChars: responseChars,
              thinkingChars: thinkingChars,
              timestamp: Date.now(),
              firstMessageAt: firstMessageTime,
              lastMessageAt: lastMessageTime
            }
          };
          window.__batterySaverQueue.push(msg);
          window.postMessage(msg, "*");
        }
      }).catch(() => {});

      return response;
    }

    return originalFetch.apply(this, args);
  };

  async function readStream(response, convoId) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    let responseText = "";
    let thinkingText = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split("\n");

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;

        try {
          const data = JSON.parse(line.slice(6));

          if (data.type === "content_block_delta") {
            if (data.delta.type === "text_delta") {
              responseText += data.delta.text;
            }
            if (data.delta.type === "thinking_delta") {
              thinkingText += data.delta.thinking;
            }
          }

          if (data.type === "message_limit") {
            const msg = {
              type: "BATTERY_SAVER",
              event: "rate_limit",
              data: data.message_limit
            };
            window.__batterySaverQueue.push(msg);
            window.postMessage(msg, "*");
          }

          if (data.type === "message_stop") {
            const msg = {
              type: "BATTERY_SAVER",
              event: "response",
              data: {
                convoId: convoId,
                responseText: responseText,
                responseChars: responseText.length,
                thinkingText: thinkingText,
                thinkingChars: thinkingText.length,
                timestamp: Date.now()
              }
            };
            window.__batterySaverQueue.push(msg);
            window.postMessage(msg, "*");
          }
        } catch (e) {}
      }
    }
  }

  console.log("[Battery Saver] Interceptor loaded");
})();