import he from "he";
import { FindAndCountOptions, Op, WhereOptions } from "sequelize";
import { config } from "../../config.ts";
import { VideoMetadata, PlaylistMetadata, PlaylistVideoMapping } from "../../db/models.ts";
import { logger } from "../../logger.ts";
import type { HttpResponseLike } from "../../transport/http.ts";
import type {
  PlaylistDisplayRequest, SubListRequest, PlaylistWhereShape, SafePlaylistVideoRow, SafePlaylistVideoMeta,
  PlaylistVideoRowShape, PlaylistHandlerDependencies, HttpError
} from "./types.ts";
import { generateCorsHeaders, MIME_TYPES } from "../../utils/http.ts";

export function createQueryHandlers(_deps: PlaylistHandlerDependencies) {
  const jsonMimeType = MIME_TYPES[".json"];
  async function getPlaylistsForDisplay(
    requestBody: PlaylistDisplayRequest,
    response: HttpResponseLike,
  ): Promise<void> {
    try {
      const startIndex = requestBody.start !== undefined ? +requestBody.start : 0;
      const pageSize = requestBody.stop !== undefined
        ? +requestBody.stop - startIndex
        : config.chunkSize;
      const sortColumn = requestBody.sort !== undefined ? +requestBody.sort : 1;
      const sortOrder = requestBody.order !== undefined ? +requestBody.order : 1;
      const searchQuery = requestBody.query !== undefined
        ? requestBody.query
        : "";

      const sortDirection = sortOrder === 2 ? "DESC" : "ASC";
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

      response.writeHead(200, generateCorsHeaders(jsonMimeType));
      response.end(JSON.stringify(results));
    } catch (error) {
      logger.error("Failed to fetch playlists", {
        error: (error as Error).message,
        stack: (error as Error).stack,
      });

      const statusCode = (error as HttpError).status || 500;
      response.writeHead(statusCode, generateCorsHeaders(jsonMimeType));
      response.end(JSON.stringify({
        error: he.escape((error as Error).message),
      }));
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

      const sortOrder = sortByDownloaded
        ? [VideoMetadata, "downloadStatus", "DESC"]
        : ["positionInPlaylist", "ASC"];

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
        attributes: ["positionInPlaylist", "playlistUrl"],
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
            "isMetaDataSynced",
            "saveDirectory",
          ],
          where: videoMetadataWhere,
          required: !!(searchQuery && searchQuery.length > 0),
        }],
        where: mappingWhere,
        limit: endIndex - startIndex,
        offset: startIndex,
        order: [sortOrder as [string | typeof VideoMetadata, string, string]],
      };

      const results = await PlaylistVideoMapping.findAndCountAll(queryOptions);

      let playlistSaveDir = "";
      try {
        const playlist = await PlaylistMetadata.findOne({
          where: { playlistUrl },
        });

        playlistSaveDir =
          (playlist as unknown as { saveDirectory?: string } | null)
            ?.saveDirectory ?? "";
      } catch (err) {
        logger.warn("Could not fetch playlist saveDirectory", {
          playlistUrl,
          error: (err as Error).message,
        });
      }

      const safeRows: SafePlaylistVideoRow[] = results.rows.map((row) => {
        const typedRow = row as unknown as PlaylistVideoRowShape;
        const vm = typedRow.video_metadatum || {};
        const safeVideoMeta: SafePlaylistVideoMeta = {
          title: vm.title,
          videoId: vm.videoId,
          videoUrl: vm.videoUrl,
          downloadStatus: vm.downloadStatus,
          isAvailable: vm.isAvailable,
          fileName: vm.fileName,
          thumbNailFile: vm.thumbNailFile,
          onlineThumbnail: vm.onlineThumbnail,
          subTitleFile: vm.subTitleFile,
          descriptionFile: vm.descriptionFile,
          isMetaDataSynced: vm.isMetaDataSynced,
          saveDirectory: vm.saveDirectory,
        };

        return {
          positionInPlaylist: typedRow.positionInPlaylist,
          playlistUrl: typedRow.playlistUrl,
          video_metadatum: safeVideoMeta,
        };
      });

      const safeResult = {
        count: results.count,
        rows: safeRows,
        saveDirectory: playlistSaveDir,
      };

      response.writeHead(200, generateCorsHeaders(jsonMimeType));
      response.end(JSON.stringify(safeResult));
    } catch (error) {
      logger.error("Failed to fetch playlist videos", {
        error: (error as Error).message,
        stack: (error as Error).stack,
      });

      const statusCode = (error as HttpError).status || 500;
      response.writeHead(statusCode, generateCorsHeaders(jsonMimeType));
      response.end(JSON.stringify({
        error: he.escape((error as Error).message),
      }));
    }
  }


  return { getPlaylistsForDisplay, getSubListVideos };
}
