// deno-lint-ignore-file no-explicit-any
import { assert, assertEquals } from "std/assert/mod.ts";
import { config } from "../src/config.ts";
import { API_ENDPOINTS } from "../src/routes/endpoints.ts";
import { createApiRoutes } from "../src/routes/api.ts";

/**
 * Records which wrappers a route actually composed.
 *
 * The point of the table is that path, auth and schema stop being three
 * separate statements that can disagree. These assertions are what makes that
 * true at runtime rather than only in the reading.
 */
function probeRoutes() {
  const calls: string[] = [];

  const rateLimit = Object.assign(
    (_req: any, _res: any, current: any, next: any, policy: any) => {
      calls.push(`rateLimit:${policy.bucket}`);
      return current.length >= 3
        ? current(_req, _res, next)
        : current(_req, _res);
    },
    {
      withCost: (policy: any, costOf: any, handler: any) => {
        calls.push(`withCost:${policy.bucket}`);
        return (data: any, res: any) => {
          calls.push(`cost:${costOf(data ?? {})}`);
          return handler(data, res);
        };
      },
      chargeCost: () => Promise.resolve({} as any),
    },
  ) as any;

  const authenticateRequest = (req: any, res: any, next: any) => {
    calls.push("auth");
    return next(req.body, res, { userId: "u1" });
  };

  const named = (name: string) => (data: any, res: any) => {
    calls.push(`handler:${name}`);
    return { data, res };
  };

  const authenticated: any = {};
  const publicHandlers: any = {};
  for (const endpoint of API_ENDPOINTS) {
    const bag = endpoint.kind === "public" ? publicHandlers : authenticated;
    bag[endpoint.handler] = named(endpoint.handler);
  }

  const routes = createApiRoutes({
    authenticateRequest,
    rateLimit,
    authenticated,
    publicHandlers,
  });

  // withCost wraps at build time, so those entries belong to construction
  // rather than to any one request.
  const buildCalls = calls.splice(0, calls.length);
  return { routes, calls, buildCalls };
}

Deno.test("api contract - every endpoint record becomes exactly one route", () => {
  const { routes } = probeRoutes();

  assertEquals(routes.length, API_ENDPOINTS.length);
  assertEquals(
    routes.map((route) => route.path),
    API_ENDPOINTS.map((endpoint) => config.urlBase + endpoint.path),
  );
});

Deno.test("api contract - no two endpoints claim the same method and path", () => {
  // dispatchRoute takes the first match, so a duplicate would silently shadow
  // whichever record came second.
  const seen = new Set<string>();
  for (const endpoint of API_ENDPOINTS) {
    const key = `${endpoint.method} ${endpoint.path}`;
    assert(!seen.has(key), `duplicate route: ${key}`);
    seen.add(key);
  }
});

Deno.test("api contract - only the three pre-auth endpoints are public", () => {
  // Anything reachable without a token is the app's exposed surface. This is
  // the list; adding to it should have to be deliberate.
  const publicPaths = API_ENDPOINTS.filter((e) => e.kind === "public")
    .map((e) => e.path).sort();

  assertEquals(publicPaths, ["/isregallowed", "/login", "/register"]);
});

Deno.test("api contract - every authenticated endpoint validates its body", () => {
  // /refresh is the sole exception and says so: it reads the verified
  // identity, never the body. Any other schema-less endpoint would be a
  // handler receiving whatever JSON the client felt like sending.
  const unvalidated = API_ENDPOINTS
    .filter((e) => e.kind === "authenticated" && !e.schema)
    .map((e) => e.path);

  assertEquals(unvalidated, ["/refresh"]);
});

Deno.test("api contract - the credential endpoints share the auth budget", () => {
  const authBucketed = API_ENDPOINTS
    .filter((e) => e.admission === "auth")
    .map((e) => e.path).sort();

  // Anything that mints or extends a token is brute-force surface, whether or
  // not it is itself behind authentication.
  assertEquals(authBucketed, ["/login", "/refresh", "/register"]);
});

Deno.test("api contract - only the two queueing endpoints are charged for work", () => {
  const charged = API_ENDPOINTS
    .filter((e) => e.kind === "authenticated" && e.cost)
    .map((e) => e.path).sort();

  assertEquals(charged, ["/download", "/list"]);
});

Deno.test("api contract - an authenticated route runs auth before its handler", async () => {
  const { routes, calls } = probeRoutes();
  const route = routes.find((r) => r.path.endsWith("/getplay"))!;

  await route.run({ body: {}, headers: {}, socket: {} } as any, {} as any);

  assertEquals(calls, ["auth", "handler:getPlaylistsForDisplay"]);
});

Deno.test("api contract - a charged route is wrapped against the work budget", () => {
  // Two records carry a cost, so exactly two wrappers are built. The work
  // budget is the per-user one; the admission budget it sits behind is not.
  const { buildCalls } = probeRoutes();
  assertEquals(buildCalls, ["withCost:work", "withCost:work"]);
});

Deno.test("api contract - a charged route prices the body before validating it", async () => {
  // The order matters: admission first, then the verified user, then the
  // charge -- read from the unvalidated body, because that is all that exists
  // at the point a request has to be priced.
  const { routes, calls } = probeRoutes();
  const route = routes.find((r) => r.path.endsWith("/list"))!;

  await route.run(
    {
      body: { urlList: ["https://example.com/a", "https://example.com/b"] },
      headers: {},
      socket: {},
    } as any,
    { writeHead: () => {}, end: () => {} } as any,
  );

  assertEquals(calls[0], "rateLimit:action");
  assertEquals(calls[1], "auth");
  assert(calls[2].startsWith("cost:"), `expected a charge, got ${calls[2]}`);
  assertEquals(calls[3], "handler:processListingRequest");
});

Deno.test("api contract - a public route is not put behind authentication", async () => {
  const { routes, calls } = probeRoutes();
  const route = routes.find((r) => r.path.endsWith("/login"))!;

  await route.run({ headers: {}, socket: {} } as any, {} as any);

  assertEquals(calls, ["rateLimit:auth", "handler:authenticateUser"]);
});

Deno.test("api contract - a bad body is refused before the handler sees it", async () => {
  const { routes, calls } = probeRoutes();
  const route = routes.find((r) => r.path.endsWith("/watch"))!;

  let status = 0;
  await route.run(
    { body: { url: "" }, headers: {}, socket: {} } as any,
    {
      writeHead: (code: number) => {
        status = code;
      },
      end: () => {},
    } as any,
  );

  assertEquals(status, 400);
  assert(
    !calls.includes("handler:updatePlaylistMonitoring"),
    "the handler must not run on an invalid body",
  );
});
