import OpenAI from "openai";

function requiredEnv(name: string) {
    const v = process.env[name];
    if (!v) throw new Error(`Missing env: ${name}`);
    return v;
}

export type OrMessage = {
    role: "system" | "user" | "assistant";
    content:
    | string
    | Array<
        | { type: "text"; text: string }
        | { type: "image_url"; image_url: { url: string } }
    >;
};

export function makeOpenRouterClient() {
    const apiKey = requiredEnv("OPENROUTER_API_KEY");

    // Важно: OpenRouter OpenAI-compatible endpoint.
    // База для requests: https://openrouter.ai/api/v1
    // (это стандартный паттерн у интеграций)
    const client = new OpenAI({
        apiKey,
        baseURL: "https://openrouter.ai/api/v1",
    });

    return client;
}

export async function openrouterChat(opts: {
    model: string;
    messages: OrMessage[];
    maxTokens?: number;
}) {
    const client = makeOpenRouterClient();

    const siteUrl = process.env.OPENROUTER_SITE_URL || "http://localhost";
    const appName = process.env.OPENROUTER_APP_NAME || "Assistant";

    const resp = await client.chat.completions.create(
        {
            model: opts.model,
            messages: opts.messages as any,
            max_tokens: opts.maxTokens ?? 900,
            temperature: 0.2,
        },
        {
            headers: {
                // OpenRouter-специфичные (опционально, но норм)
                "HTTP-Referer": siteUrl,
                "X-Title": appName,
            },
        }
    );

    const text = resp.choices?.[0]?.message?.content ?? "";
    return { text };
}

export function bufferToDataUrlJpeg(buf: Buffer) {
    const b64 = buf.toString("base64");
    return `data:image/jpeg;base64,${b64}`;
}
