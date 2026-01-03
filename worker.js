/**
 * CLOUDFLARE WORKER LEECH BOT (Ultimate + yt-dlp Support)
 * Supports: Direct Links AND YouTube/TikTok/Insta (via Cobalt API)
 * Limit: 50MB (Telegram API Hard Limit)
 */

export default {
  async fetch(request, env, ctx) {
    if (request.method === "POST") {
      try {
        const update = await request.json();

        if (update.message && update.message.text) {
          const text = update.message.text;
          const chatId = update.message.chat.id;

          // --- COMMAND: /start ---
          if (text === "/start") {
             await sendMessage(env.BOT_TOKEN, chatId, 
               "👋 **I am evolved!**\n\n" +
               "I can leech Direct Links AND Social Media (YouTube, TikTok, Insta).\n" +
               "**Limit:** 50MB per file.\n\n" +
               "**Usage:**\n`/leech <any_url>`"
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

            // Acknowledge
            await sendMessage(env.BOT_TOKEN, chatId, "🔍 **Analyzing Link...**");

            // Trigger Background Process
            ctx.waitUntil(handleDownload(url, chatId, env.BOT_TOKEN));

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

// --- CORE LOGIC ---

async function handleDownload(userUrl, chatId, botToken) {
    try {
        let finalUrl = userUrl;
        let filename = "download";

        // 1. CHECK IF NEEDS YT-DLP (Social Media)
        // Simple regex for common sites that need processing
        const needsYtdlp = /youtube\.com|youtu\.be|tiktok\.com|instagram\.com|twitter\.com|x\.com|twitch\.tv/.test(userUrl);

        if (needsYtdlp) {
            await sendMessage(botToken, chatId, "⚙️ **Processing with yt-dlp...**\n(This relies on external APIs, might take a moment)");
            
            // Call Cobalt API to get a direct link
            const cobaltData = await resolveCobalt(userUrl);
            
            if (!cobaltData || !cobaltData.url) {
                throw new Error("Could not extract video. The link might be unsupported or too long.");
            }

            finalUrl = cobaltData.url;
            // Try to use the filename the API gave us, if any
            if (cobaltData.filename) filename = cobaltData.filename;
            
            console.log("Resolved URL:", finalUrl);
        }

        // 2. START STREAMING
        await processLeech(finalUrl, chatId, botToken, filename);

    } catch (error) {
        await sendMessage(botToken, chatId, `❌ **Error:** ${error.message}`);
    }
}

// Helper: Resolve URL using Cobalt API (Free yt-dlp wrapper)
async function resolveCobalt(url) {
    const apiInstances = [
        "https://api.cobalt.tools/api/json", // Official
        "https://co.wuk.sh/api/json",        // Backup 1
        "https://cobalt.steamys.me/api/json" // Backup 2
    ];

    // Try instances until one works
    for (const api of apiInstances) {
        try {
            const response = await fetch(api, {
                method: "POST",
                headers: { 
                    "Accept": "application/json",
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    url: url,
                    vQuality: "720", // Request 720p to stay under 50MB
                    filenamePattern: "basic"
                })
            });
            
            const data = await response.json();
            if (data.url) return data;
        } catch (e) {
            console.log(`Failed Cobalt instance ${api}:`, e);
            continue; // Try next instance
        }
    }
    return null;
}

// Helper: Send Message
async function sendMessage(token, chatId, text) {
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: text, parse_mode: "Markdown" })
  });
}

// Helper: The Heavy Lifter (Streamer)
async function processLeech(fileUrl, chatId, botToken, suggestedName) {
  try {
    // A. Fetch Source
    let sourceResponse = await fetch(fileUrl, {
        headers: { 
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36" 
        }
    });
    
    if (!sourceResponse.ok) throw new Error(`HTTP Source Error ${sourceResponse.status}`);

    // B. Get Size
    let fileSize = sourceResponse.headers.get("content-length");
    let streamToUpload = sourceResponse.body;

    // Fallback if no size (Buffer RAM)
    if (!fileSize) {
        try {
            const blob = await sourceResponse.blob();
            fileSize = blob.size;
            streamToUpload = blob.stream();
        } catch (e) {
            throw new Error("Source provided no size, and buffering failed.");
        }
    }

    const sizeInt = parseInt(fileSize);
    if (sizeInt > 52428800) { // 50MB Limit
        throw new Error(`File is ${(sizeInt/1024/1024).toFixed(2)}MB. Telegram Limit is 50MB.`);
    }

    // C. Determine Filename
    let filename = suggestedName;
    const disposition = sourceResponse.headers.get("content-disposition");
    
    // Priority 1: Header from Source
    if (disposition && disposition.includes("filename=")) {
        const match = disposition.match(/filename=["']?([^"';]+)["']?/);
        if (match && match[1]) filename = match[1];
    } 
    // Priority 2: URL Name (if suggestedName is generic)
    else if (filename === "download") {
        try {
            const urlPath = new URL(fileUrl).pathname;
            const urlName = urlPath.split("/").pop();
            if (urlName) filename = urlName;
        } catch(e) {}
    }

    // Ensure extension
    if (!filename.includes(".")) {
        const cType = sourceResponse.headers.get("content-type") || "";
        if (cType.includes("video")) filename += ".mp4";
        else if (cType.includes("image")) filename += ".jpg";
        else filename += ".bin";
    }

    await sendMessage(botToken, chatId, `⬇️ **Downloading:** \`${filename}\`\n📦 **Size:** ${(sizeInt/1024/1024).toFixed(2)}MB`);

    // D. Build Stream (Multipart)
    const boundary = "----CloudflareBoundary" + Math.random().toString(36).substring(2);
    const header = `--${boundary}\r\n` +
                   `Content-Disposition: form-data; name="chat_id"\r\n\r\n` +
                   `${chatId}\r\n` +
                   `--${boundary}\r\n` +
                   `Content-Disposition: form-data; name="document"; filename="${filename}"\r\n` +
                   `Content-Type: application/octet-stream\r\n\r\n`;
    const footer = `\r\n--${boundary}--\r\n`;
    const totalSize = new Blob([header]).size + sizeInt + new Blob([footer]).size;

    // E. Pipe Data
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

    // F. Send to Telegram
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
    await sendMessage(botToken, chatId, `❌ **Upload Failed:** ${error.message}`);
  }
}
