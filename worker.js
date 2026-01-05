/**
 * CLOUDFLARE LEECH BOT (FINAL STABLE)
 * - SERVICE BINDING: No 404 errors.
 * - BROWSER HEADERS: Bypasses source server blocks.
 * - DIAGNOSTICS: Shows exactly what the bot is doing.
 */

import { Api, TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import { Buffer } from "node:buffer";

const CHUNKS_PER_RUN = 10; 

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // --- INTERNAL ROUTE (Service Binding) ---
    if (url.pathname === "/relay" || url.searchParams.get("resume") === "true") {
      try {
        const payload = await request.json();
        ctx.waitUntil(runRelay(payload.link, payload.chatId, env, payload.nextPart, payload.msgId));
        return new Response("Relay Started");
      } catch (e) { return new Response("Error", { status: 500 }); }
    }

    // --- PUBLIC ROUTE ---
    if (request.method === "POST") {
      try {
        const update = await request.json();

        // HANDOFF
        if (update.message && (update.message.document || update.message.video || update.message.audio)) {
            const caption = update.message.caption;
            if (caption && /^-?\d+$/.test(caption)) {
                await copyMessage(env, update.message.chat.id, update.message.message_id, caption);
                return new Response("Relayed");
            }
        }

        // COMMANDS
        if (update.message && update.message.text) {
            const text = update.message.text;
            const chatId = update.message.chat.id;

            if (text === "/ping") return sendMessage(env, chatId, "🏓 **Pong!**\nService Binding: " + (env.SELF ? "✅ Active" : "❌ Missing"));

            if (text.startsWith("/leech")) {
                const link = text.split(/\s+/)[1];
                if (!link) return sendMessage(env, chatId, "❌ Usage: `/leech <link>`");
                if (!env.LEECH_DB) return sendMessage(env, chatId, "❌ Error: `LEECH_DB` is missing.");
                if (!env.SELF) return sendMessage(env, chatId, "❌ **Critical:** `SELF` binding missing in wrangler.toml.");

                const statusMsg = await sendMessage(env, chatId, "🔗 **Internal Relay Started...**");
                const msgId = statusMsg.result.message_id;

                ctx.waitUntil(runRelay(link, chatId, env, 0, msgId));
                return new Response("OK");
            }
        }
      } catch (e) { return new Response("Error", { status: 200 }); }
    }

    return new Response("Active");
  }
};

// --- CORE LOGIC ---
async function runRelay(link, chatId, env, startPart, msgId) {
    let client;
    try {
        const START_TIME = Date.now();
        const MAX_RUNTIME = 50 * 1000;

        // DIAGNOSTIC 1
        if (startPart === 0) await editMessage(env, chatId, msgId, "🔑 **Logging in...**");

        const session = new StringSession(env.SESSION_STRING);
        client = new TelegramClient(session, parseInt(env.API_ID), env.API_HASH, { connectionRetries: 1, useWSS: true });
        await client.connect();

        let state = await env.LEECH_DB.get(link, { type: "json" });
        
        // INIT STATE
        if (startPart === 0 || !state) {
            // DIAGNOSTIC 2
            await editMessage(env, chatId, msgId, "📡 **Fetching Headers...**");

            // HEAD REQUEST WITH BROWSER HEADERS (The Fix)
            const head = await fetch(link, { 
                method: "HEAD", 
                headers: { 
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36",
                    "Accept": "*/*",
                    "Connection": "keep-alive"
                } 
            });
            
            if (!head.ok) throw new Error(`Source HTTP ${head.status}`);
            
            const totalSize = parseInt(head.headers.get("content-length") || "0");
            
            let filename = "video.mp4";
            const disp = head.headers.get("content-disposition");
            if (disp && disp.includes("filename=")) {
                filename = disp.match(/filename=["']?([^"';]+)["']?/)[1];
            } else {
                try { filename = decodeURIComponent(new URL(link).pathname.split("/").pop()); } catch (e) {}
            }
            if (!filename.includes(".")) filename += ".mp4";

            const CHUNK_SIZE = 512 * 1024;
            const totalParts = Math.ceil(totalSize / CHUNK_SIZE);
            state = { fileId: BigInt(Math.floor(Math.random() * 1e12)).toString(), totalParts, filename, totalSize };
            await env.LEECH_DB.put(link, JSON.stringify(state), { expirationTtl: 86400 });
        }

        const CHUNK_SIZE = 512 * 1024;
        const byteStart = startPart * CHUNK_SIZE;

        // DIAGNOSTIC 3
        if (startPart === 0) await editMessage(env, chatId, msgId, "⬇️ **Starting Stream...**");
        
        // GET REQUEST WITH BROWSER HEADERS
        const response = await fetch(link, { 
            headers: { 
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36",
                "Range": `bytes=${byteStart}-`,
                "Accept": "*/*",
                "Referer": new URL(link).origin
            } 
        });

        if (!response.ok) throw new Error(`Stream HTTP ${response.status}`);

        const reader = response.body.getReader();
        let partIdx = startPart;
        let buffer = new Uint8Array(0);
        let chunksProcessed = 0;
        let streamActive = false;

        // LOOP
        while (true) {
            // Check Timeout
            if (Date.now() - START_TIME > MAX_RUNTIME) {
                await triggerNextWorker(env, link, chatId, partIdx, msgId);
                return;
            }

            // Burst Check
            if (chunksProcessed >= CHUNKS_PER_RUN) {
                const result = await triggerNextWorker(env, link, chatId, partIdx, msgId);
                if (result.ok) {
                    await editProgress(env, chatId, msgId, state.filename, partIdx, state.totalParts, state.totalSize);
                } else {
                    await editMessage(env, chatId, msgId, `❌ **Relay Failed:** ${result.error}`);
                }
                return; 
            }

            const { done, value } = await reader.read();
            
            // DIAGNOSTIC 4: Confirm we actually got data
            if (!streamActive && value) {
                streamActive = true;
                if (startPart === 0) await editMessage(env, chatId, msgId, "🚀 **Stream Active! Uploading...**");
            }

            if (done && buffer.length === 0) break;
            
            if (value) {
                const temp = new Uint8Array(buffer.length + value.length);
                temp.set(buffer);
                temp.set(value, buffer.length);
                buffer = temp;
            }

            while (buffer.length >= CHUNK_SIZE || (done && buffer.length > 0)) {
                const currentChunkSize = Math.min(CHUNK_SIZE, buffer.length);
                const chunk = buffer.slice(0, currentChunkSize);
                buffer = buffer.slice(currentChunkSize);

                await client.invoke(new Api.upload.SaveBigFilePart({
                    fileId: BigInt(state.fileId),
                    filePart: partIdx,
                    fileTotalParts: state.totalParts,
                    bytes: Buffer.from(chunk)
                }));

                partIdx++;
                chunksProcessed++;
                if (buffer.length === 0 && done) break;
            }
            if (done && buffer.length === 0) break;
        }

        // --- FINISH ---
        await editMessage(env, chatId, msgId, "✅ **100%!** Sending...");

        const ext = state.filename.split('.').pop().toLowerCase();
        let mimeType = "video/mp4";
        let attributes = [new Api.DocumentAttributeVideo({ duration: 0, w: 1280, h: 720, supportsStreaming: true })];
        let forceFile = false;

        if (['zip', 'rar', '7z', 'pdf', 'epub'].includes(ext)) {
            mimeType = "application/octet-stream";
            attributes = [new Api.DocumentAttributeFilename({ fileName: state.filename })];
            forceFile = true;
        }

        const me = await (await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/getMe`)).json();
        const botEntity = await client.getEntity(me.result.username);

        await client.invoke(new Api.messages.SendMedia({
            peer: botEntity,
            media: new Api.InputMediaUploadedDocument({
                file: new Api.InputFileBig({ id: BigInt(state.fileId), parts: state.totalParts, name: state.filename }),
                mimeType: mimeType,
                attributes: attributes,
                forceFile: forceFile
            }),
            message: chatId.toString()
        }));

        await env.LEECH_DB.delete(link);

    } catch (e) {
        await editMessage(env, chatId, msgId, `❌ **Error:** ${e.message}`);
    } finally {
        if (client) await client.disconnect();
    }
}

// --- HELPERS ---
async function editProgress(env, chatId, msgId, name, current, total, size) {
    const percent = Math.min(100, (current / total) * 100);
    const uploadedMB = ((current * 512 * 1024) / 1024 / 1024).toFixed(2);
    const totalMB = (size / 1024 / 1024).toFixed(2);
    
    await editMessage(env, chatId, msgId, 
        `🔗 **Internal Relay...**\n📄 \`${name}\`\n📊 **${percent.toFixed(1)}%**\n💾 ${uploadedMB}MB / ${totalMB}MB`
    );
}

// --- TRIGGER USING SERVICE BINDING ---
async function triggerNextWorker(env, link, chatId, nextPart, msgId) {
    if (!env.SELF) return { ok: false, error: "SELF binding missing" };
    
    try {
        const response = await env.SELF.fetch("http://internal/relay", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ link, chatId, nextPart, msgId })
        });
        
        if (!response.ok) {
            return { ok: false, error: `Internal Error ${response.status}` };
        }
        return { ok: true };
        
    } catch(e) {
        return { ok: false, error: e.message };
    }
}

async function sendMessage(env, chatId, text) {
  const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: text, parse_mode: "Markdown" })
  });
  return await res.json();
}

async function editMessage(env, chatId, msgId, text) {
  await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/editMessageText`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, message_id: msgId, text: text, parse_mode: "Markdown" })
  });
}

async function copyMessage(env, fromChat, msgId, toChat) {
    await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/copyMessage`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: toChat, from_chat_id: fromChat, message_id: msgId, caption: "" })
    });
}
