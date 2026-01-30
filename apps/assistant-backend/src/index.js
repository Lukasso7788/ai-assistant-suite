import "dotenv/config";
import express from "express";
import cors from "cors";
import multer from "multer";
import { openrouterChat, bufferToDataUrlJpeg } from "./openrouter.js";

const app = express();
const PORT = Number(process.env.PORT || 3001);

const CORS_ORIGIN = process.env.CORS_ORIGIN || "http://localhost:5173";
const HTTP_RESPONSE_TIMEOUT_MS = Number(process.env.HTTP_RESPONSE_TIMEOUT_MS || 70000);

// Debug timings switch (set DEBUG_TIMINGS=1)
const DEBUG_TIMINGS =
    String(process.env.DEBUG_TIMINGS || "").toLowerCase() === "1" ||
    String(process.env.DEBUG_TIMINGS || "").toLowerCase() === "true";

// multer in-memory
const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 8 * 1024 * 1024, // 8MB per file
        files: 30,
    },
});

app.use(
    cors({
        origin: CORS_ORIGIN,
        credentials: false,
    })
);

app.get("/health", (req, res) => {
    res.json({
        ok: true,
        provider: "openrouter",
        textModel: process.env.OPENROUTER_TEXT_MODEL,
        visionModel: process.env.OPENROUTER_VISION_MODEL,
        debugTimings: DEBUG_TIMINGS,
    });
});

function nowNs() {
    return process.hrtime.bigint();
}
function nsToMs(ns) {
    return Number(ns / 1000000n);
}
function safeLen(s) {
    try {
        return (s || "").length || 0;
    } catch {
        return 0;
    }
}

// Build a W3C Server-Timing header
function makeServerTiming(t) {
    // only include finite numbers
    const parts = Object.entries(t)
        .filter(([, v]) => Number.isFinite(v))
        .map(([k, v]) => `${k};dur=${Math.max(0, Math.round(v))}`);
    return parts.join(", ");
}

app.post(
    "/api/assistant/send",
    upload.fields([
        { name: "lastFrame", maxCount: 1 },
        { name: "clipFrames", maxCount: 20 },
        { name: "attachments", maxCount: 20 },
    ]),
    async (req, res) => {
        const t0 = nowNs();
        const startedMs = Date.now();
        const requestId = `${startedMs}-${Math.random().toString(16).slice(2)}`;

        res.setHeader("X-Request-Id", requestId);
        res.setHeader("Cache-Control", "no-store");
        res.setTimeout(HTTP_RESPONSE_TIMEOUT_MS);

        // If client disconnects, we can at least stop extra work before calling provider.
        let clientAborted = false;
        req.on("aborted", () => {
            clientAborted = true;
            if (DEBUG_TIMINGS) console.warn(`[${requestId}] client aborted request`);
        });
        req.on("close", () => {
            // close can happen after response too; keep it informational only
            if (DEBUG_TIMINGS && !res.headersSent) console.warn(`[${requestId}] connection closed before response sent`);
        });

        const timings = {
            total: 0,
            parse: 0,
            build_parts: 0,
            b64_images: 0,
            openrouter: 0,
            respond: 0,
        };

        try {
            const tParse0 = nowNs();

            const text = (req.body?.text || "").toString();
            const explainMode = String(req.body?.explainMode || "false") === "true";

            const files = req.files || {};
            const lastFrame = files?.lastFrame?.[0] || null;
            const clipFrames = files?.clipFrames || [];
            const attachments = files?.attachments || [];

            const hasVision = Boolean(lastFrame) || (Array.isArray(clipFrames) && clipFrames.length > 0);

            const model = hasVision ? process.env.OPENROUTER_VISION_MODEL : process.env.OPENROUTER_TEXT_MODEL;
            if (!model) throw new Error("Model is not configured (OPENROUTER_TEXT_MODEL / OPENROUTER_VISION_MODEL)");

            timings.parse = nsToMs(nowNs() - tParse0);

            console.log(
                `[${requestId}] /send start textLen=${text.length} hasVision=${hasVision} clip=${clipFrames.length} att=${attachments.length} model=${model}`
            );

            // Build prompt/messages
            const tBuild0 = nowNs();

            // Small latency win: encourage brief answers unless explicitly asked
            // (often reduces generation time, especially for “hi” / short prompts).
            const fastHint = explainMode
                ? "Explain step-by-step, but keep it concise and practical."
                : "Be concise and practical. Prefer short answers unless the user asks for depth.";

            const system = `You are a helpful assistant. ${fastHint}`;

            const userParts = [];

            if (text) userParts.push({ type: "text", text });

            // include filenames (optional)
            if (attachments.length) {
                const names = attachments.map((f) => f?.originalname).filter(Boolean).slice(0, 20);
                if (names.length) {
                    userParts.push({
                        type: "text",
                        text: `Attached files: ${names.join(", ")}`,
                    });
                }
            }

            timings.build_parts = nsToMs(nowNs() - tBuild0);

            // Encode images as data URLs (can be expensive)
            const tB640 = nowNs();

            // lastFrame
            if (lastFrame?.buffer) {
                const url = bufferToDataUrlJpeg(lastFrame.buffer);
                userParts.push({ type: "image_url", image_url: { url } });
            }

            // limit clip frames to not burn tokens
            const clipLimit = Number(process.env.CLIP_FRAMES_LIMIT || 3);
            const clipUsed = clipFrames.slice(0, clipLimit);

            for (const f of clipUsed) {
                if (!f?.buffer) continue;
                const url = bufferToDataUrlJpeg(f.buffer);
                userParts.push({ type: "image_url", image_url: { url } });
            }

            timings.b64_images = nsToMs(nowNs() - tB640);

            const messages = [
                { role: "system", content: system },
                { role: "user", content: userParts.length ? userParts : [{ type: "text", text: "(no input)" }] },
            ];

            // Dynamic maxTokens: for tiny text-only prompts, cap output smaller (often reduces latency)
            const configuredMax = Number(process.env.OPENROUTER_MAX_TOKENS || 700);
            const dynamicMaxTokens =
                !hasVision && text.trim().length > 0 && text.trim().length < 80 ? Math.min(configuredMax, 280) : configuredMax;

            if (clientAborted) {
                // Don’t waste provider call if the client already bailed.
                if (DEBUG_TIMINGS) console.warn(`[${requestId}] skipped provider call (client aborted)`);
                return;
            }

            // Provider call timing (this is the big one for your “8–10s” symptom)
            const tProv0 = nowNs();

            const assistantText = await openrouterChat({
                model,
                messages,
                maxTokens: dynamicMaxTokens,
                timeoutMs: Number(process.env.OPENROUTER_HTTP_TIMEOUT_MS || 60000),

                // NOTE: openrouterChat currently ignores unknown keys (safe),
                // but we keep it here so you can add support in openrouter.js later.
                debugTimings: DEBUG_TIMINGS,
                requestId,
            });

            timings.openrouter = nsToMs(nowNs() - tProv0);

            // Respond + final logs
            const tResp0 = nowNs();

            timings.total = nsToMs(nowNs() - t0);

            // Expose timings in browser DevTools (Network → Timing)
            res.setHeader(
                "Server-Timing",
                makeServerTiming({
                    parse: timings.parse,
                    build: timings.build_parts,
                    b64: timings.b64_images,
                    llm: timings.openrouter,
                    total: timings.total,
                })
            );

            console.log(
                `[${requestId}] /send done total=${timings.total}ms llm=${timings.openrouter}ms b64=${timings.b64_images}ms chars=${safeLen(
                    assistantText
                )} maxTokens=${dynamicMaxTokens}`
            );

            if (DEBUG_TIMINGS) {
                console.log(`[${requestId}] timings`, timings);
            }

            timings.respond = nsToMs(nowNs() - tResp0);

            res.json({
                assistantText: assistantText || "(empty response)",
                debug: {
                    requestId,
                    usedModel: model,
                    hasVision,
                    gotLastFrame: Boolean(lastFrame),
                    clipFrames: clipFrames.length,
                    clipUsed: clipUsed.length,
                    explainMode,
                    textLen: text.length,
                    maxTokens: dynamicMaxTokens,
                    ms: timings.total,
                    timings,
                },
            });
        } catch (err) {
            timings.total = nsToMs(nowNs() - t0);

            // still publish server-timing on errors
            res.setHeader(
                "Server-Timing",
                makeServerTiming({
                    parse: timings.parse,
                    build: timings.build_parts,
                    b64: timings.b64_images,
                    llm: timings.openrouter,
                    total: timings.total,
                })
            );

            console.error(`[${requestId}] /send ERROR total=${timings.total}ms`, err);

            const msg = err?.message ? String(err.message) : String(err);
            const status = msg.toLowerCase().includes("timeout") ? 504 : 500;

            res.status(status).json({
                assistantText: "",
                error: msg,
                debug: {
                    requestId,
                    ms: timings.total,
                    timings,
                },
            });
        }
    }
);

app.listen(PORT, "0.0.0.0", () => {
    console.log(`assistant-backend listening on http://localhost:${PORT}`);
    console.log(`CORS_ORIGIN=${CORS_ORIGIN}`);
    console.log(`DEBUG_TIMINGS=${DEBUG_TIMINGS ? "1" : "0"}`);
});
