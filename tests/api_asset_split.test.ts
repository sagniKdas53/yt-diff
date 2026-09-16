import { assert, assertEquals } from "std/assert/mod.ts";
import {
  allowedMethodsFor,
  dispatchRoute,
  isApiPath,
  type RouteDefinition,
} from "../src/routes/http.ts";
import { signedFileCacheControl } from "../src/routes/helpers/assetCache.ts";

/** Two endpoints, shaped as `createApiRoutes` builds them. */
const routes: RouteDefinition[] = [
  { method: "POST", path: "/ytdiff/getplay", run: () => {} },
  { method: "POST", path: "/ytdiff/list", run: () => {} },
];

Deno.test("split - the route table decides what an API path is", () => {
  assert(isApiPath("/ytdiff/getplay", routes));
  assert(isApiPath("/ytdiff/list", routes));
  assert(!isApiPath("/ytdiff/", routes));
  assert(!isApiPath("/ytdiff/assets/app.js", routes));
  assert(!isApiPath("/ytdiff/index.html", routes));
});

Deno.test("split - a query string does not hide an API path", () => {
  // The table is keyed on the path alone, the same reason the asset lookup
  // strips one. Without this a `?` would route an endpoint to the asset tree.
  assert(isApiPath("/ytdiff/getplay?trace=1", routes));
});

Deno.test("split - an undefined url belongs to neither side", () => {
  assert(!isApiPath(undefined, routes));
  assertEquals(allowedMethodsFor(undefined, routes), []);
});

Deno.test("split - Allow is read off the table, not hardcoded", () => {
  assertEquals(allowedMethodsFor("/ytdiff/getplay", routes), ["POST"]);
  assertEquals(allowedMethodsFor("/ytdiff/nope", routes), []);

  // A path carrying two methods announces both, and announces each once.
  const twoMethods: RouteDefinition[] = [
    ...routes,
    { method: "GET", path: "/ytdiff/getplay", run: () => {} },
    { method: "POST", path: "/ytdiff/getplay", run: () => {} },
  ];
  assertEquals(allowedMethodsFor("/ytdiff/getplay", twoMethods), [
    "POST",
    "GET",
  ]);
});

Deno.test("split - a GET to an API path no longer looks like a missing asset", () => {
  // This is the bug the method-based branch produced: GET meant "asset", so a
  // GET to a real endpoint fell through to the asset table, missed, and came
  // back as a 404 with an HTML body. The path is now recognised as the API's
  // whatever the verb, which is what lets the caller answer 405 instead.
  assert(isApiPath("/ytdiff/getplay", routes));
  assertEquals(
    dispatchRoute(
      { url: "/ytdiff/getplay", method: "GET", headers: {} } as never,
      {} as never,
      routes,
    ),
    false,
  );
});

Deno.test("signed file - cached no longer than the signature is valid", () => {
  // A cached thumbnail must not outlive the signature that authorised it.
  assertEquals(signedFileCacheControl(3600), "private, max-age=3600");
  assertEquals(signedFileCacheControl(60), "private, max-age=60");
});

Deno.test("signed file - never public, whatever the lifetime", () => {
  // These are per-user signed URLs; a shared cache holding one is a shared
  // cache holding someone's file.
  for (const ttl of [3600, 1, 0, undefined]) {
    const value = signedFileCacheControl(ttl);
    assert(value.startsWith("private"), value);
    assert(!value.includes("public"), value);
  }
});

Deno.test("signed file - an absent or elapsed lifetime caches nothing", () => {
  assertEquals(signedFileCacheControl(undefined), "private, no-store");
  assertEquals(signedFileCacheControl(0), "private, no-store");
  assertEquals(signedFileCacheControl(-1), "private, no-store");
  assertEquals(signedFileCacheControl(Number.NaN), "private, no-store");
});
