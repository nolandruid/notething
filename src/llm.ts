import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import fs from "node:fs";
import path from "node:path";
import type { z } from "zod";
import { MODEL, need } from "./env.js";

let _client: Anthropic | undefined;
const client = () => (_client ??= new Anthropic({ apiKey: need("ANTHROPIC_API_KEY", "Get one at https://console.anthropic.com") }));

export type Block = Anthropic.Beta.BetaContentBlockParam;

const IMAGE_TYPES: Record<string, "image/png" | "image/jpeg" | "image/webp" | "image/gif"> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif",
};
export const isImage = (f: string) => path.extname(f).toLowerCase() in IMAGE_TYPES;

/** Turn a local file into a Claude content block: PDFs as documents (vision reads handwriting), images as images. */
export function fileBlock(file: string): Block {
  const ext = path.extname(file).toLowerCase();
  const data = fs.readFileSync(file);
  if (ext === ".pdf") return { type: "document", title: path.basename(file), source: { type: "base64", media_type: "application/pdf", data: data.toString("base64") } };
  if (IMAGE_TYPES[ext]) return { type: "image", source: { type: "base64", media_type: IMAGE_TYPES[ext], data: data.toString("base64") } };
  return { type: "text", text: `<file name="${path.basename(file)}">\n${data.toString("utf8")}\n</file>` };
}

// Models that support server-side refusal fallbacks ("default" routing).
const FALLBACK_MODELS = /^claude-(sonnet-5-5|opus-5|opus-5-5|fable-5-1)$/;

/** One structured-output call to Claude. Streams (long notes), returns the zod-validated object. */
export async function askJSON<S extends z.ZodType>(
  schema: S,
  content: Block[],
  opts: { system?: string; model?: string; maxTokens?: number; effort?: "low" | "medium" | "high" } = {},
): Promise<z.infer<S>> {
  const model = opts.model ?? MODEL;
  const useFallback = FALLBACK_MODELS.test(model);
  const stream = client().beta.messages.stream({
    model,
    max_tokens: opts.maxTokens ?? 32000,
    system: opts.system,
    messages: [{ role: "user", content }],
    output_config: { format: betaZodOutputFormat(schema), ...(opts.effort ? { effort: opts.effort } : {}) },
    ...(useFallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
  });
  const msg = await stream.finalMessage();
  if (msg.stop_reason === "refusal") throw new Error(`Claude declined this request (${msg.stop_details?.category ?? "no category"})`);
  if (msg.stop_reason === "max_tokens") throw new Error("Claude ran out of output tokens; try a smaller file or raise maxTokens");
  if (msg.parsed_output == null) throw new Error("Claude returned output that didn't match the schema");
  return msg.parsed_output as z.infer<S>;
}
