import type { Redis } from "ioredis";

import { logger } from "../logger.ts";
import type { HttpRequestLike, HttpResponseLike } from "../transport/http.ts";

import { generateCorsHeaders, MIME_TYPES } from "../utils/http.ts";
import { createGcraLimiter, type GcraPolicy } from "./gcra.ts";

export type MiddlewareNext = (
  data: unknown,
  res: HttpResponseLike,
  context?: RequestContext,
) => void;
export type MiddlewareHandler = (
  req: HttpRequestLike,
  res: HttpResponseLike,
  next: MiddlewareNext,
) => unknown;
export type RequestHandler = (
  req: HttpRequestLike,
  res: HttpResponseLike,
) => unknown;
export type NextHandler = MiddlewareNext;

/**
 * Identity and origin of an authenticated request.
 *
 * Rate limiting runs before authentication, so the admission tier only ever
 * knows the client address. Anything that needs to charge a real user has to
 * wait until `authenticateRequest` has verified the token, which is why this
 * is threaded forward to the handler rather than resolved at the middleware.
 */
export interface RequestContext {
  userId?: string;
  userName?: string;
  clientIp?: string;
}

export interface RateLimitFunction {
  (
    request: HttpRequestLike,
    response: HttpResponseLike,
    currentHandler: MiddlewareHandler,
    nextHandler: NextHandler,
    policy: GcraPolicy,
  ): Promise<unknown>;
  (
    request: HttpRequestLike,
    response: HttpResponseLike,
    currentHandler: RequestHandler,
    nextHandler: RequestHandler,
    policy: GcraPolicy,
  ): Promise<unknown>;
}

/** Charges cost against a bucket once the request's real work is known. */
export type CostCharger = (
  identity: string,
  policy: GcraPolicy,
  cost: number,
) => Promise<{ allowed: boolean; retryAfterSec: number; remaining: number }>;

interface RateLimitDependencies {
  redis: Redis;
}

export function createRateLimit({ redis }: RateLimitDependencies) {
  const jsonMimeType = MIME_TYPES[".json"];
  const consume = createGcraLimiter(redis);

  function reject(
    response: HttpResponseLike,
    retryAfterSec: number,
    message: string,
  ) {
    const headers: Record<string, string | number> = {
      ...generateCorsHeaders(jsonMimeType),
    };
    // Without Retry-After a client has no way to back off correctly, and the
    // frontend cannot tell a throttle apart from a transient failure.
    headers["Retry-After"] = String(Math.max(1, retryAfterSec));
    response.writeHead(429, headers);
    return response.end(JSON.stringify({
      status: "error",
      message,
      retryAfter: Math.max(1, retryAfterSec),
    }));
  }

  function invoke(
    request: HttpRequestLike,
    response: HttpResponseLike,
    currentHandler: MiddlewareHandler | RequestHandler,
    nextHandler: NextHandler | RequestHandler,
  ) {
    if (currentHandler.length >= 3) {
      return (currentHandler as MiddlewareHandler)(
        request,
        response,
        nextHandler as MiddlewareNext,
      );
    }

    return (currentHandler as RequestHandler)(request, response);
  }

  /**
   * Admission tier. Runs before authentication, so it can only key on the
   * client address and can only count requests — the body has not been read
   * and no user is known yet. Its budgets are deliberately loose: the job here
   * is to stop an unauthenticated flood, not to price the work.
   *
   * Per-request cost is charged later, by `chargeCost`.
   */
  const rateLimit: RateLimitFunction = async function rateLimit(
    request: HttpRequestLike,
    response: HttpResponseLike,
    currentHandler: MiddlewareHandler | RequestHandler,
    nextHandler: NextHandler | RequestHandler,
    policy: GcraPolicy,
  ) {
    const clientIp = request.socket.remoteAddress ?? "unknown";

    const decision = await consume(clientIp, policy, 1);
    if (!decision.allowed) {
      logger.debug(
        `Admission limit hit on "${policy.bucket}" for ${clientIp}; ` +
          `retry in ${decision.retryAfterSec}s`,
      );
      return reject(response, decision.retryAfterSec, "Too many requests");
    }

    return invoke(request, response, currentHandler, nextHandler);
  };

  /**
   * Cost tier. Called from a handler, where the parsed body and the verified
   * user are both available, so the charge can reflect the work requested.
   */
  const chargeCost: CostCharger = async function chargeCost(
    identity: string,
    policy: GcraPolicy,
    cost: number,
  ) {
    const decision = await consume(identity, policy, cost);
    if (!decision.allowed) {
      logger.info(
        `Cost limit hit on "${policy.bucket}" for ${identity}: ` +
          `cost ${cost}, ${decision.remaining} remaining, ` +
          `retry in ${decision.retryAfterSec}s`,
      );
    }
    return decision;
  };

  /**
   * Wraps a handler so it is charged `costOf(body)` before it runs.
   *
   * Sits between `authenticateRequest` and the real handler: by this point the
   * body is parsed and the user is verified, which is the earliest moment the
   * cost of a request can actually be known.
   */
  function withCost(
    policy: GcraPolicy,
    costOf: (body: never) => number,
    handler: (data: unknown, res: HttpResponseLike) => unknown,
  ) {
    return async function costLimited(
      data: unknown,
      response: HttpResponseLike,
      context?: RequestContext,
    ) {
      // Prefer the authenticated user: it survives a reverse proxy collapsing
      // every client onto one address, and it makes the budget follow the
      // account rather than the network path.
      const identity = context?.userId ?? context?.clientIp ?? "unknown";
      const cost = costOf(data as never);

      const decision = await chargeCost(identity, policy, cost);
      if (!decision.allowed) {
        return reject(
          response,
          decision.retryAfterSec,
          "Too much queued work requested. Try again shortly, " +
            "or submit fewer items at once.",
        );
      }

      return handler(data, response);
    };
  }

  return Object.assign(rateLimit, { chargeCost, withCost });
}
