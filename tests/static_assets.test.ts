import { assert, assertEquals } from "std/assert/mod.ts";
import { serveStaticAsset } from "../src/routes/helpers/serveStaticAsset.ts";
import {
  computeETag,
  hashedAssetMaxAge,
} from "../src/routes/helpers/assetCache.ts";
import type {
  HttpRequestLike,
  HttpResponseLike,
} from "../src/transport/http.ts";

const HTML = "text/html; charset=utf-8";

const INDEX = {
  file: "<!doctype html>",
  type: HTML,
  etag: '"aaaaaaaaaaaaaaaa"',
};
const HASHED = {
  file: "console.log(1)",
  type: "text/javascript",
  etag: '"bbbbbbbbbbbbbbbb"',
};
/** The brotli variant of the entry document, with a validator of its own. */
const INDEX_BR = {
  file: "br-bytes",
  type: HTML,
  etag: '"cccccccccccccccc"',
};

/** The shape `makeAssets` produces, cut down to what these tests look up. */
const assets = Object.assign(Object.create(null), {
  // The aliases share one object, exactly as `makeAssets` builds them, so they
  // necessarily carry the same validator.
  "/ytdiff/": INDEX,
  "/ytdiff/index.html": INDEX,
  "/ytdiff/index.html.br": INDEX_BR,
  "/ytdiff/assets/app.js": HASHED,
});

/** Records what the handler wrote, so a test can assert on status and headers. */
function makeExchange(url: string, headers: Record<string, string> = {}) {
  const written: {
    status?: number;
    body: string;
    headers: Record<string, string | number>;
  } = { body: "", headers: {} };
  const req = { url, method: "GET", headers } as unknown as HttpRequestLike;
  const res = {
    writeHead(status: number, outHeaders?: Record<string, string | number>) {
      written.status = status;
      written.headers = outHeaders ?? {};
      return this;
    },
    write(chunk: string | Uint8Array) {
      written.body += typeof chunk === "string" ? chunk : "";
      return true;
    },
    end() {},
  } as unknown as HttpResponseLike;
  return { req, res, written };
}

const serve = (url: string, headers?: Record<string, string>) => {
  const { req, res, written } = makeExchange(url, headers);
  const handled = serveStaticAsset(req, res, {
    staticAssets: assets,
    generateCorsHeaders: () => ({}),
    htmlMimeType: HTML,
  });
  return { handled, written };
};

Deno.test("static - serves an exact asset path", () => {
  const { handled, written } = serve("/ytdiff/assets/app.js");
  assertEquals(handled, true);
  assertEquals(written.status, 200);
});

Deno.test("static - a query string does not turn an asset into a 404", () => {
  // `req.url` is pathname + search, but the asset table is keyed on pathname.
  // Before this, any link carrying a tracking parameter — or anything else
  // pasted after the path — failed to load the app at all.
  for (
    const url of [
      "/ytdiff/?utm_source=newsletter",
      "/ytdiff/index.html?v=2",
      "/ytdiff/assets/app.js?hash=abc",
    ]
  ) {
    const { handled, written } = serve(url);
    assertEquals(handled, true, url);
    assertEquals(written.status, 200, url);
  }
});

Deno.test("static - an unknown path is still a 404", () => {
  // Dropping the query must not turn the table into a fallback: a path that
  // names no asset is a miss, with or without a query on it.
  for (const url of ["/ytdiff/nope", "/ytdiff/nope?a=1"]) {
    const { handled, written } = serve(url);
    assertEquals(handled, true, url);
    assertEquals(written.status, 404, url);
    assertEquals(written.body, "Not Found", url);
  }
});

Deno.test("static - a fragment-routed deep link loads the app", () => {
  // The fragment never reaches the server, so a link to `#/playlist/...`
  // arrives here as a plain request for the base path.
  const { handled, written } = serve("/ytdiff/");
  assertEquals(handled, true);
  assertEquals(written.status, 200);
});

Deno.test("static - a content-hashed asset is immutable for the token lifetime", () => {
  // Vite writes the content hash into everything under `assets/`, so those
  // bytes can never change under that URL and a deploy asks for a different
  // name instead. The window is the login token's, not the conventional year.
  const { written } = serve("/ytdiff/assets/app.js");
  const cacheControl = String(written.headers["Cache-Control"]);
  assert(
    cacheControl.includes("immutable"),
    `expected immutable, got ${cacheControl}`,
  );
  assert(
    cacheControl.includes(`max-age=${hashedAssetMaxAge()}`),
    `expected the token lifetime, got ${cacheControl}`,
  );
  assert(cacheControl.startsWith("public"), cacheControl);
});

Deno.test("static - a reusable name must be revalidated before reuse", () => {
  // The entry document keeps a name every deploy reuses, and a stale one names
  // bundles that no longer exist — so it revalidates rather than going stale.
  for (const url of ["/ytdiff/", "/ytdiff/index.html"]) {
    assertEquals(serve(url).written.headers["Cache-Control"], "no-cache", url);
  }
});

Deno.test("static - the API's own headers are not touched by any of this", () => {
  // The directives deliberately bypass `generateCorsHeaders`, which `json()`
  // and every API handler build their headers through. This fixture passes a
  // `generateCorsHeaders` that returns nothing, so anything present here was
  // added by the asset path alone — which is the whole point of the split.
  const { written } = serve("/ytdiff/assets/app.js");
  assertEquals(Object.keys(written.headers).sort(), [
    "Cache-Control",
    "ETag",
    "Vary",
  ]);
});

Deno.test("static - an asset response carries a validator", () => {
  assertEquals(
    serve("/ytdiff/assets/app.js").written.headers["ETag"],
    HASHED.etag,
  );
});

Deno.test("static - a matching If-None-Match is answered with an empty 304", () => {
  const { written } = serve("/ytdiff/index.html", {
    "if-none-match": INDEX.etag,
  });
  assertEquals(written.status, 304);
  assertEquals(written.body, "");
  // The validator still comes back, so the cache can re-store the entry.
  assertEquals(written.headers["ETag"], INDEX.etag);
});

Deno.test("static - a stale If-None-Match gets the body", () => {
  const { written } = serve("/ytdiff/index.html", {
    "if-none-match": '"not-the-current-one"',
  });
  assertEquals(written.status, 200);
  assertEquals(written.body, "<!doctype html>");
});

Deno.test("static - If-None-Match handles the list, W/ and * forms", () => {
  for (
    const header of [
      `"other", ${INDEX.etag}`,
      `W/${INDEX.etag}`,
      "*",
    ]
  ) {
    assertEquals(
      serve("/ytdiff/index.html", { "if-none-match": header }).written.status,
      304,
      header,
    );
  }
});

Deno.test("static - each encoded variant validates as itself", () => {
  // A gzip and a brotli body for one URL are different representations. Giving
  // them one validator would let a cache answer an identity request with
  // brotli bytes, so the tag follows the variant actually being sent.
  const identity = serve("/ytdiff/index.html").written;
  const brotli =
    serve("/ytdiff/index.html", { "accept-encoding": "br" }).written;

  assertEquals(identity.headers["ETag"], INDEX.etag);
  assertEquals(brotli.headers["ETag"], INDEX_BR.etag);
  assertEquals(brotli.headers["Content-Encoding"], "br");

  // The identity tag must not satisfy a request that will be answered in
  // brotli — that is exactly the mismatch the per-variant tag prevents.
  assertEquals(
    serve("/ytdiff/index.html", {
      "accept-encoding": "br",
      "if-none-match": INDEX.etag,
    }).written.status,
    200,
  );
});

Deno.test("static - a 304 does not claim an encoding it is not sending", () => {
  // `Content-Encoding` on a bodyless response describes bytes that are not
  // there; some clients treat that as a truncated body.
  const { written } = serve("/ytdiff/index.html", {
    "accept-encoding": "br",
    "if-none-match": INDEX_BR.etag,
  });
  assertEquals(written.status, 304);
  assertEquals(written.headers["Content-Encoding"], undefined);
});

Deno.test("static - responses vary on Accept-Encoding", () => {
  // One URL answers with brotli, gzip or identity depending on the request.
  // Without this a shared cache may hand the brotli body to a client that
  // never asked for it — only reachable now that these are cacheable at all.
  assertEquals(
    String(serve("/ytdiff/index.html").written.headers["Vary"]),
    "Accept-Encoding",
  );
});

Deno.test("static - Vary keeps whatever the CORS headers already set", () => {
  // `generateCorsHeaders` sets `Vary: Origin`; appending must not drop it.
  const { req, res, written } = makeExchange("/ytdiff/index.html");
  serveStaticAsset(req, res, {
    staticAssets: assets,
    generateCorsHeaders: () => ({ Vary: "Origin" }),
    htmlMimeType: HTML,
  });
  assertEquals(String(written.headers["Vary"]), "Origin, Accept-Encoding");
});

Deno.test("etag - the same bytes give the same tag, different bytes do not", async () => {
  assertEquals(
    await computeETag("console.log(1)"),
    await computeETag("console.log(1)"),
  );
  assert(
    await computeETag("console.log(1)") !== await computeETag("console.log(2)"),
  );
});

Deno.test("etag - a string and the bytes it encodes to agree", async () => {
  // `makeAssets` stores `readFileSync` bytes for real files but a plain string
  // for `/ping`, and both go through the same stamping pass at boot.
  const text = "pong";
  assertEquals(
    await computeETag(text),
    await computeETag(new TextEncoder().encode(text)),
  );
});

Deno.test("etag - is a quoted strong validator", async () => {
  const tag = await computeETag("anything");
  assert(/^"[0-9a-f]{16}"$/.test(tag), tag);
});
