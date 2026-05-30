(function () {
  const originalFetch = window.fetch;

  window.fetch = async function (...args) {
    const [url, options] = args;

    if (typeof url === "string" && url.includes("/completion")) {
      // Capture the prompt
      try {
        const body = JSON.parse(options.body);
        console.log("[Battery Saver] Prompt:", body.prompt);
      } catch (e) {}

      // Call original fetch
      const response = await originalFetch.apply(this, args);

      // Clone the response so we can read the stream without breaking Claude
      const clone = response.clone();

      // Read the stream in the background
      readStream(clone);

      return response;
    }

    return originalFetch.apply(this, args);
  };

  async function readStream(response) {
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
            console.log("[Battery Saver] Rate limit data:", data.message_limit);
          }

          if (data.type === "message_stop") {
            console.log("[Battery Saver] Response:", responseText);
            console.log("[Battery Saver] Thinking:", thinkingText);
          }
        } catch (e) {}
      }
    }
  }

  console.log("[Battery Saver] Interceptor loaded");
})();