import { config } from "../config.ts";
import { logger } from "../logger.ts";
import type { HttpRequestLike, HttpResponseLike } from "../transport/http.ts";

/**
 * Bot API key middleware.
 *
 * Wraps an existing authenticated request handler and checks for a
 * X-Bot-Key header before falling through to normal JWT auth. If the
 * header matches BOT_API_KEY, the request is treated as authenticated
 * and the handler runs directly. Otherwise, the wrapped handler
 * handles authentication as usual.
 *
 * This allows internal bot services (Discord, Telegram) to call the
 * yt-diff API without going through user JWT login.
 */

type AuthenticatedHandler = (
  req: HttpRequestLike,
  res: HttpResponseLike,
  next: (data: unknown, res: HttpResponseLike) => unknown,
) => unknown;

export function createBotAuthWrapper() {
  const botApiKey = Deno.env.get("BOT_API_KEY");

  if (!botApiKey) {
    logger.warn(
      "BOT_API_KEY not set — bot authentication will fall through to normal JWT auth",
    );
  }

  return function wrapWithBotAuth(
    authenticateRequest: AuthenticatedHandler,
  ): AuthenticatedHandler {
    return function (req: HttpRequestLike, res: HttpResponseLike, next) {
      const botKeyHeader = req.headers["x-bot-key"] as string | undefined;

      if (botApiKey && botKeyHeader && botKeyHeader === botApiKey) {
        // Bot-authenticated: skip JWT auth, pass empty data to handler
        logger.debug("Bot request authenticated via API key");
        return next({}, res);
      }

      // Fall through to normal JWT authentication
      return authenticateRequest(req, res, next);
    };
  };
}