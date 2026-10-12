const NOTE_KEY = /^[a-z][a-z-]*$/;
const NOTE_VALUE = /^[a-z0-9,. -]{1,120}$/;
const UNRATIFIED = "ratified: pending";

/**
 * Inserts one `key: value` line into a freshly rendered report's front matter, just before the
 * unratified marker (05.2-09). The key and value are restricted to fixed-vocabulary characters
 * so a note can never carry script text, a path or a quoted message.
 */
export function addFrontMatterNote(text: string, key: string, value: string): string {
  if (!NOTE_KEY.test(key) || !NOTE_VALUE.test(value)) {
    throw new Error("A report front-matter note must use plain lowercase words.");
  }
  const lines = text.split("\n");
  const at = lines.findIndex((line, index) => line === UNRATIFIED && index < 40);
  if (at < 0) throw new Error("The report has no unratified marker to place the note before.");
  lines.splice(at, 0, `${key}: ${value}`);
  return lines.join("\n");
}
