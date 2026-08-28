import { logger } from "../logger.ts";
import { NO_MONITORING } from "./commands.ts";
import { resolveIndexedVideo } from "./deliver.ts";
import { reply, speaker } from "./replies.ts";
import type { BotRuntime } from "./runtime.ts";
import type { BotAdapter, DeliveryTarget } from "./types.ts";

/**
 * Indexes a playlist, saying so while it runs.
 *
 * Listing a playlist can take minutes and emits nothing a chat user can see,
 * so this is the one command that reports progress from the first message
 * rather than after a quiet period — silence here reads as a hung bot.
 *
 * @param monitoringType - Start/End/Full to also schedule updates, or null to
 *                         index once and leave the watch mode at "N/A"
 * @param submissionId - Submission row to settle, when the caller opened one
 */
export async function runPlaylistIndex(
  rt: BotRuntime,
  opts: {
    adapter: BotAdapter;
    target: DeliveryTarget;
    canonicalUrl: string;
    monitoringType: string | null;
    submissionId: string | null;
  },
): Promise<void> {
  const { adapter, target, canonicalUrl, monitoringType, submissionId } = opts;

  if (rt.listings.has(canonicalUrl)) {
    await reply(adapter, target, "That playlist is already being indexed.");
    return;
  }

  const queueDepth = rt.deps.getListingQueueDepth();
  const ahead = queueDepth > 0
    ? ` (${queueDepth} ahead in the listing queue)`
    : "";
  const ack = await reply(
    adapter,
    target,
    monitoringType
      ? `That's a playlist — indexing it and setting its watch mode to ${monitoringType}${ahead}. Nothing gets downloaded.`
      : `That's a playlist — indexing it${ahead}. Nothing gets downloaded; browse it with /list when it finishes.`,
  );
  const say = speaker(adapter, target, ack);

  rt.listings.set(canonicalUrl, {
    adapter,
    target,
    ack,
    // 0, not now: the first chunk to land is the first concrete sign that
    // anything is happening, so it is reported immediately and only the
    // chunks after it are throttled.
    lastProgressAt: 0,
    lastProgressText: "",
  });

  try {
    if (submissionId) {
      // playlistUrl only, never canonicalUrl: canonicalUrl is a foreign key
      // into video_metadata, and a playlist URL is never a row there, so
      // writing it violates the constraint and wedges the whole request.
      await rt.deps.store.updateSubmission(submissionId, {
        playlistUrl: canonicalUrl,
        status: "indexing",
      });
    }

    const results = await rt.deps.listItemsConcurrently(
      [{
        url: canonicalUrl,
        type: "playlist",
        currentMonitoringType: monitoringType ?? NO_MONITORING,
        reason: "Chat bot playlist index",
      }],
      rt.deps.chunkSize,
      false,
    );
    const result = results[0];
    const listed = result !== undefined &&
      (result.status === "completed" || result.status === "success");

    // A playlist that is already indexed at this watch mode lists nothing and
    // comes back as "No items found". That is not a failure worth reporting
    // as one when the playlist is sitting right there in the database, so the
    // row decides, not the listing result.
    const playlist = await rt.deps.store.findPlaylistByUrl(canonicalUrl);
    if (!listed && !playlist) {
      const detail = result?.error ?? result?.status ?? "no result";
      if (submissionId) {
        await rt.deps.store.updateSubmission(submissionId, {
          status: "failed",
          errorMessage: detail,
        });
      }
      await say(`Couldn't index that playlist: ${detail}`);
      return;
    }

    if (monitoringType) {
      try {
        await rt.deps.setPlaylistMonitoring(canonicalUrl, monitoringType);
      } catch (error) {
        logger.warn("Bot failed to set playlist monitoring", {
          url: canonicalUrl,
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    }

    // Re-read: the count and title only exist once listing has written them,
    // and setPlaylistMonitoring may just have changed the watch mode.
    const summary = await rt.deps.store.findPlaylistByUrl(canonicalUrl) ??
      playlist;
    const count = summary?.videoCount ?? 0;

    if (submissionId) {
      await rt.deps.store.updateSubmission(submissionId, { status: "indexed" });
    }

    await say([
      `Indexed: ${summary?.title || "playlist"}`,
      `${count} ${count === 1 ? "entry" : "entries"} · watch mode: ${
        monitoringType ?? summary?.monitoringType ?? NO_MONITORING
      }`,
      "",
      `Browse it:  /list ${canonicalUrl}`,
      "Then /get <video-link> for anything you want downloaded.",
    ].join("\n"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown error";
    if (submissionId) {
      await rt.deps.store.updateSubmission(submissionId, {
        status: "failed",
        errorMessage: detail,
      });
    }
    await say(`Couldn't index that playlist: ${detail}`);
  } finally {
    rt.listings.delete(canonicalUrl);
  }
}

/**
 * Catalogues a link without downloading it.
 *
 * A playlist goes through runPlaylistIndex, with or without monitoring. A
 * single video is indexed into the "None" pseudo playlist — it becomes
 * searchable and can be fetched later with /get.
 */
export async function handleIndex(
  rt: BotRuntime,
  adapter: BotAdapter,
  target: DeliveryTarget,
  url: string,
  monitoringType: string | null,
) {
  const canonicalUrl = rt.deps.normalizeUrl(url);
  // Asking for monitoring is itself a claim that the link is a playlist —
  // that is the only thing monitoring applies to — so it is honoured even
  // when the URL does not match the playlist pattern.
  if (rt.deps.isPlaylistUrl(canonicalUrl) || monitoringType) {
    await runPlaylistIndex(rt, {
      adapter,
      target,
      canonicalUrl,
      monitoringType,
      submissionId: null,
    });
    return;
  }

  const ack = await reply(adapter, target, "Indexing…");
  const say = speaker(adapter, target, ack);

  try {
    const results = await rt.deps.listItemsConcurrently(
      [{
        url: canonicalUrl,
        // Let executeListing classify it, including the x.com exception.
        type: "undetermined",
        currentMonitoringType: NO_MONITORING,
        reason: "Chat bot /index",
      }],
      rt.deps.chunkSize,
      false,
    );
    const result = results[0];
    if (
      !result ||
      (result.status !== "completed" && result.status !== "success")
    ) {
      await say(
        `Couldn't index that link: ${
          result?.error ?? result?.status ?? "no result"
        }`,
      );
      return;
    }

    const indexed = await resolveIndexedVideo(rt, canonicalUrl);
    await say(
      indexed
        ? `Indexed: ${indexed.title}\nUse /get to download it.`
        : "Indexed. Use /get to download it.",
    );
  } catch (error) {
    await say(
      `Couldn't index that link: ${
        error instanceof Error ? error.message : "unknown error"
      }`,
    );
  }
}
