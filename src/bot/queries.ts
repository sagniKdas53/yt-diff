import { reply } from "./replies.ts";
import type { BotRuntime } from "./runtime.ts";
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

export async function handleKeep(
  rt: BotRuntime,
  adapter: BotAdapter,
  target: DeliveryTarget,
  idPrefix: string,
) {
  const submission = await rt.deps.store.findSubmissionByPrefix(
    target.chatId,
    idPrefix,
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

export async function handleRemove(
  rt: BotRuntime,
  adapter: BotAdapter,
  target: DeliveryTarget,
  idPrefix: string,
) {
  const submission = await rt.deps.store.findSubmissionByPrefix(
    target.chatId,
    idPrefix,
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
