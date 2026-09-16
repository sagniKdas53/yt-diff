/**
 * Parses the duration strings `jsonwebtoken` accepts into whole seconds.
 *
 * `config.auth.tokenExpiry` is one of these ("24h" by default, anything
 * `expiresIn` takes if a deployment overrides it). The static-asset cache
 * lifetime is pinned to that same value, so it needs the number of seconds —
 * and deriving it here means the two cannot drift apart the way two separately
 * configured durations would.
 */

/** Seconds in each unit `jsonwebtoken` recognises, by its accepted spellings. */
const UNIT_SECONDS: Record<string, number> = {
  ms: 0.001,
  s: 1,
  sec: 1,
  secs: 1,
  second: 1,
  seconds: 1,
  m: 60,
  min: 60,
  mins: 60,
  minute: 60,
  minutes: 60,
  h: 3600,
  hr: 3600,
  hrs: 3600,
  hour: 3600,
  hours: 3600,
  d: 86400,
  day: 86400,
  days: 86400,
  w: 604800,
  week: 604800,
  weeks: 604800,
  y: 31557600,
  year: 31557600,
  years: 31557600,
};

/** Optional whitespace between the amount and the unit, as `ms` allows. */
const DURATION_PATTERN = /^(-?(?:\d+)?\.?\d+)\s*([a-z]+)?$/i;

/**
 * @param value A duration string ("24h", "7 days") or a number of seconds.
 * @param fallbackSeconds Returned when `value` is not a duration this
 *        understands, so a typo in `TOKEN_EXPIRY` cannot produce a `max-age`
 *        of `NaN` in a response header.
 */
export function durationToSeconds(
  value: string | number,
  fallbackSeconds: number,
): number {
  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 0
      ? Math.floor(value)
      : fallbackSeconds;
  }

  const match = DURATION_PATTERN.exec(value.trim());
  if (!match) {
    return fallbackSeconds;
  }

  const amount = Number(match[1]);
  // A bare number is seconds, which is what `expiresIn` does with one.
  const unit = match[2]?.toLowerCase() ?? "s";
  const unitSeconds = UNIT_SECONDS[unit];

  if (!Number.isFinite(amount) || amount < 0 || unitSeconds === undefined) {
    return fallbackSeconds;
  }

  return Math.floor(amount * unitSeconds);
}
