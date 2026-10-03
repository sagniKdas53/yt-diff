import type {
  CancelOutcome,
  SyncExtrasResult,
} from "../handlers/pipeline/types.ts";
import { isHttpUrl } from "../utils/url.ts";
import { resolveIndexedVideo } from "./deliver.ts";
import { reply, speaker } from "./replies.ts";
import { type BotRuntime, pendingCountForChat } from "./runtime.ts";
import type { BotAdapter, DeliveryTarget } from "./types.ts";

export async function handleStatus(
  rt: BotRuntime,
  adapter: BotAdapter,
  target: DeliveryTarget,
) {
  const snapshot = rt.deps.getQueueSnapshot();
  if (snapshot.length === 0) {
    await reply(adapter, target, "Queue is empty.");
    return;
  }
  const lines = snapshot.map((item) =>
    `${item.queuePosition}. ${item.title || item.url} — ${item.status}`
  );
  await reply(adapter, target, lines.join("\n"));
}

export async function handleHistory(
  rt: BotRuntime,
  adapter: BotAdapter,
  target: DeliveryTarget,
  limit: number,
) {
  const rows = await rt.deps.store.listSubmissions(target.chatId, limit);

  if (rows.length === 0) {
    await reply(adapter, target, "No submissions yet.");
    return;
  }

  const lines = rows.map((row) =>
    `${row.id.slice(0, 8)}  ${row.status}\n${
      row.canonicalUrl ?? row.requestedUrl
    }`
  );
  await reply(
    adapter,
    target,
    `${
      lines.join("\n\n")
    }\n\nThe code on each first line is the <id> for /keep and /rm.`,
  );
}

/**
 * Keeps a file off the reaper.
 *
 * `target` is either the short id from /history or the link itself. The URL
 * form updates every submission of that link in the calling chat — the same
 * update the web UI's `/keepfile` performs, through the same store method —
 * and reports how many rows it touched, because a URL the bot never fetched
 * is a much more likely user mistake than a mistyped id.
 */
export async function handleKeep(
  rt: BotRuntime,
  adapter: BotAdapter,
  target: DeliveryTarget,
  argument: string,
) {
  if (isHttpUrl(argument)) {
    const kept = await rt.deps.store.keepSubmissionsByUrl(
      rt.deps.normalizeUrl(argument),
      target.chatId,
    );
    await reply(
      adapter,
      target,
      kept === 0
        ? "I never downloaded that link."
        : kept === 1
        ? "Kept — the reaper will leave that one alone."
        : `Kept ${kept} — the reaper will leave those alone.`,
    );
    return;
  }

  const submission = await rt.deps.store.findSubmissionByPrefix(
    target.chatId,
    argument,
  );
  if (!submission) {
    await reply(adapter, target, "No single submission matches that id.");
    return;
  }
  await rt.deps.store.updateSubmission(submission.id, {
    retention: "persistent",
    expiresAt: null,
  });
  await reply(
    adapter,
    target,
    "Kept — the reaper will leave that one alone.",
  );
}

/**
 * Deletes a file's files now.
 *
 * A URL removes the file itself, so every submission of it in this chat is
 * marked reaped — one link can have been asked for several times, and rows
 * left reading "delivered" over a file that no longer exists are how the
 * history stops being worth reading.
 */
export async function handleRemove(
  rt: BotRuntime,
  adapter: BotAdapter,
  target: DeliveryTarget,
  argument: string,
) {
  if (isHttpUrl(argument)) {
    const canonicalUrl = rt.deps.normalizeUrl(argument);
    const purged = await rt.deps.store.purgeVideoFiles(canonicalUrl);
    if (!purged) {
      await reply(adapter, target, "Some files could not be removed.");
      return;
    }
    await rt.deps.store.markSubmissionsReapedByUrl(canonicalUrl, target.chatId);
    await reply(adapter, target, "Removed.");
    return;
  }

  const submission = await rt.deps.store.findSubmissionByPrefix(
    target.chatId,
    argument,
  );
  if (!submission) {
    await reply(adapter, target, "No single submission matches that id.");
    return;
  }
  if (!submission.canonicalUrl) {
    await reply(adapter, target, "That submission has no file to remove.");
    return;
  }

  const purged = await rt.deps.store.purgeVideoFiles(submission.canonicalUrl);
  if (!purged) {
    await reply(adapter, target, "Some files could not be removed.");
    return;
  }

  await rt.deps.store.updateSubmission(submission.id, { status: "reaped" });
  await reply(adapter, target, "Removed.");
}

/**
 * Stops a download or a playlist listing that is already under way.
 *
 * The argument is the /history code or the link, as for /keep. Which of the
 * two maps the URL lands in decides what gets stopped, and the reply says
 * which — a command that answered "cancelled" for something it had never
 * heard of would be indistinguishable from one that worked.
 */
export async function handleCancel(
  rt: BotRuntime,
  adapter: BotAdapter,
  target: DeliveryTarget,
  argument: string,
) {
  let requested: string;
  if (isHttpUrl(argument)) {
    requested = rt.deps.normalizeUrl(argument);
  } else {
    const submission = await rt.deps.store.findSubmissionByPrefix(
      target.chatId,
      argument,
    );
    if (!submission) {
      await reply(adapter, target, "No single submission matches that id.");
      return;
    }
    if (!submission.canonicalUrl) {
      await reply(
        adapter,
        target,
        "That submission has no URL to cancel — it never got as far as one.",
      );
      return;
    }
    requested = submission.canonicalUrl;
  }

  // The bot's own maps are keyed by the same canonical URL the pipeline uses,
  // and are what make the reply specific: a download the bot is not waiting
  // on is not something it should claim to have stopped.
  if (rt.pending.has(requested)) {
    const outcome = rt.deps.cancelDownload(requested);
    await reply(adapter, target, cancelWording(outcome, "download"));
    return;
  }
  if (rt.listings.has(requested)) {
    const outcome = rt.deps.cancelListing(requested);
    await reply(adapter, target, cancelWording(outcome, "listing"));
    return;
  }

  await reply(
    adapter,
    target,
    "Nothing of yours is running for that — it may already be finished.",
  );
}

/** How a cancel outcome reads to the user who asked for it. */
function cancelWording(
  outcome: CancelOutcome,
  kind: "download" | "listing",
) {
  const noun = kind === "download" ? "Download" : "Listing";
  if (outcome === "killed") {
    return `${noun} stopped.${
      kind === "listing" ? " Whatever it had indexed so far is kept." : ""
    }`;
  }
  if (outcome === "queued") {
    return "It had not started yet — dropped from the queue.";
  }
  return "Nothing was running for that.";
}

/**
 * Shows one page of a playlist's entries, in playlist order.
 *
 * Indexing a playlist otherwise leaves the user with no way to see what it
 * produced from chat, which makes /get on an individual entry unusable.
 */
export async function handleList(
  rt: BotRuntime,
  adapter: BotAdapter,
  target: DeliveryTarget,
  url: string,
  start: number,
  limit: number,
) {
  const playlistUrl = rt.deps.normalizeUrl(url);
  const playlist = await rt.deps.store.findPlaylistByUrl(playlistUrl);
  if (!playlist) {
    await reply(
      adapter,
      target,
      `I haven't indexed that playlist. Send me the link, or /index it, first.`,
    );
    return;
  }

  const { total, items } = await rt.deps.store.listPlaylistVideos(
    playlistUrl,
    start,
    limit,
  );

  if (items.length === 0) {
    await reply(
      adapter,
      target,
      total === 0
        ? `${playlist.title} has no entries yet.`
        : `Nothing at ${start} — ${playlist.title} has ${total} ${
          total === 1 ? "entry" : "entries"
        }, so start has to be below ${total}.`,
    );
    return;
  }

  const lines = items.map((item) =>
    `${item.position}. ${
      item.downloadStatus ? "[saved]" : "[not downloaded]"
    } ${item.title}\n${item.videoUrl}`
  );
  const shownTo = start + items.length;
  const more = shownTo < total
    ? `\n\nNext: /list ${playlistUrl} ${shownTo} ${limit}`
    : "";

  await reply(
    adapter,
    target,
    `${playlist.title} — showing ${
      start + 1
    }-${shownTo} of ${total} (watch: ${playlist.monitoringType})\n\n${
      lines.join("\n\n")
    }${more}`,
  );
}

/** Lists the playlists the bot knows about, so /list has a starting point. */
export async function handlePlaylists(
  rt: BotRuntime,
  adapter: BotAdapter,
  target: DeliveryTarget,
  limit: number,
) {
  const rows = await rt.deps.store.listPlaylists(limit);
  if (rows.length === 0) {
    await reply(
      adapter,
      target,
      "No playlists indexed yet. Send me a playlist link to index one.",
    );
    return;
  }

  const lines = rows.map((row) =>
    `${row.title} — ${row.videoCount} ${
      row.videoCount === 1 ? "entry" : "entries"
    } (watch: ${row.monitoringType})\n${row.playlistUrl}`
  );
  await reply(
    adapter,
    target,
    `${
      lines.join("\n\n")
    }\n\nBrowse one with /list <playlist-link> [start] [count].`,
  );
}

export async function handleSearch(
  rt: BotRuntime,
  adapter: BotAdapter,
  target: DeliveryTarget,
  query: string,
  limit: number,
) {
  const rows = await rt.deps.store.searchVideos(query, limit);
  if (rows.length === 0) {
    await reply(adapter, target, `Nothing indexed matching "${query}".`);
    return;
  }

  const lines = rows.map((row) => {
    const mark = row.downloadStatus ? "[saved]" : "[not downloaded]";
    return `${mark} ${row.title}\n${row.videoUrl}`;
  });
  await reply(adapter, target, lines.join("\n\n"));
}

/**
 * Fetches the sidecars a partial download left out.
 *
 * The argument is either the short id from /history or the link itself, and
 * both end up as the canonical video URL the pipeline stores: `syncExtras`
 * looks the row up by `videoUrl`, so passing anything else would silently
 * report "unchanged" against nothing. A URL the bot has never indexed says so
 * rather than guessing at a row.
 */
export async function handleSync(
  rt: BotRuntime,
  adapter: BotAdapter,
  target: DeliveryTarget,
  argument: string,
) {
  // Same backpressure as /get: an extras fetch is a yt-dlp run, and the
  // per-chat cap exists so one chat cannot occupy the whole pipeline.
  if (pendingCountForChat(rt, target.chatId) >= rt.deps.maxPendingPerChat) {
    await reply(
      adapter,
      target,
      "You already have the maximum number of requests in flight. Wait for one to finish.",
    );
    return;
  }

  let requested: string;
  if (isHttpUrl(argument)) {
    requested = rt.deps.normalizeUrl(argument);
  } else {
    const submission = await rt.deps.store.findSubmissionByPrefix(
      target.chatId,
      argument,
    );
    if (!submission) {
      await reply(adapter, target, "No single submission matches that id.");
      return;
    }
    if (!submission.canonicalUrl) {
      await reply(
        adapter,
        target,
        "That submission has no video yet — /sync needs one indexed.",
      );
      return;
    }
    requested = submission.canonicalUrl;
  }

  const indexed = await resolveIndexedVideo(rt, requested);
  if (!indexed) {
    await reply(
      adapter,
      target,
      `I haven't indexed that one. Send me the link${
        isHttpUrl(argument) ? "" : " for that submission"
      } and I'll fetch it, then /sync will do the rest.`,
    );
    return;
  }

  // Edited in place rather than sent twice: an extras fetch can take as long
  // as the download did, and the user only wants the outcome.
  const say = speaker(
    adapter,
    target,
    await reply(adapter, target, "Fetching the missing extras…"),
  );

  let result: SyncExtrasResult;
  try {
    result = await rt.deps.syncExtras(indexed.videoUrl);
  } catch (error) {
    await say(
      `Couldn't fetch the extras: ${
        error instanceof Error ? error.message : "unknown error"
      }`,
    );
    return;
  }

  const stillMissing = result.stillMissing.length > 0
    ? `\nStill missing: ${result.stillMissing.join(", ")}.`
    : "";

  if (result.status === "failed") {
    await say(
      `Couldn't fetch the extras — ${
        result.reason === "rate-limited"
          ? "YouTube is rate-limiting this video right now. Try again later."
          : "yt-dlp failed. /sync it again once things calm down."
      }${stillMissing}`,
    );
    return;
  }

  if (result.recovered.length === 0) {
    await say(
      `Nothing new arrived${
        result.reason === "rate-limited"
          ? " — YouTube is still rate-limiting this video. Try again later."
          : "."
      }${stillMissing}`,
    );
    return;
  }

  await say(
    `Fetched ${result.recovered.join(", ")}.${
      result.stillMissing.length === 0
        ? " That's everything that was missing."
        : ""
    }${stillMissing}`,
  );
}
