import {
  NOTE_ID_PATTERN,
  TASK_CURSOR_MAX_LENGTH,
  TASK_FILTERS,
  type TaskFilter,
} from "@ccc/domain";
import type { TaskCursor } from "@ccc/operational-store";

/**
 * Opaque cursors (plan 06-20; D-28, T-06-27).
 *
 * A task cursor carries the filter, the last row's sort keys and its id, as
 * `base64url(JSON([filter, keys, id]))`. The wire form is bounded and URL-safe,
 * and decoding validates the shape before anything reaches the store: the
 * decoded keys are only ever BOUND parameters there, never SQL text. A cursor
 * from another filter, a truncated one, one with characters outside the
 * URL-safe set and one of the wrong shape all decode to `null`, which the
 * routes answer with the closed `invalid-cursor` code.
 *
 * An offset cursor (the attention list, which is a plain in-memory array) is
 * `base64url(JSON(["attention", offset]))`.
 */

const URL_SAFE = /^[A-Za-z0-9_-]+$/;
const MAX_KEY_TEXT_LENGTH = 64;
const MAX_KEYS = 3;
const MAX_OFFSET = 1_000_000;

function toWire(value: unknown): string {
  const text = Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  if (text.length > TASK_CURSOR_MAX_LENGTH) throw new RangeError("cursor exceeds its bound");
  return text;
}

/** Decodes to a JSON value, or `null` for anything that is not the exact canonical encoding. */
function fromWire(text: string): unknown {
  if (typeof text !== "string" || text.length === 0 || text.length > TASK_CURSOR_MAX_LENGTH) {
    return null;
  }
  if (!URL_SAFE.test(text)) return null;
  const bytes = Buffer.from(text, "base64url");
  // Canonical form only: a re-encode must give back exactly what arrived.
  if (bytes.toString("base64url") !== text) return null;
  try {
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    return null;
  }
}

export function encodeTaskCursor(cursor: TaskCursor): string {
  return toWire([cursor.filter, cursor.keys, cursor.id]);
}

/** The cursor for `filter`, or `null` when `text` is not a valid cursor for exactly that filter. */
export function decodeTaskCursor(text: string, filter: TaskFilter): TaskCursor | null {
  const value = fromWire(text);
  if (!Array.isArray(value) || value.length !== 3) return null;
  const [named, keys, id] = value as [unknown, unknown, unknown];
  if (typeof named !== "string" || !(TASK_FILTERS as readonly string[]).includes(named)) {
    return null;
  }
  if (named !== filter) return null;
  if (!Array.isArray(keys) || keys.length < 1 || keys.length > MAX_KEYS) return null;
  const checked: (string | number)[] = [];
  for (const key of keys as unknown[]) {
    if (typeof key === "string" && key.length <= MAX_KEY_TEXT_LENGTH) checked.push(key);
    else if (typeof key === "number" && Number.isInteger(key)) checked.push(key);
    else return null;
  }
  if (typeof id !== "string" || !NOTE_ID_PATTERN.test(id)) return null;
  return { filter, keys: checked, id };
}

export function encodeOffsetCursor(offset: number): string {
  return toWire(["attention", offset]);
}

/** The offset, or `null` when `text` is not a valid offset cursor. */
export function decodeOffsetCursor(text: string): number | null {
  const value = fromWire(text);
  if (!Array.isArray(value) || value.length !== 2) return null;
  const [tag, offset] = value as [unknown, unknown];
  if (tag !== "attention") return null;
  if (typeof offset !== "number" || !Number.isInteger(offset)) return null;
  if (offset < 0 || offset > MAX_OFFSET) return null;
  return offset;
}
