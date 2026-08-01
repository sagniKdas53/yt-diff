import { assertEquals } from "std/assert/mod.ts";
import { generateCorsHeaders } from "../src/utils/http.ts";

const JSON_TYPE = "application/json; charset=utf-8";
const TWO = ["https://a.example", "https://b.example"];

Deno.test("cors - emits exactly one origin with a two-entry allowlist", () => {
  // The bug this replaces joined the whole list with ", ", which every browser
  // rejects. It only ever worked because the allowlist had one entry.
  const headers = generateCorsHeaders(JSON_TYPE, { allowedOrigins: TWO });
  const origin = headers["Access-Control-Allow-Origin"];

  assertEquals(origin.includes(","), false);
  assertEquals(origin, "https://a.example");
});

Deno.test("cors - echoes the request origin when it is allowed", () => {
  const headers = generateCorsHeaders(JSON_TYPE, {
    allowedOrigins: TWO,
    requestOrigin: "https://b.example",
  });
  assertEquals(headers["Access-Control-Allow-Origin"], "https://b.example");
});

Deno.test("cors - falls back to the first origin when not allowed", () => {
  const headers = generateCorsHeaders(JSON_TYPE, {
    allowedOrigins: TWO,
    requestOrigin: "https://evil.example",
  });
  // Never echo an origin that is not on the allowlist.
  assertEquals(headers["Access-Control-Allow-Origin"], "https://a.example");
});

Deno.test("cors - a wildcard allowlist stays a wildcard", () => {
  const headers = generateCorsHeaders(JSON_TYPE, {
    allowedOrigins: ["*"],
    requestOrigin: "https://anything.example",
  });
  assertEquals(headers["Access-Control-Allow-Origin"], "*");
});

Deno.test("cors - always sets Vary: Origin", () => {
  // The response now depends on the Origin header, so a shared cache must not
  // serve one origin's response to another.
  assertEquals(generateCorsHeaders(JSON_TYPE)["Vary"], "Origin");
  assertEquals(
    generateCorsHeaders(JSON_TYPE, { allowedOrigins: TWO })["Vary"],
    "Origin",
  );
});

Deno.test("cors - single-origin call sites are unchanged", () => {
  // Every existing caller omits requestOrigin; behaviour must be identical to
  // before the change.
  const headers = generateCorsHeaders(JSON_TYPE, {
    allowedOrigins: ["http://localhost:5173"],
  });
  assertEquals(
    headers["Access-Control-Allow-Origin"],
    "http://localhost:5173",
  );
  assertEquals(headers["Content-Type"], JSON_TYPE);
});

Deno.test("cors - null or empty requestOrigin falls back cleanly", () => {
  for (const requestOrigin of [null, undefined, ""]) {
    const headers = generateCorsHeaders(JSON_TYPE, {
      allowedOrigins: TWO,
      requestOrigin,
    });
    assertEquals(headers["Access-Control-Allow-Origin"], "https://a.example");
  }
});

Deno.test("cors - an empty allowlist yields an empty origin, not undefined", () => {
  const headers = generateCorsHeaders(JSON_TYPE, { allowedOrigins: [] });
  assertEquals(headers["Access-Control-Allow-Origin"], "");
});

Deno.test("cors - methods and content type are preserved", () => {
  const headers = generateCorsHeaders("text/plain", {
    allowedMethods: ["GET", "POST"],
    maxAge: 60,
  });
  assertEquals(headers["Access-Control-Allow-Methods"], "GET, POST");
  assertEquals(headers["Access-Control-Max-Age"], 60);
  assertEquals(headers["Content-Type"], "text/plain");
  assertEquals(
    headers["Access-Control-Allow-Headers"],
    "Content-Type, Authorization",
  );
});
