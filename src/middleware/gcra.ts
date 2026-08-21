import type Redis from "ioredis";

/**
 * Generic Cell Rate Algorithm (GCRA) rate limiting.
 *
 * GCRA stores a single number per key — the "theoretical arrival time" (TAT),
 * the instant at which the bucket would next be completely empty. Everything
 * else (how much budget remains, how long until the next unit is available) is
 * derived from that one timestamp, so there is no counter to increment and no
 * separate refill tick to schedule.
 *
 * Compared with the fixed-window counter this replaces:
 *
 *   - Budget refills smoothly instead of resetting on a window boundary, so a
 *     caller cannot get 2x the limit by straddling the boundary.
 *   - Cost is a first-class input. One request may consume many units, which is
 *     what lets `/list` charge for the work it actually queues rather than for
 *     the single HTTP request it arrives as.
 *   - State is written in one atomic Lua call. The old `incr` + conditional
 *     `expire` pair could strand a key with no TTL if the process died between
 *     the two commands, locking that IP out until Redis was flushed by hand.
 */

export interface GcraPolicy {
  /**
   * Key namespace. Distinct buckets never share budget — this is what keeps
   * the login limiter and the listing limiter from draining each other.
   */
  bucket: string;
  /** Units available in a single burst. */
  burst: number;
  /** Units restored per `periodSec`. */
  refill: number;
  /** The period over which `refill` units are restored. */
  periodSec: number;
}

export interface GcraDecision {
  allowed: boolean;
  /** Units left in the burst allowance after this call. */
  remaining: number;
  /** Seconds until the requested cost would be admitted. 0 when allowed. */
  retryAfterSec: number;
  /** Seconds until the bucket is completely refilled. */
  resetAfterSec: number;
}

/**
 * The GCRA decision, as pure arithmetic.
 *
 * `LIMIT_SCRIPT` below is a direct translation of this function. Keep the two
 * in step: this one is what the unit tests exercise, and it is the reference
 * for what the Lua is supposed to do.
 *
 * @param tat Stored theoretical arrival time in ms, or null when unseen.
 * @param nowMs Current time in ms.
 */
export function gcraDecide(
  tat: number | null,
  nowMs: number,
  policy: GcraPolicy,
  cost: number,
): GcraDecision & { newTat: number } {
  // Milliseconds of budget that one unit represents.
  const emissionMs = (policy.periodSec * 1000) / policy.refill;
  // How far ahead of "now" the TAT may run — i.e. the burst allowance.
  const toleranceMs = emissionMs * policy.burst;

  const effectiveTat = Math.max(tat ?? nowMs, nowMs);
  const increment = cost * emissionMs;
  const newTat = effectiveTat + increment;
  // The instant at which this cost becomes affordable.
  const allowAtMs = newTat - toleranceMs;

  if (allowAtMs > nowMs) {
    // Denied. Report the state the caller still has, not the state they asked
    // for, so `remaining` stays truthful on a rejection.
    const remaining = Math.max(
      0,
      Math.floor((nowMs - (effectiveTat - toleranceMs)) / emissionMs),
    );
    return {
      allowed: false,
      remaining,
      retryAfterSec: Math.ceil((allowAtMs - nowMs) / 1000),
      resetAfterSec: Math.ceil((effectiveTat - nowMs) / 1000),
      newTat: effectiveTat,
    };
  }

  return {
    allowed: true,
    remaining: Math.max(
      0,
      Math.floor((nowMs - allowAtMs) / emissionMs),
    ),
    retryAfterSec: 0,
    resetAfterSec: Math.ceil((newTat - nowMs) / 1000),
    newTat,
  };
}

/**
 * Atomic GCRA in Lua. Mirrors `gcraDecide`.
 *
 * KEYS[1] bucket key
 * ARGV[1] now (ms)  ARGV[2] burst  ARGV[3] refill
 * ARGV[4] periodSec ARGV[5] cost
 *
 * Returns { allowed, remaining, retryAfterSec, resetAfterSec }.
 *
 * Note the TTL: the key only needs to outlive its own TAT, so an idle bucket
 * expires on its own and costs nothing to clean up.
 */
const LIMIT_SCRIPT = `
local key        = KEYS[1]
local now        = tonumber(ARGV[1])
local burst      = tonumber(ARGV[2])
local refill     = tonumber(ARGV[3])
local periodSec  = tonumber(ARGV[4])
local cost       = tonumber(ARGV[5])

local emission  = (periodSec * 1000) / refill
local tolerance = emission * burst

local tat = tonumber(redis.call('GET', key))
if tat == nil then tat = now end
if tat < now then tat = now end

local newTat  = tat + (cost * emission)
local allowAt = newTat - tolerance

if allowAt > now then
  local remaining = math.floor((now - (tat - tolerance)) / emission)
  if remaining < 0 then remaining = 0 end
  return {
    0,
    remaining,
    math.ceil((allowAt - now) / 1000),
    math.ceil((tat - now) / 1000)
  }
end

local ttl = math.ceil((newTat - now) / 1000) + 1
redis.call('SET', key, newTat, 'EX', ttl)

local remaining = math.floor((now - allowAt) / emission)
if remaining < 0 then remaining = 0 end
return {
  1,
  remaining,
  0,
  math.ceil((newTat - now) / 1000)
}
`;

export interface GcraLimiter {
  (identity: string, policy: GcraPolicy, cost?: number): Promise<GcraDecision>;
}

/**
 * Builds a limiter bound to a Redis connection.
 *
 * A policy with `burst <= 0` or `refill <= 0` is treated as "disabled" and
 * always admits — this preserves the historical `0 means off` opt-out.
 */
export function createGcraLimiter(redis: Redis): GcraLimiter {
  return async function consume(
    identity: string,
    policy: GcraPolicy,
    cost = 1,
  ): Promise<GcraDecision> {
    if (policy.burst <= 0 || policy.refill <= 0 || policy.periodSec <= 0) {
      return {
        allowed: true,
        remaining: Number.MAX_SAFE_INTEGER,
        retryAfterSec: 0,
        resetAfterSec: 0,
      };
    }

    // A zero or negative cost would let a caller probe endlessly for free.
    const chargedCost = Math.max(1, Math.ceil(cost));

    // A single request may not cost more than the whole burst allowance, or it
    // could never be admitted at any point in the future — that would be a
    // permanent failure presented to the user as a retryable 429.
    if (chargedCost > policy.burst) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterSec: policy.periodSec,
        resetAfterSec: policy.periodSec,
      };
    }

    const key = `rl:${policy.bucket}:${identity}`;
    const raw = await redis.eval(
      LIMIT_SCRIPT,
      1,
      key,
      Date.now().toString(),
      policy.burst.toString(),
      policy.refill.toString(),
      policy.periodSec.toString(),
      chargedCost.toString(),
    ) as [number, number, number, number];

    return {
      allowed: raw[0] === 1,
      remaining: raw[1],
      retryAfterSec: raw[2],
      resetAfterSec: raw[3],
    };
  };
}
