/**
 * CLOUDFLARE "RELAY" LEECH BOT (Buffer Fix)
 * - Fixed "Bytes expected" error by forcing Buffer type
 * - Uploads 2GB+ files via Relay
 * - Uses Cloudflare KV (LEECH_DB)
 */

import { Api, TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import { Buffer } from "node:buffer"; // IMPORT BUFFER

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // --- ROUTE 1: TELEGRAM COMMANDS ---
    if (request.method === "POST" && !url.searchParams.has("resume")) {
      try {
        const update = await request.json();
        if (update.message && update.message.text) {
          const text = update.message.text;
          const chatId = update.message.chat.id;

          if (text.startsWith("/leech")) {
            const link = text.split(/\s+/)[1];
            if (!link) return sendMessage(env, chatId, "❌ Usage: `/leech <link>`");

            if (!env.LEECH_DB) return sendMessage(env, chatId, "❌ **Config Error:** LEECH_DB is missing.");

            await sendMessage(env, chatId, "🚀 **Job Started.** Initializing Relay...");
            
            ctx.waitUntil(runRelay(link, chatId, env, 0));
            return new Response("OK");
          }
        }
      } catch (e) {
        return new Response("Error", { status: 200 });
      }
    }

    // --- ROUTE 2: RELAY RUNNER (Internal) ---
    if (request.method === "POST" && url.searchParams.get("resume") === "true") {
      const payload = await request.json();
      ctx.waitUntil(runRelay(payload.link, payload.chatId, env, payload.nextPart));
      return new Response("Relay Picked Up");
    }

    return new Response("Bot Active");
  }
};

// --- MAIN RELAY LOGIC ---
async function runRelay(link, chatId, env, startPart) {
    let client;
    try {
        const START_TIME = Date.now();
        const MAX_RUNTIME = 80 * 1000; 

        // 1. SETUP CLIENT
        if (!env.SESSION_STRING) throw new Error("Missing SESSION_STRING variable.");
        
        const session = new StringSession(env.SESSION_STRING);
        client = new TelegramClient(session, parseInt(env.API_ID), env.API_HASH, {
            connectionRetries: 1, useWSS: true
        });
        await client.connect();

        // 2. GET STATE FROM KV
        let state = await env.LEECH_DB.get(link, { type: "json" });
        
        // Fetch Source Info
        const head = await fetch(link, { method: "HEAD", headers: {"User-Agent": "Mozilla/5.0"} });
        const totalSize = parseInt(head.headers.get("content-length") || "0");
        const supportsRange = head.headers.get("accept-ranges") === "bytes";

        if (!supportsRange && totalSize > 50*1024*1024) {
            throw new Error("Source server doesn't support resuming (Range Headers). Cannot process huge file.");
        }

        // Initialize State if new
        if (startPart === 0 || !state) {
            const fileId = BigInt(Math.floor(Math.random() * 1000000000000)).toString();
            const CHUNK_SIZE = 512 * 1024;
            const totalParts = Math.ceil(totalSize / CHUNK_SIZE);
            const filename = link.split("/").pop().split("?")[0] || "video.mp4";
            
            state = { fileId, totalParts, filename, totalSize };
            await env.LEECH_DB.put(link, JSON.stringify(state), { expirationTtl: 86400 });
            
            await sendMessage(env, chatId, `📦 **File Details:**\n\`${filename}\`\nSize: ${(totalSize/1024/1024).toFixed(2)}MB\nTotal Parts: ${totalParts}`);
        }

        // 3. CALCULATE OFFSETS
        const CHUNK_SIZE = 512 * 1024;
        const byteStart = startPart * CHUNK_SIZE;
        
        // 4. FETCH SOURCE STREAM
        const response = await fetch(link, {
            headers: { 
                "User-Agent": "Mozilla/5.0",
                "Range": `bytes=${byteStart}-` 
            }
        });

        if (!response.ok && response.status !== 206) throw new Error("Stream connection failed.");

        // 5. UPLOAD LOOP
        const reader = response.body.getReader();
        let partIdx = startPart;
        let buffer = new Uint8Array(0);

        while (true) {
            // TIME CHECK
            if (Date.now() - START_TIME > MAX_RUNTIME) {
                await triggerNextWorker(env, link, chatId, partIdx);
                const percent = (partIdx / state.totalParts) * 100;
                if (partIdx % 20 === 0) await sendMessage(env, chatId, `🔄 **Relaying...** (${percent.toFixed(1)}%)`);
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

                // --- FIX APPLIED HERE: Buffer.from() ---
                await client.invoke(new Api.upload.SaveBigFilePart({
                    fileId: BigInt(state.fileId),
                    filePart: partIdx,
                    fileTotalParts: state.totalParts,
                    bytes: Buffer.from(chunk) // WRAP IN BUFFER
                }));
                partIdx++;
            }
        }

        // Flush Buffer
        if (buffer.length > 0) {
             // --- FIX APPLIED HERE: Buffer.from() ---
             await client.invoke(new Api.upload.SaveBigFilePart({
                fileId: BigInt(state.fileId),
                filePart: partIdx,
                fileTotalParts: state.totalParts,
                bytes: Buffer.from(buffer) // WRAP IN BUFFER
            }));
        }

        // 6. FINALIZE
        await sendMessage(env, chatId, "✅ **Upload 100%!** Finalizing...");
        
        await client.invoke(new Api.messages.SendMedia({
            peer: chatId,
            media: new Api.InputMediaUploadedDocument({
                file: new Api.InputFileBig({
                    id: BigInt(state.fileId),
                    parts: state.totalParts,
                    name: state.filename
                }),
                mimeType: "video/mp4",
                attributes: [new Api.DocumentAttributeVideo({ 
                    duration: 0, w: 1280, h: 720, supportsStreaming: true 
                })]
            }),
            message: `📦 **${state.filename}**`
        }));
        
        await env.LEECH_DB.delete(link);

    } catch (e) {
        await sendMessage(env, chatId, `❌ **Error:** ${e.message}`);
        console.error(e);
    } finally {
        if (client) await client.disconnect();
    }
}

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
