import { logger } from "../../logger.ts";
import type { HttpResponseLike } from "../../transport/http.ts";
import { json } from "../../utils/http.ts";
import type { CancelOutcome } from "./types.ts";

export interface CancelRequestBody {
  url: string;
  kind: "download" | "list";
}

export interface CancelHandlers {
  cancelDownload: (url: string) => CancelOutcome;
  cancelListing: (url: string) => CancelOutcome;
}

/**
 * `POST /cancel` — stops one queued or running job.
 *
 * The outcome is the body rather than a bare 200, and it distinguishes "not
 * running" from "stopped" on purpose: a client that disabled a button is
 * asking whether the work went away, and a 200 that meant "there was nothing
 * to stop" would leave it showing a spinner over a job that finished an hour
 * ago. A cancelled playlist keeps whatever it had already indexed, so
 * `kind: "list"` is never a rollback.
 */
export function processCancelRequest(
  handlers: CancelHandlers,
  requestBody: CancelRequestBody,
  response: HttpResponseLike,
): void {
  try {
    const outcome = requestBody.kind === "download"
      ? handlers.cancelDownload(requestBody.url)
      : handlers.cancelListing(requestBody.url);

    json(response, 200, {
      status: "success" as const,
      url: requestBody.url,
      kind: requestBody.kind,
      outcome,
    });
  } catch (error) {
    logger.error("Cancel request failed", {
      url: requestBody.url,
      kind: requestBody.kind,
      error: (error as Error).message,
    });
    json(response, 500, {
      error: "Could not cancel that job.",
    });
  }
}
