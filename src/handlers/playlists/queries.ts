import he from "he";
import { FindAndCountOptions, Op, Order, WhereOptions } from "sequelize";
import { config } from "../../config.ts";
import {
  BotSubmission,
  PlaylistMetadata,
  PlaylistVideoMapping,
  VideoMetadata,
} from "../../db/models.ts";
import { logger } from "../../logger.ts";
import type { HttpResponseLike } from "../../transport/http.ts";
import type {
  HttpError,
  PlaylistDisplayRequest,
  PlaylistHandlerDependencies,
  PlaylistWhereShape,
  SafePlaylistVideoMeta,
  SafePlaylistVideoRow,
  SubListRequest,
} from "./types.ts";
import { json } from "../../utils/http.ts";

/**
 * The submissions that put a clock on a video, narrowed to one page's URLs.
 *
 * These are the reaper's own three conditions, not a looser reading of them:
 * a row the reaper would ignore must never show a countdown, or the UI would
 * warn about a reaping that is not going to happen.
 */
export function buildBotExpiryWhere(videoUrls: string[]): WhereOptions {
  return {
    canonicalUrl: { [Op.in]: videoUrls },
    status: "delivered",
    downloadedByBot: true,
    expiresAt: { [Op.ne]: null },
  };
}

/**
 * When the reaper will take each of these files, if it will.
 *
 * The earliest clock wins. A file can be asked for more than once — two chats,
 * or the same chat twice — and each request writes its own `expiresAt`; the
 * one that actually decides when the file goes is the soonest of them, so
 * showing a longer one would have the UI counting down to a reaping that is
 * not going to happen when the user expects.
 */
async function findBotExpiries(
  videoUrls: string[],
): Promise<Map<string, Date>> {
  const earliest = new Map<string, Date>();
  if (videoUrls.length === 0) {
    return earliest;
  }

  const rows = await BotSubmission.findAll({
    attributes: ["canonicalUrl", "expiresAt"],
    where: buildBotExpiryWhere(videoUrls),
    order: [["expiresAt", "ASC"]],
  });

  for (const row of rows) {
    const canonicalUrl = row.getDataValue("canonicalUrl") as string | null;
    const expiresAt = row.getDataValue("expiresAt") as Date | null;
    if (canonicalUrl && expiresAt && !earliest.has(canonicalUrl)) {
      earliest.set(canonicalUrl, expiresAt);
    }
  }

  return earliest;
}

export function createQueryHandlers(_deps: PlaylistHandlerDependencies) {
  async function getPlaylistsForDisplay(
    requestBody: PlaylistDisplayRequest,
    response: HttpResponseLike,
  ): Promise<void> {
    try {
      const startIndex = requestBody.start !== undefined
        ? +requestBody.start
        : 0;
      const pageSize = requestBody.stop !== undefined
        ? +requestBody.stop - startIndex
        : config.chunkSize;
      const sortColumn = requestBody.sort !== undefined ? +requestBody.sort : 1;
      const sortOrder = requestBody.order !== undefined
        ? +requestBody.order
        : 1;
      const searchQuery = requestBody.query !== undefined
        ? requestBody.query
        : "";

      const sortDirection = sortOrder === 2 ? "DESC" : "ASC";
      // sortOrder is the stable display order. createdAt can collide for
      // adjacent inserts, so it is not a safe substitute for playlist listing.
      const sortBy = sortColumn === 3 ? "lastUpdatedByScheduler" : "sortOrder";

      logger.trace(
        `Fetching playlists for display`,
        {
          startIndex,
          pageSize,
          sortBy,
          sortDirection,
          searchQuery,
        },
      );

      const playlistWhere: PlaylistWhereShape = {
        sortOrder: {
          [Op.gte]: 0,
        },
      };

      const queryOptions: FindAndCountOptions = {
        where: playlistWhere as unknown as WhereOptions,
        limit: pageSize,
        offset: startIndex,
        order: [[sortBy, sortDirection]],
      };

      if (searchQuery && searchQuery.length > 0) {
        if (searchQuery.startsWith("url:")) {
          if (searchQuery.slice(4).length > 0) {
            playlistWhere.playlistUrl = {
              [Op.iLike]: `%${searchQuery.slice(4)}%`,
            };
          } else {
            logger.debug("No url provided", { searchQuery });
          }
        } else if (searchQuery.startsWith("title:")) {
          const titleSearch = searchQuery.slice(6);
          if (titleSearch.length > 0) {
            playlistWhere.title = {
              [Op.iRegexp]: titleSearch,
            };
          } else {
            logger.debug("No title provided", { searchQuery });
          }
        } else {
          playlistWhere.title = {
            [Op.iLike]: `%${searchQuery}%`,
          };
        }
      }

      const results = await PlaylistMetadata.findAndCountAll(queryOptions);

      json(response, 200, results);
    } catch (error) {
      logger.error("Failed to fetch playlists", {
        error: (error as Error).message,
        stack: (error as Error).stack,
      });

      const statusCode = (error as HttpError).status || 500;
      json(response, statusCode, {
        error: he.escape((error as Error).message),
      });
    }
  }

  async function getSubListVideos(
    requestBody: SubListRequest,
    response: HttpResponseLike,
  ): Promise<void> {
    try {
      const playlistUrl = requestBody.url ?? "None";
      const startIndex = Math.max(0, +(requestBody.start ?? 0));
      const endIndex = +(requestBody.stop ?? config.chunkSize);
      const searchQuery = requestBody.query ?? "";
      const sortByDownloaded = requestBody.sortDownloaded ?? false;

      // Downloaded-first mode sorts by VideoMetadata.downloadStatus DESC.
      // Default mode preserves playlist order via positionInPlaylist ASC.
      const sortOrder: Order = sortByDownloaded
        ? [[VideoMetadata, "downloadStatus", "DESC"], [
          "positionInPlaylist",
          "ASC",
        ]]
        : [["positionInPlaylist", "ASC"]];

      logger.trace("Fetching playlist videos", {
        startIndex,
        endIndex,
        searchQuery,
        sortBy: sortByDownloaded ? "downloadStatus" : "positionInPlaylist",
        sortDirection: sortByDownloaded ? "DESC" : "ASC",
        playlistUrl,
      });

      const videoMetadataWhere: WhereOptions = {};
      const mappingWhere: WhereOptions = {
        playlistUrl: playlistUrl,
      };

      if (searchQuery && searchQuery.length > 0) {
        if (searchQuery.startsWith("url:")) {
          const urlSearch = searchQuery.slice(4);
          if (urlSearch.length > 0) {
            videoMetadataWhere.videoUrl = {
              [Op.iLike]: `%${urlSearch}%`,
            };
          } else {
            logger.debug(
              "No url provided for sublist query, despite using url: prefix",
              { searchQuery },
            );
          }
        } else if (searchQuery.startsWith("title:")) {
          const titleSearch = searchQuery.slice(6);
          if (titleSearch.length > 0) {
            videoMetadataWhere.title = {
              [Op.iRegexp]: titleSearch,
            };
          } else {
            logger.debug(
              "No title provided for sublist query, despite using title: prefix",
              { searchQuery },
            );
          }
        } else if (searchQuery.startsWith("global:")) {
          const globalSearch = searchQuery.slice(7);
          if (playlistUrl === "init" || playlistUrl === "None") {
            delete mappingWhere.playlistUrl;
          }
          if (globalSearch.length > 0) {
            videoMetadataWhere.title = {
              [Op.iRegexp]: globalSearch,
            };
          } else if (playlistUrl === "init" || playlistUrl === "None") {
            logger.debug(
              "No regex provided for global sublist query, returning all videos",
              { searchQuery },
            );
          } else {
            logger.debug(
              "No regex provided for scoped global sublist query",
              { searchQuery },
            );
          }
        } else {
          videoMetadataWhere.title = {
            [Op.iLike]: `%${searchQuery}%`,
          };
        }
      }

      const queryOptions: FindAndCountOptions = {
        attributes: ["id", "positionInPlaylist", "playlistUrl"],
        include: [{
          model: VideoMetadata,
          attributes: [
            "title",
            "videoId",
            "videoUrl",
            "downloadStatus",
            "isAvailable",
            "fileName",
            "thumbNailFile",
            "onlineThumbnail",
            "subTitleFile",
            "descriptionFile",
            "commentsFile",
            "chapters",
            "isMetaDataSynced",
            "saveDirectory",
            "missingExtras",
            "lastDownloadError",
          ],
          where: videoMetadataWhere,
          required: !!(searchQuery && searchQuery.length > 0),
        }],
        where: mappingWhere,
        limit: endIndex - startIndex,
        offset: startIndex,
        order: sortOrder,
      };

      const results = await PlaylistVideoMapping.findAndCountAll(queryOptions);

      // One query for the whole page, not one per row: the expiry chip is a
      // label, and paging a playlist should not cost N extra round trips to
      // draw it. The filter is the reaper's own (`buildExpiredSubmissionWhere`
      // selects the same three things), so a row the reaper would ignore can
      // never carry a clock the UI would count down.
      const pageVideoUrls = results.rows
        .map((row) => row.video_metadatum?.videoUrl)
        .filter((url): url is string => typeof url === "string" && !!url);
      const expiryByUrl = await findBotExpiries(pageVideoUrls);

      let playlistSaveDir = "";
      let playlistTitle: string | null = null;
      try {
        const playlist = await PlaylistMetadata.findOne({
          where: { playlistUrl },
        });

        playlistSaveDir = playlist?.saveDirectory ?? "";
        playlistTitle = playlist?.title ?? null;
      } catch (err) {
        logger.warn("Could not fetch playlist details", {
          playlistUrl,
          error: (err as Error).message,
        });
      }

      const safeRows: SafePlaylistVideoRow[] = results.rows.map((row) => {
        const vm = row.video_metadatum;
        const safeVideoMeta: SafePlaylistVideoMeta = {
          title: vm?.title,
          videoId: vm?.videoId,
          videoUrl: vm?.videoUrl,
          downloadStatus: vm?.downloadStatus,
          isAvailable: vm?.isAvailable,
          fileName: vm?.fileName,
          thumbNailFile: vm?.thumbNailFile,
          onlineThumbnail: vm?.onlineThumbnail,
          subTitleFile: vm?.subTitleFile,
          commentsFile: vm?.commentsFile,
          chapters: vm?.chapters ?? null,
          descriptionFile: vm?.descriptionFile,
          isMetaDataSynced: vm?.isMetaDataSynced,
          saveDirectory: vm?.saveDirectory,
          missingExtras: vm?.missingExtras ?? null,
          lastDownloadError: vm?.lastDownloadError ?? null,
          botExpiresAt: vm?.videoUrl
            ? expiryByUrl.get(vm.videoUrl) ?? null
            : null,
        };

        return {
          id: row.id,
          positionInPlaylist: row.positionInPlaylist,
          playlistUrl: row.playlistUrl,
          video_metadatum: safeVideoMeta,
        };
      });

      const safeResult = {
        count: results.count,
        rows: safeRows,
        saveDirectory: playlistSaveDir,
        playlistTitle,
      };

      json(response, 200, safeResult);
    } catch (error) {
      logger.error("Failed to fetch playlist videos", {
        error: (error as Error).message,
        stack: (error as Error).stack,
      });

      const statusCode = (error as HttpError).status || 500;
      json(response, statusCode, {
        error: he.escape((error as Error).message),
      });
    }
  }

  return { getPlaylistsForDisplay, getSubListVideos };
}
