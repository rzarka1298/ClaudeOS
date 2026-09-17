/**
 * A parsed data record, or an explicit parse-failure the caller can log.
 * `id` is `undefined` when the record carried no `id:` line of its own;
 * the caller (`event-client.ts`) is the one that decides whether an
 * `undefined` id means "keep my previous last-seen position."
 */
export type ParseResult =
  | { kind: "event"; id: number | undefined; data: unknown }
  | { kind: "parse-error"; raw: string; error: string };

export interface EventStreamParser {
  /** Feeds one chunk of the raw response stream; returns the records that chunk completed. */
  feed(chunk: string): ParseResult[];
}

const ID_LINE = /^id:\s?(.*)$/m;
const DATA_LINE = /^data:\s?(.*)$/m;

/**
 * An incremental parser over the standard event-stream text format
 * (`id:`/`data:`/blank-line-terminated records). Holds a string buffer;
 * each `feed(chunk)` normalizes line endings, repeatedly locates the
 * record terminator (a blank line), slices the record out, and parses its
 * `id:`/`data:` lines. Anything after the last terminator stays in the
 * buffer for the next `feed()` call, so a chunk boundary landing mid-record
 * never drops or half-parses a record. A record whose data fails to parse
 * returns a `parse-error` entry rather than throwing — one malformed event
 * must not end a long-lived subscription (T-01-36).
 */
export function createEventStreamParser(): EventStreamParser {
  let buffer = "";
  let lastId: number | undefined;

  return {
    feed(chunk: string): ParseResult[] {
      // Normalize CRLF and bare-CR line endings to LF across the whole
      // accumulated buffer (not just the new chunk) so a line ending split
      // across a chunk boundary (a trailing \r with the \n arriving in the
      // next chunk) never produces a phantom empty line.
      buffer = `${buffer}${chunk}`.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

      const results: ParseResult[] = [];
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const raw = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);

        const idMatch = ID_LINE.exec(raw);
        if (idMatch) {
          const parsedId = Number(idMatch[1]);
          if (Number.isFinite(parsedId)) {
            lastId = parsedId;
          }
        }

        const dataMatch = DATA_LINE.exec(raw);
        if (dataMatch) {
          try {
            const data: unknown = JSON.parse(dataMatch[1] as string);
            results.push({ kind: "event", id: lastId, data });
          } catch (err) {
            results.push({
              kind: "parse-error",
              raw,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        boundary = buffer.indexOf("\n\n");
      }
      return results;
    },
  };
}
