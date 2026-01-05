/**
 * CLOUDFLARE LEECH BOT (Dynamic Triangle)
 * 1. Userbot uploads file.
 * 2. Userbot AUTO-FETCHES Bot Username -> Sends file to Bot.
 * 3. Bot copies file to User.
 * - NO BOT_USERNAME variable needed.
 * - Solves "Entity Not Found" & "Bytes/Buffer" errors.
 */

import { Api, TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import { Buffer } from "node:buffer"; 

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // --- ROUTE 1: TELEGRAM WEBHOOK (The "Bot" Side) ---
    if (request.method === "POST" && !url.searchParams.has("resume")) {
      try {
        const update = await request.json();
        
        // A. THE HANDOFF (Bot receives file from Userbot)
        if (update.message && (update.message.document || update.message.video)) {
            const caption = update.message.caption;
            // If caption is a Chat ID (numbers), it means "Send this to user"
            if (caption && /^-?\d+$/.test(caption)) {
                const targetChatId = caption;
                const msgId = update.message.message_id;
                const fromChatId = update.message.chat.id;

                // Copy the file to the user (Clean delivery)
                await copyMessage(env, fromChatId, msgId, targetChatId);
                return new Response("Relayed");
            }
        }

        // B. USER COMMANDS (/leech)
        if (update.message && update.message.text) {
          const text = update.message.text;
          const chatId = update.message.chat.id;

          if (text.startsWith("/leech")) {
            const link = text.split(/\s+/)[1];
            if (!link) return sendMessage(env, chatId, "❌ Usage: `/leech <link>`");

            // Config Checks
            if (!env.LEECH_DB) return sendMessage(env, chatId, "❌ **Config Error:** `LEECH_DB` is missing.");
            if (!env.WORKER_URL) return sendMessage(env, chatId, "❌ **Config Error:** `WORKER_URL` is missing.");

            await sendMessage(env, chatId, "🚀 **Job Started.** Initializing...");
            
            ctx.waitUntil(runRelay(link, chatId, env, 0));
            return new Response("OK");
          }
        }
      } catch (e) {
        return new Response("Error", { status: 200 });
      }
    }

    // --- ROUTE 2: RELAY RUNNER (The "Userbot" Side) ---
    if (request.method === "POST" && url.searchParams.get("resume") === "true") {
      const payload = await request.json();
      ctx.waitUntil(runRelay(payload.link, payload.chatId, env, payload.nextPart));
      return new Response("Relay Picked Up");
    }

    return new Response("Bot Active");
  }
};

// --- MAIN LOGIC ---
async function runRelay(link, chatId, env, startPart) {
    let client;
    try {
        const START_TIME = Date.now();
        const MAX_RUNTIME = 60 * 1000; // 60s Safety Cutoff

        // 1. SETUP USERBOT
        const session = new StringSession(env.SESSION_STRING);
        client = new TelegramClient(session, parseInt(env.API_ID), env.API_HASH, {
            connectionRetries: 1, useWSS: true
        });
        await client.connect();

        // 2. STATE MANAGEMENT
        let state = await env.LEECH_DB.get(link, { type: "json" });
        
        // Fetch Source Info
        const head = await fetch(link, { method: "HEAD", headers: {"User-Agent": "Mozilla/5.0"} });
        const totalSize = parseInt(head.headers.get("content-length") || "0");
        const supportsRange = head.headers.get("accept-ranges") === "bytes";

        if (!supportsRange && totalSize > 50*1024*1024) throw new Error("Source server doesn't support resuming.");

        if (startPart === 0 || !state) {
            const fileId = BigInt(Math.floor(Math.random() * 1000000000000)).toString();
            const CHUNK_SIZE = 512 * 1024;
            const totalParts = Math.ceil(totalSize / CHUNK_SIZE);
            const filename = link.split("/").pop().split("?")[0] || "video.mp4";
            
            state = { fileId, totalParts, filename, totalSize };
            await env.LEECH_DB.put(link, JSON.stringify(state), { expirationTtl: 86400 });
            
            await sendMessage(env, chatId, `📦 **File:** \`${filename}\`\n🔢 **Parts:** ${totalParts}`);
        }

        // 3. STREAM & UPLOAD
        const CHUNK_SIZE = 512 * 1024;
        const byteStart = startPart * CHUNK_SIZE;
        
        const response = await fetch(link, {
            headers: { "User-Agent": "Mozilla/5.0", "Range": `bytes=${byteStart}-` }
        });

        if (!response.ok && response.status !== 206) throw new Error("Stream Connection Failed");

        const reader = response.body.getReader();
        let partIdx = startPart;
        let buffer = new Uint8Array(0);

        while (true) {
            // RELAY CHECK
            if (Date.now() - START_TIME > MAX_RUNTIME) {
                await triggerNextWorker(env, link, chatId, partIdx);
                // Only log every 10% to avoid flooding
                if (partIdx % Math.max(1, Math.floor(state.totalParts / 10)) === 0) {
                     await sendMessage(env, chatId, `🔄 **Relaying...** ${(partIdx/state.totalParts*100).toFixed(0)}%`);
                }
                return;
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
                    bytes: Buffer.from(chunk) // Buffer Fix
                }));
                partIdx++;
            }
        }

        if (buffer.length > 0) {
             await client.invoke(new Api.upload.SaveBigFilePart({
                fileId: BigInt(state.fileId),
                filePart: partIdx,
                fileTotalParts: state.totalParts,
                bytes: Buffer.from(buffer)
            }));
        }

        // 4. FINALIZE: AUTO-DETECT BOT & SEND
        await sendMessage(env, chatId, "✅ **Upload Done!** Forwarding to you...");
        
        // A. Who is the Bot? (Auto-Fetch)
        const meRes = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/getMe`);
        const meData = await meRes.json();
        const botUsername = meData.result.username; // Automatically retrieved

        // B. Send file to the Bot
        const botEntity = await client.getEntity(botUsername);
        
        await client.invoke(new Api.messages.SendMedia({
            peer: botEntity,
            media: new Api.InputMediaUploadedDocument({
                file: new Api.InputFileBig({
                    id: BigInt(state.fileId),
                    parts: state.totalParts,
                    name: state.filename
                }),
                mimeType: "video/mp4",
                attributes: [new Api.DocumentAttributeVideo({ duration: 0, w: 1280, h: 720, supportsStreaming: true })]
            }),
            message: chatId.toString() // PASS THE USER ID IN CAPTION
        }));
        
        await env.LEECH_DB.delete(link);

    } catch (e) {
        await sendMessage(env, chatId, `❌ **Error:** ${e.message}`);
        console.error(e);
    } finally {
        if (client) await client.disconnect();
    }
}

// --- HELPERS ---

async function triggerNextWorker(env, link, chatId, nextPart) {
    if (!env.WORKER_URL) return;
    fetch(`${env.WORKER_URL}?resume=true`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ link, chatId, nextPart })
    }).catch(e => console.log("Spawn failed", e));
}

async function sendMessage(env, chatId, text) {
  await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: text, parse_mode: "Markdown" })
  });
}

async function copyMessage(env, fromChatId, messageId, targetChatId) {
    // Copies the message from Userbot DM -> User Chat
    await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/copyMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            chat_id: targetChatId,
            from_chat_id: fromChatId,
            message_id: messageId,
            caption: "" // Remove the ID caption
        })
    });
}
