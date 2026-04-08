import type { IncomingMessage, ServerResponse } from "node:http";

import type Redis from "ioredis";

import { logger } from "../logger.ts";

type GenerateCorsHeaders = (
  contentType: string,
) => Record<string, string | number>;
type MiddlewareHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  next: (data: any, res: ServerResponse) => void,
) => unknown;
type NextHandler = (data: any, res: ServerResponse) => unknown;

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
  return async function rateLimit(
    request: IncomingMessage,
    response: ServerResponse,
    currentHandler: MiddlewareHandler,
    nextHandler: NextHandler,
    maxRequestsPerWindow: number,
    windowSeconds: number,
  ) {
    const clientIp = request.socket.remoteAddress;
    logger.trace(`Rate limit check for IP ${clientIp}`);

    if (maxRequestsPerWindow === 0) {
      logger.debug("Rate limiting disabled (maxRequestsPerWindow is 0)");
      return currentHandler(request, response, nextHandler);
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
    return currentHandler(request, response, nextHandler);
  };
}
