import { assertEquals } from "std/assert/mod.ts";
import { serveStaticAsset } from "../src/routes/helpers/serveStaticAsset.ts";
import type {
  HttpRequestLike,
  HttpResponseLike,
} from "../src/transport/http.ts";

const HTML = "text/html; charset=utf-8";

const INDEX = { file: "<!doctype html>", type: HTML };

/** The shape `makeAssets` produces, cut down to what these tests look up. */
const assets = Object.assign(Object.create(null), {
  "/ytdiff/": INDEX,
  "/ytdiff/index.html": INDEX,
  "/ytdiff/assets/app.js": { file: "console.log(1)", type: "text/javascript" },
});

/** Records what the handler wrote, so a test can assert on the status alone. */
function makeExchange(url: string, headers: Record<string, string> = {}) {
  const written: { status?: number; body: string } = { body: "" };
  const req = { url, method: "GET", headers } as unknown as HttpRequestLike;
  const res = {
    writeHead(status: number) {
      written.status = status;
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
