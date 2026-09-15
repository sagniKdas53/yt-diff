import { assertEquals } from "std/assert/mod.ts";
import { durationToSeconds } from "../src/utils/duration.ts";

const FALLBACK = 86400;

Deno.test("duration - the units jsonwebtoken accepts", () => {
  assertEquals(durationToSeconds("24h", FALLBACK), 86400);
  assertEquals(durationToSeconds("60s", FALLBACK), 60);
  assertEquals(durationToSeconds("10m", FALLBACK), 600);
  assertEquals(durationToSeconds("7d", FALLBACK), 604800);
  assertEquals(durationToSeconds("1w", FALLBACK), 604800);
});

Deno.test("duration - long spellings and internal whitespace", () => {
  assertEquals(durationToSeconds("2 days", FALLBACK), 172800);
  assertEquals(durationToSeconds("1 hour", FALLBACK), 3600);
  assertEquals(durationToSeconds("  12h  ", FALLBACK), 43200);
  assertEquals(durationToSeconds("5 minutes", FALLBACK), 300);
});

Deno.test("duration - a bare number is seconds, as expiresIn treats one", () => {
  assertEquals(durationToSeconds("300", FALLBACK), 300);
  assertEquals(durationToSeconds(300, FALLBACK), 300);
});

Deno.test("duration - fractional amounts floor to whole seconds", () => {
  // `max-age` is an integer; a fractional one is not a valid directive.
  assertEquals(durationToSeconds("0.5h", FALLBACK), 1800);
  assertEquals(durationToSeconds("1.5d", FALLBACK), 129600);
});

Deno.test("duration - nonsense falls back instead of producing NaN", () => {
  // A typo in TOKEN_EXPIRY must not reach a response header as `max-age=NaN`,
  // which a cache is entitled to treat however it likes.
  for (const bad of ["", "soon", "24 fortnights", "-5h", "h", "1e", "NaN"]) {
    assertEquals(durationToSeconds(bad, FALLBACK), FALLBACK, bad);
  }
  assertEquals(durationToSeconds(Number.NaN, FALLBACK), FALLBACK);
  assertEquals(durationToSeconds(-1, FALLBACK), FALLBACK);
});
