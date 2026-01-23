import OpenAI from "openai";

function requiredEnv(name) {
    const v = process.env[name];
    if (!v) throw new Error(`Missing env: ${name}`);
    return v;
}

export function makeOpenRouterClient() {
    const apiKey = requiredEnv("OPENROUTER_API_KEY");

    // OpenRouter OpenAI-compatible endpoint:
    // https://openrouter.ai/api/v1
    return new OpenAI({
        apiKey,
        baseURL: "https://openrouter.ai/api/v1",
    });
}

export async function openrouterChat({ model, messages, maxTokens = 900 }) {
    const client = makeOpenRouterClient();

    const siteUrl = process.env.OPENROUTER_SITE_URL || "http://localhost";
    const appName = process.env.OPENROUTER_APP_NAME || "Assistant";

    const resp = await client.chat.completions.create(
        {
            model,
            messages,
            max_tokens: maxTokens,
            temperature: 0.2
        },
        {
            headers: {
                // optional but recommended for OpenRouter
                "HTTP-Referer": siteUrl,
                "X-Title": appName
            }
        }
    );

    const text = resp.choices?.[0]?.message?.content ?? "";
    return { text };
}

export function bufferToDataUrlJpeg(buf) {
    const b64 = buf.toString("base64");
    return `data:image/jpeg;base64,${b64}`;
}
