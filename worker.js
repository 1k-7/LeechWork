/**
 * CLOUDFLARE LEECH BOT (STABLE SPEED)
 * - CONCURRENCY: 2 (Safe for Free Tier RAM).
 * - DIAGNOSTICS: Updates status at every step to debug "Freezes".
 * - MEMORY: Optimized buffer handling to prevent crashes.
 */

import { Api, TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import { Buffer } from "node:buffer";

// CONFIGURATION: 2 is the safe limit for Free Tier
const PARALLEL_CHUNKS = 2; 

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // --- ROUTE 1: BOT SIDE ---
    if (request.method === "POST" && !url.searchParams.has("resume")) {
      try {
        const update = await request.json();

        // RELAY HANDLER
        if (update.message && (update.message.document || update.message.video || update.message.audio)) {
            const caption = update.message.caption;
            if (caption && /^-?\d+$/.test(caption)) {
                await copyMessage(env, update.message.chat.id, update.message.message_id, caption);
                return new Response("Relayed");
            }
        }

        // COMMAND HANDLER
        if (update.message && update.message.text && update.message.text.startsWith("/leech")) {
            const chatId = update.message.chat.id;
            const link = update.message.text.split(/\s+/)[1];
            if (!link) return sendMessage(env, chatId, "❌ Usage: `/leech <link>`");

            // Config Check
            if (!env.LEECH_DB) return sendMessage(env, chatId, "❌ Error: `LEECH_DB` is missing.");
            if (!env.WORKER_URL) return sendMessage(env, chatId, "❌ Error: `WORKER_URL` is missing.");

            // 1. Send Initial Message
            const statusMsg = await sendMessage(env, chatId, "⚙️ **Initializing...**");
            const msgId = statusMsg.result.message_id;

            // 2. Start Background Job
            ctx.waitUntil(runRelay(link, chatId, env, 0, msgId));
            return new Response("OK");
        }
      } catch (e) { return new Response("Error", { status: 200 }); }
    }

    // --- ROUTE 2: WORKER SIDE ---
    if (request.method === "POST" && url.searchParams.get("resume") === "true") {
      const payload = await request.json();
      ctx.waitUntil(runRelay(payload.link, payload.chatId, env, payload.nextPart, payload.msgId));
      return new Response("Active");
    }

    return new Response("Active");
  }
};

// --- CORE LOGIC ---
async function runRelay(link, chatId, env, startPart, msgId) {
    let client;
    try {
        const START_TIME = Date.now();
        const MAX_RUNTIME = 45 * 1000; 

        // STEP 1: LOGIN
        // We update the message here so you KNOW if it hangs at login
        if (startPart === 0) await editMessage(env, chatId, msgId, "🔑 **Logging in...**");
        
        const session = new StringSession(env.SESSION_STRING);
        client = new TelegramClient(session, parseInt(env.API_ID), env.API_HASH, { connectionRetries: 1, useWSS: true });
        await client.connect();

        // STEP 2: METADATA
        let state = await env.LEECH_DB.get(link, { type: "json" });
        
        if (startPart === 0 || !state) {
            await editMessage(env, chatId, msgId, "📡 **Fetching Headers...**");
            
            const head = await fetch(link, { method: "HEAD", headers: {"User-Agent": "Mozilla/5.0"} });
            if (!head.ok) throw new Error(`Source Unreachable: ${head.status}`);
            
            const totalSize = parseInt(head.headers.get("content-length") || "0");
            
            // Filename Logic
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

        // STEP 3: STREAMING
        if (startPart === 0) await editMessage(env, chatId, msgId, "⬇️ **Starting Stream...**");

        const CHUNK_SIZE = 512 * 1024;
        const byteStart = startPart * CHUNK_SIZE;

        const response = await fetch(link, { 
            headers: { "User-Agent": "Mozilla/5.0", "Range": `bytes=${byteStart}-` } 
        });

        if (!response.ok) throw new Error(`Stream Error: ${response.status}`);

        const reader = response.body.getReader();
        let partIdx = startPart;
        let buffer = new Uint8Array(0);
        let lastEditTime = Date.now();

        // STEP 4: UPLOAD LOOP
        while (true) {
            // Check Timeout
            if (Date.now() - START_TIME > MAX_RUNTIME) {
                await triggerNextWorker(env, link, chatId, partIdx, msgId);
                return;
            }

            const { done, value } = await reader.read();
            if (done && buffer.length === 0) break;
            
            if (value) {
                const temp = new Uint8Array(buffer.length + value.length);
                temp.set(buffer);
                temp.set(value, buffer.length);
                buffer = temp;
            }

            // Process chunks
            while (buffer.length >= CHUNK_SIZE || (done && buffer.length > 0)) {
                
                // Collect up to 2 chunks (Safe Parallelism)
                const uploadPromises = [];
                let loopCount = 0;

                while (loopCount < PARALLEL_CHUNKS && buffer.length > 0) {
                    const currentChunkSize = Math.min(CHUNK_SIZE, buffer.length);
                    const chunk = buffer.slice(0, currentChunkSize);
                    buffer = buffer.slice(currentChunkSize);

                    const currentPart = partIdx;
                    // Upload Promise
                    const p = client.invoke(new Api.upload.SaveBigFilePart({
                        fileId: BigInt(state.fileId),
                        filePart: currentPart,
                        fileTotalParts: state.totalParts,
                        bytes: Buffer.from(chunk)
                    }));

                    uploadPromises.push(p);
                    partIdx++;
                    loopCount++;
                    
                    if (currentChunkSize < CHUNK_SIZE) break;
                }

                // Wait for the batch
                if (uploadPromises.length > 0) await Promise.all(uploadPromises);

                // Update UI (Every 8 seconds)
                if (Date.now() - lastEditTime > 8000) {
                    await editProgress(env, chatId, msgId, state.filename, partIdx, state.totalParts, state.totalSize);
                    lastEditTime = Date.now();
                }

                if (buffer.length === 0 && done) break;
            }
            
            if (done && buffer.length === 0) break;
        }

        // STEP 5: FINISH
        await editMessage(env, chatId, msgId, "✅ **100%!** Finalizing...");

        // Auto-Detect Mime
        const ext = state.filename.split('.').pop().toLowerCase();
        let mimeType = "video/mp4";
        let attributes = [new Api.DocumentAttributeVideo({ duration: 0, w: 1280, h: 720, supportsStreaming: true })];
        let forceFile = false;

        if (['zip', 'rar', '7z', 'pdf', 'epub', 'exe', 'apk', 'bin'].includes(ext)) {
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
        // If it crashes, we UPDATE the message so you see the error
        await editMessage(env, chatId, msgId, `❌ **Error:** ${e.message}`);
    } finally {
        if (client) await client.disconnect();
    }
}

// --- VISUAL HELPERS ---
async function editProgress(env, chatId, msgId, name, current, total, size) {
    const percent = Math.min(100, (current / total) * 100);
    const filled = Math.floor(percent / 10);
    const bar = "■".repeat(filled) + "□".repeat(10 - filled);
    const uploadedMB = ((current * 512 * 1024) / 1024 / 1024).toFixed(2);
    const totalMB = (size / 1024 / 1024).toFixed(2);
    
    await editMessage(env, chatId, msgId, 
        `⚡ **Leeching...**\n📄 \`${name}\`\n📊 ${bar} **${percent.toFixed(1)}%**\n💾 ${uploadedMB}MB / ${totalMB}MB`
    );
}

async function triggerNextWorker(env, link, chatId, nextPart, msgId) {
    if (!env.WORKER_URL) return;
    for(let i=0; i<3; i++) {
        try {
            await fetch(`${env.WORKER_URL}?resume=true`, {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ link, chatId, nextPart, msgId })
            });
            break;
        } catch(e) { await new Promise(r => setTimeout(r, 1000)); }
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
