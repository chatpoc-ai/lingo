import type { Config } from "./config.ts";

/**
 * Any OpenAI-compatible chat endpoint: OpenAI itself, OpenRouter, a local server (Ollama, vLLM,
 * LM Studio), or a gateway of your own where `model` names a purpose. One call, text back.
 */

export interface Message {
  role: "system" | "user" | "assistant";
  content: string;
}
export type Chat = (model: string, messages: Message[]) => Promise<string>;

export function openAiChat(llm: Config["llm"], f: typeof fetch = fetch): Chat {
  return async (model, messages) => {
    const body: Record<string, unknown> = { model, messages };
    if (llm.responseFormat === "json_object") body.response_format = { type: "json_object" };
    if (llm.responseFormat === "json_schema")
      body.response_format = { type: "json_schema", json_schema: { name: "translations", strict: true, schema: { type: "object", properties: { translations: { type: "array", items: { type: "string" } } }, required: ["translations"], additionalProperties: false } } };
    const res = await f(`${llm.url}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(llm.key ? { authorization: `Bearer ${llm.key}` } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(llm.timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`model ${model}: HTTP ${res.status} ${text.slice(0, 300)}`);
    const json = JSON.parse(text) as { choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }> };
    const content = json.choices?.[0]?.message?.content;
    const out = Array.isArray(content) ? content.map((c) => c.text ?? "").join("") : (content ?? "");
    if (!out.trim()) throw new Error(`model ${model}: empty answer`);
    return out;
  };
}

/** The first JSON object in a reply (models wrap it in prose or fences now and then). */
export function jsonIn<T>(text: string): T {
  const start = text.indexOf("{"), end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error(`no JSON in the answer: ${text.slice(0, 200)}`);
  return JSON.parse(text.slice(start, end + 1)) as T;
}
