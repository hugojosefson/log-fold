/**
 * Formats a duration in milliseconds for display.
 *
 * Auto-scales:
 * - <10s → "1.23s" (2 decimal places)
 * - 10–60s → "12.3s" (1 decimal place)
 * - 60–3600s → "1m 23s"
 * - ≥3600s → "1h 2m"
 */
export function formatDuration(ms: number): string {
  const s = ms / 1000;
  if (s < 10) return `${s.toFixed(2)}s`;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  if (s < 3600) return `${m}m ${Math.floor(s % 60)}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}
