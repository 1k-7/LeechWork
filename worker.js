/**
 * CLOUDFLARE LEECH BOT (Visual Edition)
 * - Dynamic Triangle Strategy (Userbot -> Bot -> User)
 * - LIVE PROGRESS BAR [■■■□□□□□□□]
 * - Fixed Filename & Size display
 */

import { Api, TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import { Buffer } from "node:buffer";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // --- ROUTE 1: BOT SIDE (Receives File / Commands) ---
    if (request.method === "POST" && !url.searchParams.has("resume")) {
      try {
        const update = await request.json();

        // A. HANDOFF (Userbot -> Bot)
        if (update.message && (update.message.document || update.message.video)) {
            const caption = update.message.caption;
            // Detect User ID in caption
            if (caption && /^-?\d+$/.test(caption)) {
                await copyMessage(env, update.message.chat.id, update.message.message_id, caption);
                return new Response("Relayed");
            }
        }

        // B. COMMANDS
        if (update.message && update.message.text && update.message.text.startsWith("/leech")) {
            const chatId = update.message.chat.id;
            const link = update.message.text.split(/\s+/)[1];
            if (!link) return sendMessage(env, chatId, "❌ Usage: `/leech <link>`");

            if (!env.LEECH_DB || !env.WORKER_URL) return sendMessage(env, chatId, "❌ Config Error: Missing DB or WORKER_URL.");

            // Send initial status message
            const statusMsg = await sendMessage(env, chatId, "🔄 **Analyzing Link...**");
            const msgId = statusMsg.result.message_id;

            // Start Relay with Message ID (so we can edit it)
            ctx.waitUntil(runRelay(link, chatId, env, 0, msgId));
            return new Response("OK");
        }
      } catch (e) { return new Response("Error", { status: 200 }); }
    }

    // --- ROUTE 2: USERBOT SIDE (Relay) ---
    if (request.method === "POST" && url.searchParams.get("resume") === "true") {
      const payload = await request.json();
      ctx.waitUntil(runRelay(payload.link, payload.chatId, env, payload.nextPart, payload.msgId));
      return new Response("Relay Picked Up");
    }

    return new Response("Active");
  }
};

// --- CORE LOGIC ---
async function runRelay(link, chatId, env, startPart, msgId) {
    let client;
    try {
        const START_TIME = Date.now();
        const MAX_RUNTIME = 50 * 1000; // 50s cycle for frequent updates

        // 1. SETUP
        const session = new StringSession(env.SESSION_STRING);
        client = new TelegramClient(session, parseInt(env.API_ID), env.API_HASH, { connectionRetries: 1, useWSS: true });
        await client.connect();

        // 2. STATE & METADATA
        let state = await env.LEECH_DB.get(link, { type: "json" });
        
        // If first run, get file info
        if (startPart === 0 || !state) {
            const head = await fetch(link, { method: "HEAD", headers: {"User-Agent": "Mozilla/5.0"} });
            const totalSize = parseInt(head.headers.get("content-length") || "0");
            
            // Better Filename Extraction
            let filename = "video.mp4";
            const disp = head.headers.get("content-disposition");
            if (disp && disp.includes("filename=")) {
                filename = disp.match(/filename=["']?([^"';]+)["']?/)[1];
            } else {
                filename = link.split("/").pop().split("?")[0] || "video.mp4";
            }
            
            const CHUNK_SIZE = 512 * 1024;
            const totalParts = Math.ceil(totalSize / CHUNK_SIZE);
            state = { fileId: BigInt(Math.floor(Math.random() * 1e12)).toString(), totalParts, filename, totalSize };
            
            await env.LEECH_DB.put(link, JSON.stringify(state), { expirationTtl: 86400 });
        }

        // 3. DOWNLOAD STREAM
        const CHUNK_SIZE = 512 * 1024;
        const response = await fetch(link, { headers: { "User-Agent": "Mozilla/5.0", "Range": `bytes=${startPart * CHUNK_SIZE}-` } });
        if (!response.ok) throw new Error(`Stream Error: ${response.status}`);

        const reader = response.body.getReader();
        let partIdx = startPart;
        let buffer = new Uint8Array(0);
        let lastEditTime = Date.now();

        // 4. UPLOAD LOOP
        while (true) {
            // A. RELAY CHECK (Timeout)
            if (Date.now() - START_TIME > MAX_RUNTIME) {
                await triggerNextWorker(env, link, chatId, partIdx, msgId);
                return; // Die peacefully
            }

            const { done, value } = await reader.read();
            if (done) break;

            const newBuffer = new Uint8Array(buffer.length + value.length);
            newBuffer.set(buffer);
            newBuffer.set(value, buffer.length);
            buffer = newBuffer;

            while (buffer.length >= CHUNK_SIZE) {
                const chunk = buffer.slice(0, CHUNK_SIZE);
                buffer = buffer.slice(CHUNK_SIZE);

                await client.invoke(new Api.upload.SaveBigFilePart({
                    fileId: BigInt(state.fileId),
                    filePart: partIdx,
                    fileTotalParts: state.totalParts,
                    bytes: Buffer.from(chunk)
                }));
                partIdx++;

                // B. PROGRESS UPDATE (Every 10 parts OR 10 seconds)
                if (partIdx % 10 === 0 || Date.now() - lastEditTime > 10000) {
                    await editProgress(env, chatId, msgId, state.filename, partIdx, state.totalParts, state.totalSize);
                    lastEditTime = Date.now();
                }
            }
        }

        // Flush Buffer
        if (buffer.length > 0) {
             await client.invoke(new Api.upload.SaveBigFilePart({
                fileId: BigInt(state.fileId),
                filePart: partIdx,
                fileTotalParts: state.totalParts,
                bytes: Buffer.from(buffer)
            }));
        }

        // 5. FINISH
        await editMessage(env, chatId, msgId, "✅ **Upload 100%!** Handing off...");
        
        // Auto-Detect Bot Username
        const me = await (await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/getMe`)).json();
        const botUser = me.result.username;
        const botEntity = await client.getEntity(botUser);

        // Send to Bot (User ID in caption)
        await client.invoke(new Api.messages.SendMedia({
            peer: botEntity,
            media: new Api.InputMediaUploadedDocument({
                file: new Api.InputFileBig({ id: BigInt(state.fileId), parts: state.totalParts, name: state.filename }),
                mimeType: "video/mp4",
                attributes: [new Api.DocumentAttributeVideo({ duration: 0, w: 1280, h: 720, supportsStreaming: true })]
            }),
            message: chatId.toString()
        }));
        
        await env.LEECH_DB.delete(link);

    } catch (e) {
        await sendMessage(env, chatId, `❌ **Error:** ${e.message}`);
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
    
    const text = `🚀 **Leeching...**\n` +
                 `📄 \`${name}\`\n` +
                 `📊 ${bar} **${percent.toFixed(1)}%**\n` +
                 `💾 ${uploadedMB}MB / ${totalMB}MB\n` +
                 `🧩 Part: ${current}/${total}`;
                 
    await editMessage(env, chatId, msgId, text);
}

async function triggerNextWorker(env, link, chatId, nextPart, msgId) {
    if (!env.WORKER_URL) return;
    fetch(`${env.WORKER_URL}?resume=true`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ link, chatId, nextPart, msgId })
    }).catch(e => {});
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
