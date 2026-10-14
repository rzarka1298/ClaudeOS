// The source delimiter (D-06, D-26, RSRCH-08). Each source is wrapped in one block:
//
//   <<<SRC id=<32 hex> nonce=<nonce>>>>
//   <text>
//   <<<END nonce=<nonce>>>>
//
// The nonce is chosen by the caller for each run. The hardening that makes a source unable
// to close its own block (scrubbing, validation) is the next task's work.

export interface SourceText {
  readonly sourceId: string;
  readonly text: string;
}

export interface DelimitedBlock {
  readonly sourceId: string;
  readonly text: string;
}

const HEADER = /^<<<SRC id=([0-9a-f]{32}) nonce=([0-9a-f]{16,64})>>>$/;

export function delimitSources(sources: readonly SourceText[], nonce: string): string {
  return sources
    .map((s) => `<<<SRC id=${s.sourceId} nonce=${nonce}>>>\n${s.text}\n<<<END nonce=${nonce}>>>`)
    .join("\n");
}

export function parseDelimitedBlocks(composed: string): readonly DelimitedBlock[] {
  const blocks: DelimitedBlock[] = [];
  let cursor = 0;
  while (cursor < composed.length) {
    const lineEnd = composed.indexOf("\n", cursor);
    const line = lineEnd === -1 ? composed.slice(cursor) : composed.slice(cursor, lineEnd);
    const header = HEADER.exec(line);
    if (header === null || lineEnd === -1) {
      cursor = lineEnd === -1 ? composed.length : lineEnd + 1;
      continue;
    }
    const bodyStart = lineEnd + 1;
    const footer = `\n<<<END nonce=${header[2]}>>>`;
    const bodyEnd = composed.indexOf(footer, bodyStart);
    if (bodyEnd === -1) break;
    blocks.push({ sourceId: header[1] ?? "", text: composed.slice(bodyStart, bodyEnd) });
    cursor = bodyEnd + footer.length;
  }
  return blocks;
}
