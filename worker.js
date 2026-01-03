/**
 * CLOUDFLARE SERVERLESS LEECH BOT (Ultimate Version)
 * Limits: 50MB Max File Size | ~100s Time Limit
 */

export default {
  async fetch(request, env, ctx) {
    // Only accept POST from Telegram
    if (request.method === "POST") {
      try {
        const update = await request.json();

        if (update.message && update.message.text) {
          const text = update.message.text;
          const chatId = update.message.chat.id;

          // --- COMMAND: /start ---
          if (text === "/start") {
             await sendMessage(env.BOT_TOKEN, chatId, 
               "👋 **Leech Bot Ready!**\n\n" +
               "I can stream direct links to Telegram.\n" +
               "**Limit:** 50MB per file.\n\n" +
               "**Usage:**\n`/leech http://example.com/video.mp4`"
             );
             return new Response("OK");
          }

          // --- COMMAND: /leech ---
          if (text.startsWith("/leech")) {
            const url = text.split(/\s+/)[1]; 

            if (!url) {
              await sendMessage(env.BOT_TOKEN, chatId, "❌ **Usage:** `/leech <link>`");
              return new Response("OK");
            }

            // Ack command
            await sendMessage(env.BOT_TOKEN, chatId, "⏳ **Checking link...**");

            // Run background process
            ctx.waitUntil(processLeech(url, chatId, env.BOT_TOKEN));

            return new Response("OK");
          }
        }
      } catch (e) {
        return new Response("JSON Error", { status: 200 });
      }
    }
    return new Response("Bot is active.");
  }
};

// --- CORE FUNCTIONS ---

async function sendMessage(token, chatId, text) {
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: text, parse_mode: "Markdown" })
  });
}

async function processLeech(fileUrl, chatId, botToken) {
  try {
    // 1. Fetch Source with User Agent (bypasses some blocks)
    let sourceResponse = await fetch(fileUrl, {
        headers: { 
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36" 
        }
    });
    
    if (!sourceResponse.ok) throw new Error(`HTTP Error ${sourceResponse.status}`);

    // 2. Determine File Size (Critical for Telegram)
    let fileSize = sourceResponse.headers.get("content-length");
    let streamToUpload = sourceResponse.body;

    // FALLBACK: If no size header, buffer in RAM (Risk: Crashes on large files)
    if (!fileSize) {
        try {
            // We have to consume the stream to measure it
            const blob = await sourceResponse.blob();
            fileSize = blob.size;
            streamToUpload = blob.stream(); // Create new stream from blob
        } catch (e) {
            throw new Error("Source server didn't provide size, and file is too big to buffer.");
        }
    }

    // Check Limits
    const sizeInt = parseInt(fileSize);
    if (sizeInt > 52428800) { // 50MB
        throw new Error(`File is ${(sizeInt/1024/1024).toFixed(2)}MB. Limit is 50MB.`);
    }

    // 3. Smart Filename Logic
    let filename = "downloaded_file";
    const disposition = sourceResponse.headers.get("content-disposition");
    
    if (disposition && disposition.includes("filename=")) {
        const match = disposition.match(/filename=["']?([^"';]+)["']?/);
        if (match && match[1]) filename = match[1];
    } else {
        // Try from URL
        try {
            const urlPath = new URL(fileUrl).pathname;
            const urlName = urlPath.split("/").pop();
            if (urlName) filename = urlName;
        } catch(e) {}
    }

    // Fix Extension if missing
    if (!filename.includes(".")) {
        const cType = sourceResponse.headers.get("content-type") || "";
        if (cType.includes("video/mp4")) filename += ".mp4";
        else if (cType.includes("matroska")) filename += ".mkv";
        else if (cType.includes("jpeg")) filename += ".jpg";
        else if (cType.includes("png")) filename += ".png";
        else if (cType.includes("pdf")) filename += ".pdf";
        else filename += ".bin";
    }

    // Update Status
    await sendMessage(botToken, chatId, `⬇️ **Downloading:** \`${filename}\`\n📦 **Size:** ${(sizeInt/1024/1024).toFixed(2)}MB`);

    // 4. Construct Multipart Stream
    const boundary = "----CloudflareBoundary" + Math.random().toString(36).substring(2);
    
    const header = `--${boundary}\r\n` +
                   `Content-Disposition: form-data; name="chat_id"\r\n\r\n` +
                   `${chatId}\r\n` +
                   `--${boundary}\r\n` +
                   `Content-Disposition: form-data; name="document"; filename="${filename}"\r\n` +
                   `Content-Type: application/octet-stream\r\n\r\n`;

    const footer = `\r\n--${boundary}--\r\n`;
    const totalSize = new Blob([header]).size + sizeInt + new Blob([footer]).size;

    // 5. Pipe Data
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();

    (async () => {
        try {
            await writer.write(encoder.encode(header));
            const reader = streamToUpload.getReader();
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                await writer.write(value);
            }
            await writer.write(encoder.encode(footer));
            await writer.close();
        } catch (err) {
            writer.abort(err);
        }
    })();

    // 6. Send to Telegram
    const upload = await fetch(`https://api.telegram.org/bot${botToken}/sendDocument`, {
        method: "POST",
        headers: {
            "Content-Type": `multipart/form-data; boundary=${boundary}`,
            "Content-Length": totalSize.toString()
        },
        body: readable
    });

    const result = await upload.json();
    if (!result.ok) throw new Error(result.description);

  } catch (error) {
    await sendMessage(botToken, chatId, `❌ **Error:** ${error.message}`);
  }
}
