// deno-lint-ignore-file no-explicit-any
// The mocks below stand in for ioredis and the node http request/response
// objects; casting them to the real types is what keeps the middleware under
// test unchanged. Same convention as src/transport/http.ts.
import { assertEquals } from "std/assert/mod.ts";
import { createRateLimit } from "../src/middleware/rateLimit.ts";

class MockRedis {
  private store = new Map<string, { value: string; expireAt?: number }>();

  // deno-lint-ignore require-await
  async get(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expireAt && Date.now() > entry.expireAt) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  // deno-lint-ignore require-await
  async set(
    key: string,
    value: string,
    mode?: string,
    duration?: number,
  ): Promise<"OK"> {
    let expireAt: number | undefined;
    if (mode === "EX" && duration) {
      expireAt = Date.now() + duration * 1000;
    }
    this.store.set(key, { value, expireAt });
    return "OK";
  }

  async incr(key: string): Promise<number> {
    const entry = await this.get(key);
    const newVal = entry ? Number(entry) + 1 : 1;
    this.store.set(key, { value: String(newVal) });
    return newVal;
  }

  // deno-lint-ignore require-await
  async expire(key: string, seconds: number): Promise<number> {
    const entry = this.store.get(key);
    if (entry) {
      entry.expireAt = Date.now() + seconds * 1000;
      return 1;
    }
    return 0;
  }
}

class MockResponse {
  statusCode = 200;
  headers: Record<string, string> = {};
  body = "";

  writeHead(statusCode: number, headers: Record<string, string>) {
    this.statusCode = statusCode;
    this.headers = headers;
  }

  end(content: string) {
    this.body = content;
  }
}

Deno.test("rateLimit - runs handlers when maxRequestsPerWindow is 0 (disabled)", async () => {
  const mockRedis = new MockRedis();
  const rateLimit = createRateLimit({ redis: mockRedis as any });
  let nextCalled = false;

  const req = { socket: { remoteAddress: "127.0.0.1" } } as any;
  const res = new MockResponse() as any;

  await rateLimit(
    req,
    res,
    () => {
      nextCalled = true;
    },
    () => {},
    0, // maxRequestsPerWindow = 0
    60,
  );

  assertEquals(nextCalled, true);
  assertEquals(res.statusCode, 200);
});

Deno.test("rateLimit - increments counter and allows request within limit", async () => {
  const mockRedis = new MockRedis();
  const rateLimit = createRateLimit({ redis: mockRedis as any });
  let nextCalls = 0;

  const req = { socket: { remoteAddress: "127.0.0.1" } } as any;
  const res = new MockResponse() as any;

  await rateLimit(
    req,
    res,
    () => {
      nextCalls++;
    },
    () => {},
    5, // limit = 5
    60,
  );

  assertEquals(nextCalls, 1);
  assertEquals(res.statusCode, 200);
  assertEquals(await mockRedis.get("ip:127.0.0.1"), "1");
});

Deno.test("rateLimit - blocks requests with 429 when limit is exceeded", async () => {
  const mockRedis = new MockRedis();
  const rateLimit = createRateLimit({ redis: mockRedis as any });
  let nextCalls = 0;

  const req = { socket: { remoteAddress: "127.0.0.1" } } as any;
  const res = new MockResponse() as any;

  // Execute 2 requests under a limit of 2
  await rateLimit(
    req,
    res,
    () => {
      nextCalls++;
    },
    () => {},
    2,
    60,
  );
  await rateLimit(
    req,
    res,
    () => {
      nextCalls++;
    },
    () => {},
    2,
    60,
  );

  assertEquals(nextCalls, 2);
  assertEquals(res.statusCode, 200);

  // Third request should exceed the limit
  await rateLimit(
    req,
    res,
    () => {
      nextCalls++;
    },
    () => {},
    2,
    60,
  );
  assertEquals(nextCalls, 2); // next should not be called
  assertEquals(res.statusCode, 429);

  const payload = JSON.parse(res.body);
  assertEquals(payload.status, "error");
  assertEquals(payload.message, "Too many requests");
});
