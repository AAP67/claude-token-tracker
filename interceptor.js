(function () {
  const originalFetch = window.fetch;

  window.fetch = async function (...args) {
    const [url, options] = args;

    if (typeof url === "string" && url.includes("/completion")) {
      // Extract conversation ID from URL
      const convoMatch = url.match(/chat_conversations\/([a-f0-9-]+)/);
      const convoId = convoMatch ? convoMatch[1] : "unknown";

      // Capture the prompt
      let prompt = "";
      try {
        const body = JSON.parse(options.body);
        prompt = body.prompt || "";
      } catch (e) {}

      // Send prompt data to content script
      window.postMessage({
        type: "BATTERY_SAVER",
        event: "prompt",
        data: {
          convoId: convoId,
          text: prompt,
          charCount: prompt.length,
          timestamp: Date.now()
        }
      }, "*");

      // Call original fetch
      const response = await originalFetch.apply(this, args);
      const clone = response.clone();
      readStream(clone, convoId);
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
            window.postMessage({
              type: "BATTERY_SAVER",
              event: "rate_limit",
              data: data.message_limit
            }, "*");
          }

          if (data.type === "message_stop") {
            window.postMessage({
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
            }, "*");
          }
        } catch (e) {}
      }
    }
  }

  console.log("[Battery Saver] Interceptor loaded");
})();