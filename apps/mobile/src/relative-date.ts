import { t } from "./strings";

/**
 * Relative time for activity timestamps. Values slightly in the future are
 * clock skew and still read "방금 전"; further future values fall back to a
 * date instead of claiming they just happened.
 */
export function relativeDate(value: string, now = Date.now()): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return value;
  const diff = now - parsed;
  if (diff < -60_000) return dayLabel(parsed);
  const elapsed = Math.max(0, diff);
  if (elapsed < 60_000) return t.dates.justNow;
  if (elapsed < 3600_000) return t.dates.minutesAgo(Math.floor(elapsed / 60_000));
  if (elapsed < 86400_000) return t.dates.hoursAgo(Math.floor(elapsed / 3600_000));
  if (elapsed < 2 * 86400_000) return t.dates.yesterday;
  if (elapsed < 7 * 86400_000) return t.dates.daysAgo(Math.floor(elapsed / 86400_000));
  return dayLabel(parsed);
}

function dayLabel(value: number): string {
  return new Date(value).toLocaleDateString("ko-KR", { month: "short", day: "numeric" });
}
