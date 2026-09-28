/**
 * A seeded generator of synthetic Claude Code transcript JSONL lines, shaped
 * like the key/shape scan in RESEARCH Q8 (assistant and user records, the
 * four usage counters plus the extra usage keys, one message id spread over
 * several lines, subagent-file and `<synthetic>` variants). Every string is
 * synthetic; no real transcript is ever read or copied (PRIV-04).
 *
 * Content fields carry {@link CONTENT_SENTINEL} so a test can prove the
 * parser never lets message content out.
 */

/** The fixed default seed: the same seed yields the same transcript on every machine. */
export const DEFAULT_TRANSCRIPT_SEED = 20260930;

/** Planted in every content field; no parser output may contain it. */
export const CONTENT_SENTINEL = "CCC-TRANSCRIPT-SENTINEL";

/** mulberry32: a tiny seeded PRNG (the generator test-fixtures' synthetic notes use). */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALPHANUMERIC = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

function token(next: () => number, length: number): string {
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += ALPHANUMERIC[Math.floor(next() * ALPHANUMERIC.length)] ?? "A";
  }
  return out;
}

export interface Usage {
  readonly input: number;
  readonly output: number;
  readonly cacheWrite: number;
  readonly cacheRead: number;
}

export interface AssistantLineOptions {
  readonly messageId: string;
  readonly sessionId?: string;
  readonly version?: string;
  readonly model?: string;
  readonly timestamp?: string;
  readonly usage?: Usage;
  /** A subagent file's record: `isSidechain` plus an `agentId`. */
  readonly subagent?: boolean;
  readonly requestId?: string | null;
}

export const SYNTHETIC_SESSION_ID = "dddddddd-0000-4000-8000-000000000004";
export const SYNTHETIC_VERSION = "2.1.283";
export const SYNTHETIC_MODEL = "claude-opus-4-8";

/** One assistant record line, as Claude Code writes it (without the trailing newline). */
export function assistantLine(options: AssistantLineOptions): string {
  const usage = options.usage ?? { input: 3, output: 120, cacheWrite: 400, cacheRead: 20_000 };
  const requestId = options.requestId === undefined ? "req_synthetic0001" : options.requestId;
  return JSON.stringify({
    parentUuid: "00000000-0000-4000-8000-00000000aaaa",
    isSidechain: options.subagent === true,
    ...(options.subagent === true ? { agentId: "a1b2c3d4" } : {}),
    userType: "external",
    cwd: "/Users/USERNAME/code/synthetic-project",
    sessionId: options.sessionId ?? SYNTHETIC_SESSION_ID,
    version: options.version ?? SYNTHETIC_VERSION,
    gitBranch: "main",
    message: {
      id: options.messageId,
      type: "message",
      role: "assistant",
      model: options.model ?? SYNTHETIC_MODEL,
      content: [{ type: "text", text: `${CONTENT_SENTINEL} assistant words é` }],
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: usage.input,
        cache_creation_input_tokens: usage.cacheWrite,
        cache_read_input_tokens: usage.cacheRead,
        cache_creation: {
          ephemeral_5m_input_tokens: usage.cacheWrite,
          ephemeral_1h_input_tokens: 0,
        },
        output_tokens: usage.output,
        service_tier: "standard",
        inference_geo: "not_available",
      },
    },
    ...(requestId === null ? {} : { requestId }),
    type: "assistant",
    uuid: "00000000-0000-4000-8000-00000000bbbb",
    timestamp: options.timestamp ?? "2026-09-28T12:00:00.000Z",
  });
}

/** One user record line. */
export function userLine(sessionId = SYNTHETIC_SESSION_ID, version = SYNTHETIC_VERSION): string {
  return JSON.stringify({
    parentUuid: null,
    isSidechain: false,
    userType: "external",
    cwd: "/Users/USERNAME/code/synthetic-project",
    sessionId,
    version,
    type: "user",
    message: { role: "user", content: `${CONTENT_SENTINEL} a synthetic prompt` },
    uuid: "00000000-0000-4000-8000-00000000cccc",
    timestamp: "2026-09-28T12:00:00.000Z",
  });
}

/** A `<synthetic>` API-error record: zero usage and no requestId (PR-11). */
export function syntheticModelLine(messageId: string, version = SYNTHETIC_VERSION): string {
  return JSON.stringify({
    ...JSON.parse(
      assistantLine({
        messageId,
        version,
        model: "<synthetic>",
        usage: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
        requestId: null,
      }),
    ),
    isApiErrorMessage: true,
  });
}

export interface SyntheticTranscript {
  /** Every line, newline-terminated, concatenated. */
  readonly text: string;
  readonly lines: readonly string[];
  /** How many assistant lines were written (each is a recognized record). */
  readonly assistantLines: number;
}

export interface SyntheticTranscriptOptions {
  readonly seed?: number;
  /** Distinct assistant messages to write. */
  readonly messages?: number;
  readonly version?: string;
  readonly subagent?: boolean;
}

/**
 * A seeded transcript: assistant messages each spread over 1-4 lines (the
 * same message id and usage on each, as Claude Code writes content blocks),
 * a user record between turns, and one `<synthetic>` record.
 */
export function generateSyntheticTranscript(
  options: SyntheticTranscriptOptions = {},
): SyntheticTranscript {
  const next = mulberry32(options.seed ?? DEFAULT_TRANSCRIPT_SEED);
  const lines: string[] = [];
  let assistantLines = 0;
  const messages = options.messages ?? 12;
  for (let m = 0; m < messages; m += 1) {
    lines.push(userLine(SYNTHETIC_SESSION_ID, options.version));
    const messageId = `msg_${token(next, 24)}`;
    const usage = {
      input: Math.floor(next() * 50),
      output: Math.floor(next() * 4000),
      cacheWrite: Math.floor(next() * 9000),
      cacheRead: Math.floor(next() * 90_000),
    };
    const spread = 1 + Math.floor(next() * 4);
    for (let s = 0; s < spread; s += 1) {
      lines.push(
        assistantLine({
          messageId,
          usage,
          timestamp: new Date(Date.UTC(2026, 8, 28, 12, m, s)).toISOString(),
          ...(options.version === undefined ? {} : { version: options.version }),
          ...(options.subagent === undefined ? {} : { subagent: options.subagent }),
        }),
      );
      assistantLines += 1;
    }
  }
  lines.push(syntheticModelLine(`msg_${token(next, 24)}`, options.version));
  assistantLines += 1;
  return { text: lines.map((line) => `${line}\n`).join(""), lines, assistantLines };
}
