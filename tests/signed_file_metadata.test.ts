import { assertEquals } from "std/assert/mod.ts";
import type Redis from "ioredis";
import { getSignedFileMetadata } from "../src/routes/helpers/getSignedFileMetadata.ts";

const CACHE_MAX_AGE = 3600;

/** Records the TTL each `expire` call slid the entry to. */
class MockRedis {
  private store = new Map<string, string>();
  expireCalls: { key: string; seconds: number }[] = [];

  seed(key: string, value: unknown) {
    this.store.set(key, JSON.stringify(value));
  }

  seedRaw(key: string, value: string) {
    this.store.set(key, value);
  }

  // deno-lint-ignore require-await
  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  // deno-lint-ignore require-await
  async expire(key: string, seconds: number): Promise<number> {
    this.expireCalls.push({ key, seconds });
    return this.store.has(key) ? 1 : 0;
  }
}

function request(fileId: string, inline = false): Request {
  const inlineParam = inline ? "&inline=true" : "";
  return new Request(
    `http://localhost/ytdiff/file?fileId=${fileId}${inlineParam}`,
  );
}

Deno.test("getSignedFileMetadata - slides by the entry's own ttl", async () => {
  const redis = new MockRedis();
  redis.seed("signed:abc", {
    filePath: "/save/video.mp4",
    mimeType: "video/mp4",
    ttl: 21600,
  });

  const metadata = await getSignedFileMetadata(
    request("abc"),
    redis as unknown as Redis,
    CACHE_MAX_AGE,
  );

  assertEquals(metadata?.filePath, "/save/video.mp4");
  assertEquals(metadata?.mimeType, "video/mp4");
  // A 6h bot link must not collapse to the 1h global default on first open.
  assertEquals(redis.expireCalls, [{ key: "signed:abc", seconds: 21600 }]);
});

Deno.test("getSignedFileMetadata - falls back to cacheMaxAge when ttl absent", async () => {
  const redis = new MockRedis();
  // Entries written before `ttl` was recorded keep the previous behaviour.
  redis.seed("signed:legacy", {
    filePath: "/save/old.mp4",
    mimeType: "video/mp4",
  });

  const metadata = await getSignedFileMetadata(
    request("legacy"),
    redis as unknown as Redis,
    CACHE_MAX_AGE,
  );

  assertEquals(metadata?.filePath, "/save/old.mp4");
  assertEquals(redis.expireCalls, [{
    key: "signed:legacy",
    seconds: CACHE_MAX_AGE,
  }]);
});

Deno.test("getSignedFileMetadata - ignores a non-positive ttl", async () => {
  const redis = new MockRedis();
  redis.seed("signed:zero", { filePath: "/save/z.mp4", ttl: 0 });

  await getSignedFileMetadata(
    request("zero"),
    redis as unknown as Redis,
    CACHE_MAX_AGE,
  );

  assertEquals(redis.expireCalls, [{
    key: "signed:zero",
    seconds: CACHE_MAX_AGE,
  }]);
});

Deno.test("getSignedFileMetadata - defaults the mime type when absent", async () => {
  const redis = new MockRedis();
  redis.seed("signed:nomime", { filePath: "/save/thing.bin", ttl: 60 });

  const metadata = await getSignedFileMetadata(
    request("nomime"),
    redis as unknown as Redis,
    CACHE_MAX_AGE,
  );

  assertEquals(metadata?.mimeType, "application/octet-stream");
});

Deno.test("getSignedFileMetadata - propagates the inline flag", async () => {
  const redis = new MockRedis();
  redis.seed("signed:inline", { filePath: "/save/v.mp4", ttl: 60 });

  const metadata = await getSignedFileMetadata(
    request("inline", true),
    redis as unknown as Redis,
    CACHE_MAX_AGE,
  );

  assertEquals(metadata?.inline, true);
});

Deno.test("getSignedFileMetadata - returns null without a fileId", async () => {
  const redis = new MockRedis();

  const metadata = await getSignedFileMetadata(
    new Request("http://localhost/ytdiff/file"),
    redis as unknown as Redis,
    CACHE_MAX_AGE,
  );

  assertEquals(metadata, null);
  assertEquals(redis.expireCalls.length, 0);
});

Deno.test("getSignedFileMetadata - returns null for an unknown fileId", async () => {
  const redis = new MockRedis();

  const metadata = await getSignedFileMetadata(
    request("missing"),
    redis as unknown as Redis,
    CACHE_MAX_AGE,
  );

  assertEquals(metadata, null);
  assertEquals(redis.expireCalls.length, 0);
});

Deno.test("getSignedFileMetadata - corrupt entry returns null and slides nothing", async () => {
  const redis = new MockRedis();
  redis.seedRaw("signed:corrupt", "{not json");

  const metadata = await getSignedFileMetadata(
    request("corrupt"),
    redis as unknown as Redis,
    CACHE_MAX_AGE,
  );

  assertEquals(metadata, null);
  // An unservable entry should not have its lifetime extended.
  assertEquals(redis.expireCalls.length, 0);
});
