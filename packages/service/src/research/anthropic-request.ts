import { SUMMARISER_MODELS, type SummariserModel } from "@ccc/domain";
import { z } from "zod";
import { SummariserError } from "./summariser-error.js";

/**
 * The summariser's request to the Anthropic Messages API (D-04, OD-1, ADR-0014, RSRCH-07).
 *
 * The body is built from a strict schema with exactly five keys. There is no key through which a
 * tool, a tool choice, an MCP server, a container, a beta, a fallback or any server tool could be
 * expressed: server tools and the MCP connector are enabled only by declaring `tools` or
 * `mcp_servers`, and this type cannot say either. A caller cannot add one either, because the
 * body is rebuilt from the four named inputs and parsed by the strict schema before it is sent.
 *
 * One user message only: assistant prefill returns a 400 on both models.
 *
 * Thinking is a per-model value (claude-api skill, Thinking and Effort table): Haiku 5.5 accepts
 * `disabled`; Sonnet 5.5 rejects `disabled` and turns thinking off with `between_tools` and no
 * other field. Opus 5.5 is not in the enum because its thinking cannot be disabled, so its
 * responses would carry thinking blocks that the text-only parser must reject. Whether the live
 * API accepts these values is assumption A1, checked only by the owner's live run.
 */

export const MIN_TOKENS_LIMIT = 1024;
export const MAX_TOKENS_LIMIT = 16_000;
export const DEFAULT_MAX_TOKENS = 8192;
export const SYSTEM_MAX_CHARS = 8000;
export const USER_CONTENT_MAX_CHARS = 400_000;

export type ThinkingValue = { readonly type: "disabled" } | { readonly type: "between_tools" };

export const THINKING_BY_MODEL: Readonly<Record<SummariserModel, ThinkingValue>> = {
  "claude-haiku-5-5": { type: "disabled" },
  "claude-sonnet-5-5": { type: "between_tools" },
};

const ThinkingSchema = z.union([
  z.strictObject({ type: z.literal("disabled") }),
  z.strictObject({ type: z.literal("between_tools") }),
]);

export const AnthropicRequestSchema = z
  .strictObject({
    model: z.enum(SUMMARISER_MODELS),
    max_tokens: z.number().int().min(MIN_TOKENS_LIMIT).max(MAX_TOKENS_LIMIT),
    system: z.string().min(1).max(SYSTEM_MAX_CHARS),
    messages: z.tuple([
      z.strictObject({
        role: z.literal("user"),
        content: z.string().min(1).max(USER_CONTENT_MAX_CHARS),
      }),
    ]),
    thinking: ThinkingSchema,
  })
  .refine((request) => request.thinking.type === THINKING_BY_MODEL[request.model].type, {
    message: "thinking does not match the model",
  });

export type AnthropicRequest = z.infer<typeof AnthropicRequestSchema>;

export interface BuildAnthropicRequestInput {
  readonly model: SummariserModel;
  readonly instructions: string;
  readonly input: string;
  readonly maxTokens?: number;
}

/**
 * Builds the body from the four named inputs and parses it with the strict schema. Anything else on
 * the input object is ignored, an out-of-range value throws a code-only SummariserError, and the
 * returned object is the schema's own output (a fresh object with the five keys).
 */
export function buildAnthropicRequest(input: BuildAnthropicRequestInput): AnthropicRequest {
  const model = input.model;
  const thinking = Object.hasOwn(THINKING_BY_MODEL, model) ? THINKING_BY_MODEL[model] : undefined;
  const parsed = AnthropicRequestSchema.safeParse({
    model,
    max_tokens: input.maxTokens ?? DEFAULT_MAX_TOKENS,
    system: input.instructions,
    messages: [{ role: "user", content: input.input }],
    thinking: thinking === undefined ? undefined : { ...thinking },
  });
  if (!parsed.success) throw new SummariserError("summariser-failed");
  return parsed.data;
}

/**
 * Turns a parsed Messages API reply into its text. Accepts only a normal end of turn whose content
 * is a non-empty array of text blocks; every other shape is a closed failure.
 */
export function parseAnthropicResponse(value: unknown): string {
  if (typeof value !== "object" || value === null) {
    throw new SummariserError("summariser-invalid-output");
  }
  const message = value as { stop_reason?: unknown; content?: unknown };
  if (message.stop_reason !== "end_turn" || !Array.isArray(message.content)) {
    throw new SummariserError("summariser-invalid-output");
  }
  const blocks: unknown[] = message.content;
  if (blocks.length === 0) throw new SummariserError("summariser-invalid-output");
  let text = "";
  for (const block of blocks) {
    const candidate = block as { type?: unknown; text?: unknown } | null;
    if (candidate === null || typeof candidate !== "object" || candidate.type !== "text") {
      throw new SummariserError("summariser-invalid-output");
    }
    if (typeof candidate.text !== "string" || candidate.text.length === 0) {
      throw new SummariserError("summariser-invalid-output");
    }
    text += candidate.text;
  }
  return text;
}
