import { config } from "../config.ts";
import type { GcraPolicy } from "../middleware/gcra.ts";
import type {
  RateLimitFunction,
  RequestContext,
  RequestHandler,
} from "../middleware/rateLimit.ts";
import { validateBody } from "../middleware/validator.ts";
import type { HttpRequestLike, HttpResponseLike } from "../transport/http.ts";
import {
  type AdmissionTier,
  API_ENDPOINTS,
  type ApiEndpoint,
  type AuthenticatedHandlers,
  type PublicHandlers,
} from "./endpoints.ts";
import type { RouteDefinition, RouteRunner } from "./http.ts";

type BodyHandler = (
  data: unknown,
  res: HttpResponseLike,
  context?: RequestContext,
) => unknown;
type AuthenticatedMiddleware = (
  req: HttpRequestLike,
  res: HttpResponseLike,
  next: BodyHandler,
) => unknown;

/**
 * Everything the route table needs to be turned into runners.
 *
 * The two handler bags are keyed by the same names the endpoint records use,
 * so a record naming a handler that does not exist is a type error rather than
 * a route that 404s at runtime.
 */
export interface ApiRouteDependencies {
  authenticateRequest: AuthenticatedMiddleware;
  rateLimit: RateLimitFunction & {
    withCost: (
      policy: GcraPolicy,
      costOf: (body: never) => number,
      handler: BodyHandler,
    ) => BodyHandler;
  };
  /** Handlers behind `authenticateRequest`, receiving the parsed body. */
  authenticated: AuthenticatedHandlers;
  /** Handlers that take the raw request and read their own body. */
  publicHandlers: PublicHandlers;
}

/**
 * Builds the runner for one endpoint record.
 *
 * The composition order is the contract, and it is the same for every
 * endpoint: admission budget, then authentication, then the work charge, then
 * schema validation, then the handler. Each endpoint's record says which of
 * those apply; none of them chooses its own order.
 *
 * `costOf` deliberately sees the unvalidated body — it runs before the schema,
 * because a request has to be priced before it is admitted, and a body that
 * fails validation has already cost the parse.
 */
function buildRunner(
  endpoint: ApiEndpoint,
  deps: ApiRouteDependencies,
  policies: Record<Exclude<AdmissionTier, "none">, GcraPolicy> & {
    work: GcraPolicy;
  },
): RouteRunner {
  const { authenticateRequest, rateLimit } = deps;

  if (endpoint.kind === "public") {
    const handler = deps.publicHandlers[endpoint.handler] as RequestHandler;
    if (endpoint.admission === "none") {
      return (req, res) => handler(req, res);
    }
    const policy = policies[endpoint.admission];
    return (req, res) => rateLimit(req, res, handler, handler, policy);
  }

  // The table is heterogeneous — sixteen handlers, sixteen body types — so
  // this one indexing step is untyped. What it is standing in for is checked
  // where it matters: `AuthenticatedHandlers` derives each signature from that
  // endpoint's schema, so a handler that cannot accept what its schema
  // produces fails to compile at the point it is supplied.
  let handler = deps.authenticated[endpoint.handler] as BodyHandler;
  if (endpoint.schema) {
    handler = validateBody(endpoint.schema, handler);
  }
  if (endpoint.cost) {
    handler = rateLimit.withCost(policies.work, endpoint.cost, handler);
  }

  if (endpoint.admission === "none") {
    return (req, res) => authenticateRequest(req, res, handler);
  }

  const policy = policies[endpoint.admission];
  return (req, res) =>
    rateLimit(req, res, authenticateRequest, handler, policy);
}

export function createApiRoutes(
  deps: ApiRouteDependencies,
): RouteDefinition[] {
  // Each bucket is a separate Redis key namespace. Before this, every limiter
  // shared one `ip:<addr>` counter, so login attempts and listing requests
  // drained the same budget and whichever limit was lowest silently governed
  // both.
  const policies = {
    auth: { bucket: "auth", ...config.rateLimit.auth },
    publicRead: { bucket: "public", ...config.rateLimit.publicRead },
    action: { bucket: "action", ...config.rateLimit.action },
    work: { bucket: "work", ...config.rateLimit.work },
  };

  return API_ENDPOINTS.map((endpoint) => ({
    method: endpoint.method,
    path: config.urlBase + endpoint.path,
    run: buildRunner(endpoint, deps, policies),
  }));
}
