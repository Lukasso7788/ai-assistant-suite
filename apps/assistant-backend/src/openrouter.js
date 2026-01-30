import { Buffer } from "node:buffer";

export function bufferToDataUrlJpeg(buffer) {
    const b64 = Buffer.from(buffer).toString("base64");
    return `data:image/jpeg;base64,${b64}`;
}

function normalizeContentToText(content) {
    if (content == null) return "";
    if (typeof content === "string") return content;

    // иногда приходит как массив частей
    if (Array.isArray(content)) {
        return content
            .map((p) => {
                if (!p) return "";
                if (typeof p === "string") return p;
                if (typeof p?.text === "string") return p.text;
                return "";
            })
            .filter(Boolean)
            .join("\n");
    }

    if (typeof content?.text === "string") return content.text;
    return String(content);
}

export async function openrouterChat({
    model,
    messages,
    maxTokens = 800,
    timeoutMs = Number(process.env.OPENROUTER_HTTP_TIMEOUT_MS || 60000),
}) {
    const key = process.env.OPENROUTER_API_KEY;
    if (!key) throw new Error("OPENROUTER_API_KEY is missing");

    // Node 18+ has global fetch; you are on Node 22 so OK.
    if (typeof fetch !== "function") {
        throw new Error(
            "Global fetch is not available. Upgrade Node to 18+ or install undici and import fetch from it."
        );
    }

    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);

    const headers = {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        "HTTP-Referer": process.env.OPENROUTER_REFERER || "http://localhost",
        "X-Title": process.env.OPENROUTER_APP_TITLE || "AI Assistant Suite",
    };

    const body = {
        model,
        messages,
        max_tokens: maxTokens,
        stream: false,
        temperature: 0.2,
    };

    let resp;
    try {
        resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
            method: "POST",
            headers,
            body: JSON.stringify(body),
            signal: controller.signal,
        });
    } catch (e) {
        if (e?.name === "AbortError") {
            throw new Error(`OpenRouter timeout after ${timeoutMs}ms`);
        }
        throw e;
    } finally {
        clearTimeout(t);
    }

    const raw = await resp.text().catch(() => "");
    if (!resp.ok) {
        throw new Error(`OpenRouter HTTP ${resp.status}: ${raw.slice(0, 800)}`);
    }

    let json;
    try {
        json = raw ? JSON.parse(raw) : null;
    } catch {
        throw new Error(`OpenRouter bad JSON: ${raw.slice(0, 800)}`);
    }

    const content = json?.choices?.[0]?.message?.content;
    return normalizeContentToText(content);
}
