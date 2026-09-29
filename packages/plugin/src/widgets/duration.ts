/**
 * The fixed duration format (UI-SPEC "Number and time formatting"): `{s} s`
 * under a minute, `{m} min` under an hour, else `{h} h {m} min`. Every
 * numeral uses `tabular-nums` in CSS, not here — this function only picks the
 * unit and rounds down. 05-13's S3 sessions table `Duration` column reuses
 * this same function, so the two surfaces can never disagree on what "12 min"
 * means.
 */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds} s`;
  const totalMinutes = Math.floor(ms / 60_000);
  if (totalMinutes < 60) return `${totalMinutes} min`;
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  return `${hours} h ${minutes} min`;
}
