// deno-lint-ignore-file no-explicit-any
// The mocks below stand in for ioredis and the node http request/response
// objects; casting them to the real types is what keeps the middleware under
// test unchanged. Same convention as src/transport/http.ts.
import { assertEquals } from "std/assert/mod.ts";
import { createRateLimit } from "../src/middleware/rateLimit.ts";
import { gcraDecide, type GcraPolicy } from "../src/middleware/gcra.ts";
import { parseTrustedProxies } from "../src/utils/clientIp.ts";

/**
 * Redis double with just enough behaviour to run the GCRA Lua script.
 *
 * `eval` here executes `gcraDecide` — the TypeScript reference the Lua script
 * mirrors — against the same stored value, so these tests exercise the real
 * key naming, TTL handling and decision plumbing without a Redis server. The
 * arithmetic itself is covered directly further down.
 */
class MockRedis {
  store = new Map<string, { value: string; expireAt?: number }>();
  /** Every key touched, in order — used to assert bucket isolation. */
  seenKeys: string[] = [];

  get(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    if (!entry) return Promise.resolve(null);
    if (entry.expireAt && Date.now() > entry.expireAt) {
      this.store.delete(key);
      return Promise.resolve(null);
    }
    return Promise.resolve(entry.value);
  }

  eval(
    _script: string,
    _numKeys: number,
    key: string,
    now: string,
    burst: string,
    refill: string,
    periodSec: string,
    cost: string,
  ): Promise<[number, number, number, number]> {
    this.seenKeys.push(key);

    const entry = this.store.get(key);
    const expired = entry?.expireAt !== undefined &&
      Date.now() > entry.expireAt;
    const tat = entry && !expired ? Number(entry.value) : null;

    const policy: GcraPolicy = {
      bucket: "",
      burst: Number(burst),
      refill: Number(refill),
      periodSec: Number(periodSec),
    };
    const decision = gcraDecide(tat, Number(now), policy, Number(cost));

    if (decision.allowed) {
      this.store.set(key, {
        value: String(decision.newTat),
        expireAt: Date.now() + (decision.resetAfterSec + 1) * 1000,
      });
    }

    return Promise.resolve([
      decision.allowed ? 1 : 0,
      decision.remaining,
      decision.retryAfterSec,
      decision.resetAfterSec,
    ]);
  }
}

class MockResponse {
  statusCode = 200;
  headers: Record<string, string | number> = {};
  body = "";

  writeHead(statusCode: number, headers: Record<string, string | number>) {
    this.statusCode = statusCode;
    this.headers = headers;
  }

  end(content: string) {
    this.body = content;
  }
}

const policy = (over: Partial<GcraPolicy> = {}): GcraPolicy => ({
  bucket: "test",
  burst: 5,
  refill: 5,
  periodSec: 60,
  ...over,
});

const req = (
  peer = "127.0.0.1",
  forwardedFor?: string,
) =>
  ({
    socket: { remoteAddress: peer },
    headers: forwardedFor ? { "x-forwarded-for": forwardedFor } : {},
  }) as any;

Deno.test("rateLimit - a disabled policy (burst 0) always admits", async () => {
  const redis = new MockRedis();
  const rateLimit = createRateLimit({ redis: redis as any });
  let nextCalled = false;

  const res = new MockResponse() as any;
  await rateLimit(
    req(),
    res,
    () => {
      nextCalled = true;
    },
    () => {},
    policy({ burst: 0 }),
  );

  assertEquals(nextCalled, true);
  assertEquals(res.statusCode, 200);
});

Deno.test("rateLimit - admits within burst, then rejects with 429 + Retry-After", async () => {
  const redis = new MockRedis();
  const rateLimit = createRateLimit({ redis: redis as any });
  let calls = 0;

  const res = new MockResponse() as any;
  const p = policy({ burst: 2, refill: 2, periodSec: 60 });

  for (let i = 0; i < 2; i++) {
    await rateLimit(
      req(),
      res,
      () => {
        calls++;
      },
      () => {},
      p,
    );
  }
  assertEquals(calls, 2);
  assertEquals(res.statusCode, 200);

  await rateLimit(
    req(),
    res,
    () => {
      calls++;
    },
    () => {},
    p,
  );

  assertEquals(calls, 2, "handler must not run once the burst is spent");
  assertEquals(res.statusCode, 429);

  const payload = JSON.parse(res.body);
  assertEquals(payload.status, "error");
  // A 429 without Retry-After leaves a client with nothing to back off against.
  assertEquals(typeof payload.retryAfter, "number");
  assertEquals(payload.retryAfter >= 1, true);
  assertEquals(typeof res.headers["Retry-After"], "string");
});

Deno.test("rateLimit - separate buckets do not share budget", async () => {
  // Regression test. Every limiter previously keyed on `ip:<addr>` with no
  // scope, so the login limiter and the listing limiter drained one counter
  // and whichever budget was smallest silently governed both.
  const redis = new MockRedis();
  const rateLimit = createRateLimit({ redis: redis as any });

  const authPolicy = policy({ bucket: "auth", burst: 1, refill: 1 });
  const actionPolicy = policy({ bucket: "action", burst: 1, refill: 1 });

  let authCalls = 0;
  let actionCalls = 0;

  const res = new MockResponse() as any;

  // Spend the whole auth budget from this address.
  await rateLimit(
    req(),
    res,
    () => {
      authCalls++;
    },
    () => {},
    authPolicy,
  );
  assertEquals(authCalls, 1);

  // The action bucket must still be untouched for the same address.
  await rateLimit(
    req(),
    res,
    () => {
      actionCalls++;
    },
    () => {},
    actionPolicy,
  );

  assertEquals(actionCalls, 1, "action budget must survive auth exhaustion");
  assertEquals(res.statusCode, 200);
  assertEquals(redis.seenKeys[0], "rl:auth:127.0.0.1");
  assertEquals(redis.seenKeys[1], "rl:action:127.0.0.1");
});

Deno.test("withCost - charges by request cost, not request count", async () => {
  const redis = new MockRedis();
  const rateLimit = createRateLimit({ redis: redis as any });

  let handled = 0;
  const workPolicy = policy({ bucket: "work", burst: 20, refill: 20 });

  // Cost mirrors the real model: one unit per URL in the list.
  const costOf = (body: never) =>
    ((body as { urlList?: unknown[] }).urlList ?? []).length;

  const limited = rateLimit.withCost(workPolicy, costOf, () => {
    handled++;
  });

  const res = new MockResponse() as any;
  const ctx = { userId: "user-1" };

  // A cheap request barely dents the budget.
  await limited({ urlList: ["a"] }, res, ctx);
  assertEquals(handled, 1);

  // A single expensive request consumes far more than one "request" worth.
  await limited({ urlList: Array(15).fill("x") }, res, ctx);
  assertEquals(handled, 2);

  // Budget is now nearly spent, so the next expensive request is refused even
  // though only three requests have been made in total.
  await limited({ urlList: Array(15).fill("x") }, res, ctx);
  assertEquals(handled, 2, "expensive request must be refused on cost");
  assertEquals(res.statusCode, 429);
});

Deno.test("withCost - budget follows the user, not the address", async () => {
  // Behind a reverse proxy every client shares one source address, so an
  // IP-keyed budget would let one user throttle everyone else.
  const redis = new MockRedis();
  const rateLimit = createRateLimit({ redis: redis as any });

  let handled = 0;
  const workPolicy = policy({ bucket: "work", burst: 2, refill: 2 });
  const limited = rateLimit.withCost(workPolicy, () => 2, () => {
    handled++;
  });

  const res = new MockResponse() as any;

  await limited({}, res, { userId: "alice", clientIp: "10.0.0.1" });
  assertEquals(handled, 1);

  // Alice is now out of budget.
  await limited({}, res, { userId: "alice", clientIp: "10.0.0.1" });
  assertEquals(handled, 1);
  assertEquals(res.statusCode, 429);

  // Bob arrives from the same proxy address and is unaffected.
  const res2 = new MockResponse() as any;
  await limited({}, res2, { userId: "bob", clientIp: "10.0.0.1" });
  assertEquals(handled, 2, "a second user must not inherit the first's budget");
  assertEquals(res2.statusCode, 200);
});

Deno.test("withCost - a request costlier than the whole burst is refused, not stalled", async () => {
  // Admitting it would push the TAT so far out that the bucket could never
  // catch up, turning a permanent failure into an endlessly retried 429.
  const redis = new MockRedis();
  const rateLimit = createRateLimit({ redis: redis as any });

  let handled = 0;
  const limited = rateLimit.withCost(
    policy({ bucket: "work", burst: 10, refill: 10 }),
    () => 50,
    () => {
      handled++;
    },
  );

  const res = new MockResponse() as any;
  await limited({}, res, { userId: "alice" });

  assertEquals(handled, 0);
  assertEquals(res.statusCode, 429);
});

Deno.test("gcraDecide - budget refills smoothly rather than on a window edge", () => {
  // The fixed-window counter this replaced allowed 2x the limit across a
  // boundary: spend the budget at the end of one window, spend it again at the
  // start of the next. GCRA has no boundary to straddle.
  const p = policy({ burst: 10, refill: 10, periodSec: 100 });
  const start = 1_000_000;

  // Spend the entire burst at once.
  const spent = gcraDecide(null, start, p, 10);
  assertEquals(spent.allowed, true);
  assertEquals(spent.remaining, 0);

  // Immediately after, nothing is available.
  assertEquals(gcraDecide(spent.newTat, start, p, 1).allowed, false);

  // One emission interval is 10s here, so 10s later exactly one unit is back —
  // not the whole allowance.
  const oneUnitLater = gcraDecide(spent.newTat, start + 10_000, p, 1);
  assertEquals(oneUnitLater.allowed, true);

  const twoAtOnce = gcraDecide(spent.newTat, start + 10_000, p, 2);
  assertEquals(twoAtOnce.allowed, false, "only one unit has refilled");
});

Deno.test("gcraDecide - reports a usable retryAfter when refused", () => {
  const p = policy({ burst: 5, refill: 5, periodSec: 50 });
  const now = 2_000_000;

  const spent = gcraDecide(null, now, p, 5);
  const refused = gcraDecide(spent.newTat, now, p, 1);

  assertEquals(refused.allowed, false);
  // Emission interval is 10s, so one unit is available 10s out.
  assertEquals(refused.retryAfterSec, 10);
  assertEquals(refused.remaining, 0);
});

Deno.test("rateLimit - a trusted proxy's clients get their own buckets", async () => {
  // The finding: behind a TLS-terminating proxy every request arrives from the
  // proxy's address, so all users shared one admission bucket and one noisy
  // client could lock out everyone else. /login and /register never reach the
  // per-user tier, so this is the only place they can be separated.
  const redis = new MockRedis();
  const rateLimit = createRateLimit({
    redis: redis as any,
    trustedProxies: parseTrustedProxies("10.0.0.0/8"),
  });
  const p = policy({ bucket: "auth", burst: 1, refill: 1 });

  let calls = 0;
  const bump = () => {
    calls++;
  };

  const first = new MockResponse() as any;
  await rateLimit(req("10.0.0.2", "198.51.100.9"), first, bump, () => {}, p);

  const second = new MockResponse() as any;
  await rateLimit(req("10.0.0.2", "198.51.100.10"), second, bump, () => {}, p);

  assertEquals(calls, 2, "one client's burst must not spend another's");
  assertEquals(second.statusCode, 200);

  // The first client is out of budget on its own key, and only its own.
  const third = new MockResponse() as any;
  await rateLimit(req("10.0.0.2", "198.51.100.9"), third, bump, () => {}, p);
  assertEquals(calls, 2);
  assertEquals(third.statusCode, 429);
});

Deno.test("rateLimit - an unlisted peer's forwarding header is ignored", async () => {
  // Without an allowlist X-Forwarded-For is client-controlled, so believing it
  // would hand every attacker an unlimited supply of fresh buckets.
  const redis = new MockRedis();
  const rateLimit = createRateLimit({
    redis: redis as any,
    trustedProxies: [],
  });
  const p = policy({ bucket: "auth", burst: 1, refill: 1 });

  let calls = 0;
  const bump = () => {
    calls++;
  };

  const first = new MockResponse() as any;
  await rateLimit(req("203.0.113.7", "1.1.1.1"), first, bump, () => {}, p);

  const second = new MockResponse() as any;
  await rateLimit(req("203.0.113.7", "2.2.2.2"), second, bump, () => {}, p);

  assertEquals(calls, 1, "same peer, same bucket, whatever it claims");
  assertEquals(second.statusCode, 429);
});
