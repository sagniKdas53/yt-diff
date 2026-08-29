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
  "/ytdiff/assets/app-B_gefvJN.js": {
    file: "console.log(1)",
    type: "text/javascript",
  },
  "/ytdiff/favicon.ico": { file: "x", type: "image/x-icon" },
});

/** Records what the handler wrote, so a test can assert on it afterwards. */
function makeExchange(url: string, headers: Record<string, string> = {}) {
  const written: {
    status?: number;
    body: string;
    headers: Record<string, string | number>;
  } = { body: "", headers: {} };
  const req = { url, method: "GET", headers } as unknown as HttpRequestLike;
  const res = {
    writeHead(status: number, headers?: Record<string, string | number>) {
      written.status = status;
      written.headers = headers ?? {};
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
  const { handled, written } = serve("/ytdiff/assets/app-B_gefvJN.js");
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

Deno.test("static - a content-hashed asset is immutable for a year", () => {
  // Vite writes the content hash into the name, so these bytes can never
  // change under this URL; a deploy asks for a different name instead.
  const { written } = serve("/ytdiff/assets/app-B_gefvJN.js");
  assertEquals(
    written.headers["Cache-Control"],
    "public, max-age=31536000, immutable",
  );
});

Deno.test("static - the entry document is always revalidated", () => {
  // It is what names the hashed bundles. A stale one points at files that a
  // deploy has already replaced, so it must never be reused without asking.
  for (const url of ["/ytdiff/", "/ytdiff/index.html", "/ytdiff/favicon.ico"]) {
    const { written } = serve(url);
    assertEquals(written.headers["Cache-Control"], "no-cache", url);
  }
});

Deno.test("static - the compressed variants carry the same policy", () => {
  // The chosen encoding must not change how long the answer may be reused.
  const { written } = serve("/ytdiff/assets/app-B_gefvJN.js", {
    "accept-encoding": "br, gzip",
  });
  assertEquals(
    written.headers["Cache-Control"],
    "public, max-age=31536000, immutable",
  );
});
