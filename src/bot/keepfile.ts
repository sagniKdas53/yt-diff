import { logger } from "../logger.ts";
import type { HttpResponseLike } from "../transport/http.ts";
import { json } from "../utils/http.ts";
import { type BotStore, createSequelizeBotStore } from "./store.ts";

/** The one thing `/keepfile` needs from the database. */
export type KeepFileStore = Pick<BotStore, "keepSubmissionsByUrl">;

/**
 * `POST /keepfile` — the web UI's version of `/keep`.
 *
 * The bot's own command is scoped to the chat it was asked in, because a chat
 * is the only thing it knows a user by. The UI has no such boundary: a row on
 * screen is a row the reader is looking at, and "Keep" on it means that file
 * stops being reaped. The update itself is `BotStore`'s, not this handler's, so
 * the two entry points cannot drift on what "kept" means.
 *
 * @param store - Injectable so the endpoint can be tested without a database;
 *   production passes nothing and gets the Sequelize-backed store.
 */
export async function processKeepFileRequest(
  requestBody: { videoUrl: string },
  response: HttpResponseLike,
  store: KeepFileStore = createSequelizeBotStore(),
): Promise<void> {
  try {
    const kept = await store.keepSubmissionsByUrl(requestBody.videoUrl);

    json(response, 200, {
      status: "success" as const,
      // A count rather than a bare success: the chip this clears is only there
      // for files the bot fetched, so "nothing was kept" is a real answer the
      // caller may want to say out loud.
      kept,
    });
  } catch (error) {
    logger.error("Keep request failed", {
      videoUrl: requestBody.videoUrl,
      error: (error as Error).message,
    });
    json(response, 500, {
      error: "Could not keep that file.",
    });
  }
}
