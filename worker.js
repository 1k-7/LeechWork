/**
 * CLOUDFLARE WORKER LEECH BOT (Full Version)
 * Features: /start handler, /leech handler, Stream Splicing
 */

export default {
  async fetch(request, env, ctx) {
    // We only accept POST requests from Telegram
    if (request.method === "POST") {
      try {
        const update = await request.json();

        // Ensure we have a valid message with text
        if (update.message && update.message.text) {
          const text = update.message.text;
          const chatId = update.message.chat.id;

          // --- COMMAND 1: /start ---
          if (text === "/start") {
             await sendMessage(env.BOT_TOKEN, chatId, 
               "👋 **I am alive!**\n\n" +
               "I can download files directly to Telegram (max 50MB).\n\n" +
               "**Usage:**\n`/leech http://example.com/video.mp4`"
             );
             return new Response("OK");
          }

          // --- COMMAND 2: /leech ---
          if (text.startsWith("/leech")) {
            const url = text.split(/\s+/)[1]; // Get the link after the space

            if (!url) {
              await sendMessage(env.BOT_TOKEN, chatId, "❌ **Error:** You forgot the link!\nUse: `/leech http://example.com/video.mp4`");
              return new Response("OK");
            }

            // Acknowledge the command immediately so Telegram doesn't timeout
            await sendMessage(env.BOT_TOKEN, chatId, "🚀 **Stream Established!**\nAttempting to pipe data through Cloudflare...");

            // Run the heavy downloading in the background
            ctx.waitUntil(processLeech(url, chatId, env.BOT_TOKEN));

            return new Response("OK");
          }
        }
      } catch (e) {
        // If JSON parsing fails, just ignore
        return new Response("Error", { status: 200 });
      }
    }
    
    // Default response for browser visits
    return new Response("Leech Bot is Running. Please use Telegram.");
  }
};

// --- HELPER FUNCTIONS ---

// 1. Send text message to Telegram
async function sendMessage(token, chatId, text) {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: text, parse_mode: "Markdown" })
  });
}

// 2. The Core Logic: Stream Splicing
async function processLeech(fileUrl, chatId, botToken) {
  try {
    // Step A: Fetch Source
    // We use user-agent to avoid being blocked by some servers
    const sourceResponse = await fetch(fileUrl, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" }
    });
    
    if (!sourceResponse.ok) {
        throw new Error(`Source URL returned error: ${sourceResponse.status}`);
    }

    const fileSize = sourceResponse.headers.get("content-length");
    if (!fileSize) {
       await sendMessage(botToken, chatId, "⚠️ **Failed:** Source server did not provide file size (Content-Length). Telegram requires this.");
       return;
    }
    
    // Telegram Bot API limit is 50MB (52428800 bytes)
    if (parseInt(fileSize) > 52428800) { 
        await sendMessage(botToken, chatId, `❌ **File too big!**\nFile is ${(parseInt(fileSize)/1024/1024).toFixed(2)}MB.\nLimit is 50MB.`);
        return;
    }

    // Determine filename
    const filename = fileUrl.split("/").pop().split("?")[0] || "video.mp4";

    // Step B: Construct Multipart Stream manually
    const boundary = "----CloudflareBoundary" + Math.random().toString(36).substring(2);
    
    // Headers for the multipart body
    const headerPart = `--${boundary}\r\n` +
                  `Content-Disposition: form-data; name="chat_id"\r\n\r\n` +
                  `${chatId}\r\n` +
                  `--${boundary}\r\n` +
                  `Content-Disposition: form-data; name="document"; filename="${filename}"\r\n` +
                  `Content-Type: application/octet-stream\r\n\r\n`;

    const footerPart = `\r\n--${boundary}--\r\n`;

    // Calculate total size for Content-Length header
    const totalSize = new Blob([headerPart]).size + parseInt(fileSize) + new Blob([footerPart]).size;

    // Step C: Stream Stitching
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();

    // Start background pumping
    (async () => {
        try {
            await writer.write(encoder.encode(headerPart));
            
            // Pipe the source body
            const reader = sourceResponse.body.getReader();
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                await writer.write(value);
            }
            
            await writer.write(encoder.encode(footerPart));
            await writer.close();
        } catch (err) {
            // Silently fail stream if broken (user will see timeout)
            writer.abort(err); 
        }
    })();

    // Step D: Send to Telegram
    const telegramUrl = `https://api.telegram.org/bot${botToken}/sendDocument`;
    
    const upload = await fetch(telegramUrl, {
        method: "POST",
        headers: {
            "Content-Type": `multipart/form-data; boundary=${boundary}`,
            "Content-Length": totalSize.toString()
        },
        body: readable
    });

    const result = await upload.json();
    if (!result.ok) {
        throw new Error(result.description);
    }

  } catch (error) {
    await sendMessage(botToken, chatId, `❌ **Error:** ${error.message}`);
  }
}
