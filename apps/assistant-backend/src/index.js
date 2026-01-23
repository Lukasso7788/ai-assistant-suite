import "dotenv/config";
import express from "express";
import cors from "cors";
import multer from "multer";

import { bufferToDataUrlJpeg, openrouterChat } from "./openrouter.js";

const app = express();

const PORT = Number(process.env.PORT || 3001);
const CORS_ORIGIN = process.env.CORS_ORIGIN || "http://localhost:5173";

app.use(
    cors({
        origin: CORS_ORIGIN,
        credentials: false,
    })
);

const upload = multer({ storage: multer.memoryStorage() });

app.get("/health", (_req, res) => {
    res.json({
        ok: true,
        provider: "openrouter",
        textModel: process.env.OPENROUTER_TEXT_MODEL,
        visionModel: process.env.OPENROUTER_VISION_MODEL,
    });
});

/**
 * Frontend шлет multipart/form-data:
 * - text
 * - explainMode
 * - lastFrame (file)
 * - clipFrames (files[])
 * - attachments (files[])
 */
app.post(
    "/api/assistant/send",
    upload.fields([
        { name: "lastFrame", maxCount: 1 },
        { name: "clipFrames", maxCount: 60 },
        { name: "attachments", maxCount: 20 },
    ]),
    async (req, res) => {
        try {
            const text = String(req.body?.text ?? "");
            const explainMode = String(req.body?.explainMode ?? "false") === "true";

            // multer: req.files is an object: { fieldName: [file, ...], ... }
            const files =
                req.files && typeof req.files === "object" ? req.files : {};

            const lastFrame = files.lastFrame?.[0];
            const clipFrames = files.clipFrames ?? [];
            const attachments = files.attachments ?? [];

            const system = explainMode
                ? "You are a helpful assistant. Explain step-by-step with clear numbered steps. Keep it practical."
                : "You are a helpful assistant. Be concise and practical.";

            // Если есть хоть одна картинка — используем vision
            const hasVision = Boolean(lastFrame) || clipFrames.length > 0;

            const model = hasVision
                ? process.env.OPENROUTER_VISION_MODEL || "qwen/qwen2.5-vl-32b-instruct"
                : process.env.OPENROUTER_TEXT_MODEL || "deepseek/deepseek-chat";

            // ✅ Debug logs (очень полезно сейчас)
            console.log("[/api/assistant/send]", {
                textLen: text.length,
                explainMode,
                hasVision,
                gotLastFrame: Boolean(lastFrame),
                clipFrames: clipFrames.length,
                attachments: attachments.length,
                usedModel: model,
            });

            // Собираем user content:
            // - текст
            // - lastFrame (как data URL)
            // - пару кадров из клипа (чтобы не улететь в токены/лимиты)
            const userContent = [];

            if (text.trim()) userContent.push({ type: "text", text });

            if (hasVision) {
                // lastFrame — основной
                if (lastFrame?.buffer) {
                    userContent.push({
                        type: "image_url",
                        image_url: { url: bufferToDataUrlJpeg(lastFrame.buffer) },
                    });
                }

                // clipFrames — берем максимум 3 кадра (MVP)
                const pick = clipFrames.slice(0, 3);
                for (const f of pick) {
                    if (f?.buffer) {
                        userContent.push({
                            type: "image_url",
                            image_url: { url: bufferToDataUrlJpeg(f.buffer) },
                        });
                    }
                }

                // Если текста нет — добавим явную задачу
                if (!text.trim()) {
                    userContent.push({
                        type: "text",
                        text:
                            "Analyze the screenshot(s). Describe what you see and what the user should do next.",
                    });
                }
            }

            const { text: assistantText } = await openrouterChat({
                model,
                messages: [
                    { role: "system", content: system },
                    {
                        role: "user",
                        content: hasVision ? userContent : (text || "Help me."),
                    },
                ],
                maxTokens: 900,
            });

            res.json({
                assistantText: assistantText || "(empty response)",
                debug: {
                    usedModel: model,
                    hasVision,
                    gotLastFrame: Boolean(lastFrame),
                    clipFrames: clipFrames.length,
                    attachments: attachments.length,
                    explainMode,
                    textLen: text.length,
                },
            });
        } catch (err) {
            console.error(err);
            res.status(500).json({
                assistantText: "❌ Backend error",
                error: String(err?.message || err),
            });
        }
    }
);

app.listen(PORT, () => {
    console.log(`[assistant-backend] listening on http://localhost:${PORT}`);
    console.log(`[assistant-backend] CORS_ORIGIN=${CORS_ORIGIN}`);
});
