import OpenAI from "openai";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { MODEL, need } from "./env.js";

let _client: OpenAI | undefined;
const client = () =>
  (_client ??= new OpenAI({
    baseURL: "https://openrouter.ai/api/v1",
    apiKey: need("OPENROUTER_API_KEY", "Get one at https://openrouter.ai/keys"),
    defaultHeaders: { "HTTP-Referer": "https://github.com/nolandruid/notething", "X-Title": "NoteThing" },
  }));

/** A user-message content part: text, image (data URL) or a file (PDF as a data URL, parsed by OpenRouter). */
export type Block =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
  | { type: "file"; file: { filename: string; file_data: string } };

const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif",
};
export const isImage = (f: string) => path.extname(f).toLowerCase() in IMAGE_TYPES;

/** Turn a local file into a content block: PDFs as file parts (handwriting is read visually), images as image_url parts. */
export function fileBlock(file: string): Block {
  const ext = path.extname(file).toLowerCase();
  const data = fs.readFileSync(file);
  if (ext === ".pdf") return { type: "file", file: { filename: path.basename(file), file_data: `data:application/pdf;base64,${data.toString("base64")}` } };
  if (IMAGE_TYPES[ext]) return { type: "image_url", image_url: { url: `data:${IMAGE_TYPES[ext]};base64,${data.toString("base64")}` } };
  return { type: "text", text: `<file name="${path.basename(file)}">\n${data.toString("utf8")}\n</file>` };
}

type Opts = { system?: string; model?: string; maxTokens?: number; effort?: "low" | "medium" | "high" };

/** One streamed chat completion via OpenRouter. Returns the text, or throws with the finish reason. */
async function complete(body: Record<string, unknown>): Promise<string> {
  const stream = (await client().chat.completions.create({ ...body, stream: true } as never)) as unknown as AsyncIterable<OpenAI.Chat.ChatCompletionChunk>;
  let text = "";
  let finish: string | null | undefined;
  for await (const chunk of stream) {
    const err = (chunk as { error?: { message?: string } }).error;
    if (err) throw new Error(err.message ?? "OpenRouter stream error");
    const c = chunk.choices?.[0];
    text += c?.delta?.content ?? "";
    if (c?.finish_reason) finish = c.finish_reason;
  }
  if (finish === "length") throw new Error("Model ran out of output tokens; try a smaller file or raise maxTokens");
  if (finish === "content_filter") throw new Error("Model declined this request (content filter)");
  if (!text.trim()) throw new Error("Model returned an empty response");
  return text;
}

/** Pull a JSON object out of a reply that may be wrapped in code fences or prose. */
function extractJSON(text: string): unknown {
  const t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try { return JSON.parse(t); } catch { /* fall through */ }
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  return JSON.parse(t.slice(a, b + 1));
}

/**
 * One structured-output call. Tries strict json_schema first; if the model/provider rejects it, falls back to
 * "JSON only" prompting with zod validation and one retry. PDFs use the model's native file support, falling
 * back to OpenRouter's mistral-ocr engine (scans, or models without native file input).
 */
export async function askJSON<S extends z.ZodType>(schema: S, content: Block[], opts: Opts = {}): Promise<z.infer<S>> {
  const hasPdf = content.some((b) => b.type === "file");
  const jsonSchema = z.toJSONSchema(schema) as Record<string, unknown>;
  delete jsonSchema.$schema;
  const base = {
    model: opts.model ?? MODEL,
    max_tokens: opts.maxTokens ?? 32000,
    ...(opts.effort ? { reasoning: { effort: opts.effort } } : {}),
  };
  const messages = (extra = "") => [
    ...(opts.system ? [{ role: "system", content: opts.system }] : []),
    { role: "user", content: extra ? [...content, { type: "text", text: extra }] : content },
  ];
  const engines = hasPdf ? (["native", "mistral-ocr"] as const) : ([undefined] as const);

  let lastErr: unknown;
  for (const engine of engines) {
    const plugins = engine ? { plugins: [{ id: "file-parser", pdf: { engine } }] } : {};
    try {
      // 1) strict structured output
      try {
        const text = await complete({
          ...base, ...plugins, messages: messages(),
          response_format: { type: "json_schema", json_schema: { name: "result", strict: true, schema: jsonSchema } },
        });
        return schema.parse(extractJSON(text));
      } catch (e) {
        if (e instanceof Error && /tokens|declined/.test(e.message)) throw e;
        lastErr = e;
      }
      // 2) JSON-only prompting + zod validation, one retry
      const ask = `Respond with ONLY a JSON object (no prose, no code fences) matching this JSON Schema:\n${JSON.stringify(jsonSchema)}`;
      let note = "";
      for (let attempt = 0; attempt < 2; attempt++) {
        const text = await complete({ ...base, ...plugins, messages: messages(ask + note) });
        try {
          return schema.parse(extractJSON(text));
        } catch (e) {
          lastErr = e;
          note = `\n\nYour previous reply was invalid (${e instanceof Error ? e.message.slice(0, 500) : "bad JSON"}). Reply again with valid JSON only.`;
        }
      }
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`Model call failed: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
}
