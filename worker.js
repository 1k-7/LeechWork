/**
 * HYBRID LEECH BOT (Final Debug Version)
 * - Reports exact errors if GitHub fails to trigger.
 * - Handles Cobalt resolution for social links.
 */

export default {
  async fetch(request, env, ctx) {
    if (request.method === "POST") {
      try {
        const update = await request.json();
        if (update.message && update.message.text) {
          const text = update.message.text;
          const chatId = update.message.chat.id;

          if (text === "/start") {
             await sendMessage(env.BOT_TOKEN, chatId, 
               "👋 **Hybrid Leech Bot**\n\n" +
               "🔹 **< 50MB:** Instant Cloudflare Upload\n" +
               "🔹 **> 50MB:** Auto-offload to GitHub\n\n" +
               "**Usage:** `/leech <link>`"
             );
             return new Response("OK");
          }

          if (text.startsWith("/leech")) {
            const url = text.split(/\s+/)[1];
            if (!url) {
              await sendMessage(env.BOT_TOKEN, chatId, "❌ **Usage:** `/leech <url>`");
              return new Response("OK");
            }

            await sendMessage(env.BOT_TOKEN, chatId, "🔍 **Analyzing...**");
            ctx.waitUntil(handleRequest(url, chatId, env));
            return new Response("OK");
          }
        }
      } catch (e) {
        return new Response("Error", { status: 200 });
      }
    }
    return new Response("Bot Active");
  }
};

async function handleRequest(userUrl, chatId, env) {
    try {
        let finalUrl = userUrl;
        let filename = "download";
        
        // 1. Resolve Social Media
        const isSocial = /youtube|youtu\.be|tiktok|instagram|twitter|x\.com|twitch/.test(userUrl);
        if (isSocial) {
            await sendMessage(env.BOT_TOKEN, chatId, "⚙️ **Resolving via Cobalt...**");
            const cobalt = await resolveCobalt(userUrl);
            if (!cobalt) {
                if (env.GITHUB_TOKEN) {
                     await sendMessage(env.BOT_TOKEN, chatId, "⚠️ Cobalt failed. Trying GitHub directly...");
                     await triggerGitHub(userUrl, chatId, env);
                     return;
                }
                throw new Error("Link not supported by Cobalt.");
            }
            finalUrl = cobalt.url;
            if (cobalt.filename) filename = cobalt.filename;
        }

        // 2. Check File Size
        let size = 0;
        try {
            const head = await fetch(finalUrl, { method: "HEAD", headers: {"User-Agent": "Mozilla/5.0"} });
            if (head.ok) size = parseInt(head.headers.get("content-length") || "0");
        } catch (e) {}

        // 3. Decision
        if (size > 52428800) { 
            if (env.GITHUB_TOKEN) {
                await sendMessage(env.BOT_TOKEN, chatId, `📦 **File is ${(size/1024/1024).toFixed(2)}MB** (>50MB).\n🚀 sending signal to GitHub...`);
                await triggerGitHub(userUrl, chatId, env);
            } else {
                throw new Error("File too big (>50MB) and no GITHUB_TOKEN configured.");
            }
        } else {
            await streamToTelegram(finalUrl, chatId, env.BOT_TOKEN, filename);
        }

    } catch (error) {
        await sendMessage(env.BOT_TOKEN, chatId, `❌ **Error:** ${error.message}`);
    }
}

// --- DEBUG TRIGGER GITHUB ---
async function triggerGitHub(url, chatId, env) {
    if (!env.GITHUB_TOKEN || !env.GITHUB_REPO) {
        throw new Error("Missing GITHUB_TOKEN or GITHUB_REPO in Settings.");
    }
    
    // Log the attempt to Telegram
    const repo = env.GITHUB_REPO;
    
    const res = await fetch(`https://api.github.com/repos/${repo}/dispatches`, {
        method: "POST",
        headers: {
            "Authorization": `token ${env.GITHUB_TOKEN}`,
            "Accept": "application/vnd.github.v3+json",
            "User-Agent": "Cloudflare-Worker"
        },
        body: JSON.stringify({ event_type: "big_leech", client_payload: { url: url, chat_id: chatId } })
    });

    if (!res.ok) {
        const err = await res.text();
        await sendMessage(env.BOT_TOKEN, chatId, `❌ **GitHub Refused!**\nStatus: ${res.status}\nReason: ${err}\n\n*Check your GITHUB_REPO and GITHUB_TOKEN settings.*`);
    } else {
        await sendMessage(env.BOT_TOKEN, chatId, "✅ **Signal Sent!**\nWaiting for GitHub to wake up (10-30s)...");
    }
}

// --- STANDARD HELPERS ---
async function streamToTelegram(fileUrl, chatId, botToken, suggestedName) {
    try {
        const source = await fetch(fileUrl, { headers: {"User-Agent": "Mozilla/5.0"} });
        if (!source.ok) throw new Error("Source URL unreachable");
        
        let fileSize = parseInt(source.headers.get("content-length") || "0");
        let stream = source.body;
        if (!fileSize) {
             const blob = await source.blob();
             fileSize = blob.size;
             stream = blob.stream();
        }

        let filename = suggestedName;
        const disp = source.headers.get("content-disposition");
        if (disp && disp.includes("filename=")) filename = disp.match(/filename=["']?([^"';]+)["']?/)[1];
        if (!filename.includes(".")) filename += ".mp4";

        await sendMessage(botToken, chatId, `⬇️ **Streaming:** \`${filename}\``);

        const boundary = "----Cloudflare" + Math.random().toString(36).slice(2);
        const header = `--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}\r\n` +
                       `--${boundary}\r\nContent-Disposition: form-data; name="document"; filename="${filename}"\r\n` +
                       `Content-Type: application/octet-stream\r\n\r\n`;
        const footer = `\r\n--${boundary}--\r\n`;
        
        const { readable, writable } = new TransformStream();
        const writer = writable.getWriter();
        const enc = new TextEncoder();
        
        (async () => {
            await writer.write(enc.encode(header));
            const reader = stream.getReader();
            while (true) { const {done, value} = await reader.read(); if(done) break; await writer.write(value); }
            await writer.write(enc.encode(footer));
            await writer.close();
        })();

        const res = await fetch(`https://api.telegram.org/bot${botToken}/sendDocument`, {
            method: "POST", 
            headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` }, 
            body: readable
        });
        if (!res.ok) throw new Error("Telegram Rejected Upload");

    } catch (e) {
        throw e;
    }
}

async function resolveCobalt(url) {
    const instances = ["https://api.cobalt.tools/api/json", "https://co.wuk.sh/api/json", "https://api.wkr.tools/api/json"];
    for (const api of instances) {
        try {
            const res = await fetch(api, {
                method: "POST",
                headers: {"Accept": "application/json", "Content-Type": "application/json"},
                body: JSON.stringify({ url: url, downloadMode: "auto" })
            });
            const data = await res.json();
            if (data.url) return data;
        } catch (e) {}
    }
    return null;
}

async function sendMessage(token, chatId, text) {
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: text, parse_mode: "Markdown" })
  });
}
