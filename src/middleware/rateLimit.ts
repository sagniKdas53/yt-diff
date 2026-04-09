import type Redis from "ioredis";

import { logger } from "../logger.ts";
import type {
  HttpRequestLike,
  HttpResponseLike,
} from "../transport/http.ts";

type GenerateCorsHeaders = (
  contentType: string,
) => Record<string, string | number>;
export type MiddlewareNext = (data: unknown, res: HttpResponseLike) => void;
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

export interface RateLimitFunction {
  (
    request: HttpRequestLike,
    response: HttpResponseLike,
    currentHandler: MiddlewareHandler,
    nextHandler: NextHandler,
    maxRequestsPerWindow: number,
    windowSeconds: number,
  ): Promise<unknown>;
  (
    request: HttpRequestLike,
    response: HttpResponseLike,
    currentHandler: RequestHandler,
    nextHandler: RequestHandler,
    maxRequestsPerWindow: number,
    windowSeconds: number,
  ): Promise<unknown>;
}

interface RateLimitDependencies {
  redis: Redis;
  generateCorsHeaders: GenerateCorsHeaders;
  jsonMimeType: string;
}

export function createRateLimit({
  redis,
  generateCorsHeaders,
  jsonMimeType,
}: RateLimitDependencies) {
  const rateLimit: RateLimitFunction = async function rateLimit(
    request: HttpRequestLike,
    response: HttpResponseLike,
    currentHandler: MiddlewareHandler | RequestHandler,
    nextHandler: NextHandler | RequestHandler,
    maxRequestsPerWindow: number,
    windowSeconds: number,
  ) {
    const clientIp = request.socket.remoteAddress;
    logger.trace(`Rate limit check for IP ${clientIp}`);

    if (maxRequestsPerWindow === 0) {
      logger.debug("Rate limiting disabled (maxRequestsPerWindow is 0)");
      if (currentHandler.length >= 3) {
        return (currentHandler as MiddlewareHandler)(
          request,
          response,
          nextHandler as MiddlewareNext,
        );
      }

      return (currentHandler as RequestHandler)(request, response);
    }

    const currentRequests = Number((await redis.get(`ip:${clientIp}`)) ?? 0);

    if (currentRequests >= maxRequestsPerWindow) {
      logger.debug(`Rate limit exceeded for ${clientIp}`);
      response.writeHead(429, generateCorsHeaders(jsonMimeType));
      return response.end(JSON.stringify({
        status: "error",
        message: "Too many requests",
      }));
    }

    await redis.set(`ip:${clientIp}`, currentRequests + 1, "EX", windowSeconds);

    logger.debug(`Request count for ${clientIp}: ${currentRequests + 1}`);
    if (currentHandler.length >= 3) {
      return (currentHandler as MiddlewareHandler)(
        request,
        response,
        nextHandler as MiddlewareNext,
      );
    }

    return (currentHandler as RequestHandler)(request, response);
  };

  return rateLimit;
}
