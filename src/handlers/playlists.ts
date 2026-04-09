import he from "he";
import {
  FindAndCountOptions,
  Model,
  Op,
  WhereOptions,
} from "sequelize";

import { config } from "../config.ts";
import {
  PlaylistMetadata,
  PlaylistVideoMapping,
  sequelize,
  VideoMetadata,
} from "../db/models.ts";
import { logger } from "../logger.ts";
import type { HttpResponseLike } from "../transport/http.ts";
import { existsSync, rmSync, unlinkSync } from "../utils/fs.ts";
import { join } from "../utils/path.ts";

export interface PlaylistDisplayRequest {
  start?: number;
  stop?: number;
  sort?: string;
  order?: string;
  query?: string;
}

export interface SubListRequest {
  url?: string;
  start?: number;
  stop?: number;
  query?: string;
  sortDownloaded?: boolean;
}

export interface UpdatePlaylistMonitoringRequest {
  url?: string;
  watch?: string;
}

export interface DeletePlaylistRequestBody {
  playListUrl?: string;
  deleteAllVideosInPlaylist?: boolean;
  deletePlaylist?: boolean;
  cleanUp?: boolean;
}

export interface ReindexAllRequestBody {
  start?: string | number;
  stop?: string | number;
  siteFilter?: string;
  chunkSize?: string | number;
}

export interface DeleteVideosRequestBody {
  playListUrl?: string;
  videoUrls?: string[];
  cleanUp?: boolean;
  deleteVideoMappings?: boolean;
  deleteVideosInDB?: boolean;
}

interface PlaylistVideoRowShape {
  positionInPlaylist: number;
  playlistUrl: string;
  video_metadatum?: {
    title?: string;
    videoId?: string;
    videoUrl?: string;
    downloadStatus?: boolean;
    isAvailable?: boolean;
    fileName?: string | null;
    thumbNailFile?: string | null;
    onlineThumbnail?: string | null;
    subTitleFile?: string | null;
    descriptionFile?: string | null;
    isMetaDataSynced?: boolean;
    saveDirectory?: string | null;
  };
}

interface SafePlaylistVideoMeta {
  title?: string;
  videoId?: string;
  videoUrl?: string;
  downloadStatus?: boolean;
  isAvailable?: boolean;
  fileName?: string | null;
  thumbNailFile?: string | null;
  onlineThumbnail?: string | null;
  subTitleFile?: string | null;
  descriptionFile?: string | null;
  isMetaDataSynced?: boolean;
  saveDirectory?: string | null;
}

interface SafePlaylistVideoRow {
  positionInPlaylist: number;
  playlistUrl: string;
  video_metadatum: SafePlaylistVideoMeta;
}

interface PlaylistWhereShape {
  sortOrder: { [Op.gte]: number };
  playlistUrl?: { [Op.iLike]: string };
  title?: { [Op.iLike]?: string; [Op.iRegexp]?: string };
}

type HttpError = Error & { status?: number };

interface ListingItem {
  url: string;
  type: string;
  currentMonitoringType: string;
  reason: string;
  isScheduledUpdate?: boolean;
}

type GenerateCorsHeaders = (contentType: string) => Record<string, string | number>;
type ResetPendingPlaylistSortCounter = () => void;
type ListItemsConcurrently = (
  items: ListingItem[],
  chunkSize: number,
  sleep: boolean,
) => Promise<Array<{ status?: string }>>;

interface PlaylistHandlerDependencies {
  generateCorsHeaders: GenerateCorsHeaders;
  jsonMimeType: string;
  listItemsConcurrently: ListItemsConcurrently;
  resetPendingPlaylistSortCounter: ResetPendingPlaylistSortCounter;
}

export function createPlaylistHandlers({
  generateCorsHeaders,
  jsonMimeType,
  listItemsConcurrently,
  resetPendingPlaylistSortCounter,
}: PlaylistHandlerDependencies) {
  async function updatePlaylistMonitoring(
    requestBody: UpdatePlaylistMonitoringRequest,
    response: HttpResponseLike,
  ): Promise<void> {
    try {
      if (!requestBody.url || !requestBody.watch) {
        throw new Error("URL and monitoring type are required");
      }

      const playlistUrl = requestBody.url;
      const monitoringType = requestBody.watch;

      logger.trace("Updating playlist monitoring type", {
        playlistUrl,
        monitoringType,
      });

      const playlist = await PlaylistMetadata.findOne({
        where: { playlistUrl: playlistUrl },
      });

      if (!playlist) {
        throw new Error("Playlist not found");
      }

      await playlist.update(
        { monitoringType: monitoringType },
        { silent: true },
      );

      logger.debug("Successfully updated monitoring type", {
        playlistUrl,
        oldType: (playlist as any).monitoringType,
        newType: monitoringType,
      });

      response.writeHead(200, generateCorsHeaders(jsonMimeType));
      response.end(JSON.stringify({
        status: "success",
        message: "Monitoring type updated successfully",
      }));
    } catch (error) {
      logger.error("Failed to update monitoring type", {
        error: (error as Error).message,
        stack: (error as Error).stack,
      });

      const statusCode = (error as HttpError).status || 500;
      response.writeHead(statusCode, generateCorsHeaders(jsonMimeType));
      response.end(JSON.stringify({
        status: "error",
        message: he.escape((error as Error).message),
      }));
    }
  }

  async function processDeletePlaylistRequest(
    requestBody: DeletePlaylistRequestBody,
    response: HttpResponseLike,
  ) {
    try {
      logger.debug("Received playlist delete request", {
        "requestBody": JSON.stringify(requestBody),
      });

      const playListUrl = requestBody.playListUrl || "";
      const deleteAllVideosInPlaylist = requestBody.deleteAllVideosInPlaylist ||
        false;
      const deletePlaylist = requestBody.deletePlaylist || false;
      const cleanUp = requestBody.cleanUp || false;

      if (!playListUrl) {
        logger.error("Need a playListUrl", {
          "requestBody": JSON.stringify(requestBody),
        });
        response.writeHead(400, generateCorsHeaders(jsonMimeType));
        return response.end(
          JSON.stringify({ "status": "error", "message": "Need a playListUrl" }),
        );
      }
      if (playListUrl === "None") {
        logger.error("Cannot delete the default playlist", {
          "requestBody": JSON.stringify(requestBody),
        });
        response.writeHead(400, generateCorsHeaders(jsonMimeType));
        return response.end(
          JSON.stringify({
            "status": "error",
            "message": "Cannot delete the default playlist",
          }),
        );
      }

      const playlist = await PlaylistMetadata.findByPk(playListUrl) as any;
      if (!playlist) {
        logger.error("Playlist not found", {
          "requestBody": JSON.stringify(requestBody),
        });
        response.writeHead(404, generateCorsHeaders(jsonMimeType));
        return response.end(
          JSON.stringify({ "status": "error", "message": "Playlist not found" }),
        );
      }

      const transaction = await sequelize.transaction();
      try {
        let message = "";

        if (deleteAllVideosInPlaylist) {
          await PlaylistVideoMapping.destroy({
            where: { playlistUrl: playListUrl },
            transaction,
          });
          message =
            `Removed all video references from playlist ${playlist.title}`;
        }

        if (deletePlaylist) {
          const deletedSortOrder = playlist.sortOrder;
          await playlist.destroy({ transaction });
          message += message
            ? " and deleted playlist"
            : `Deleted playlist ${playlist.title}`;

          await PlaylistMetadata.decrement(
            "sortOrder",
            {
              by: 1,
              where: {
                sortOrder: { [Op.gt]: deletedSortOrder },
              },
              transaction,
            },
          );

          resetPendingPlaylistSortCounter();
          logger.debug("Updated sortOrder for playlists after deleted playlist", {
            deletedSortOrder,
          });
        }

        if (!deleteAllVideosInPlaylist && !deletePlaylist) {
          await transaction.commit();
          response.writeHead(200, generateCorsHeaders(jsonMimeType));
          return response.end(JSON.stringify({
            "status": "success",
            "message": `No deletion performed for playlist ${playlist.title}`,
            "cleanUp": false,
            "deletePlaylist": false,
            "deleteAllVideosInPlaylist": false,
          }));
        }

        if (cleanUp) {
          try {
            const playListDir = join(
              config.saveLocation,
              playlist.saveDirectory,
            );
            logger.debug("Cleaning up playlist directory", {
              saveDirectory: playlist.saveDirectory,
              absolutePath: playListDir,
            });
            rmSync(playListDir, { recursive: true, force: true });
            logger.debug("Playlist directory cleaned up", {
              saveDirectory: playlist.saveDirectory,
            });
            message += " and cleaned up playlist directory";

            try {
              const [updatedCount] = await VideoMetadata.update({
                downloadStatus: false,
                fileName: null,
                thumbNailFile: null,
                subTitleFile: null,
                commentsFile: null,
                descriptionFile: null,
                saveDirectory: null,
              }, {
                where: { saveDirectory: playlist.saveDirectory },
              });

              if (updatedCount > 0) {
                logger.info(
                  `Reset ${updatedCount} video(s) to un-downloaded state as their directory was deleted`,
                  {
                    saveDirectory: playlist.saveDirectory,
                  },
                );
                message +=
                  ` (and marked ${updatedCount} shared video(s) as un-downloaded)`;
              }
            } catch (updateError) {
              logger.error(
                "Failed to update shared video metadata after directory cleanup",
                {
                  saveDirectory: playlist.saveDirectory,
                  error: (updateError as Error).message,
                },
              );
            }
          } catch (error) {
            logger.error("Failed to clean up playlist directory", {
              saveDirectory: playlist.saveDirectory,
              error: (error as Error).message,
            });
            message += " but failed to clean up playlist directory";
          }
        }

        await transaction.commit();
        response.writeHead(200, generateCorsHeaders(jsonMimeType));
        return response.end(JSON.stringify({
          "status": "success",
          "message": message,
          "cleanUp": cleanUp,
          "deletePlaylist": deletePlaylist,
          "deleteAllVideosInPlaylist": deleteAllVideosInPlaylist,
        }));
      } catch (error) {
        await transaction.rollback();
        logger.error(
          `Playlist deletion failed with error ${(error as Error).message}`,
          {
            playListUrl,
            deleteAllVideosInPlaylist,
            deletePlaylist,
            cleanUp,
          },
        );
        response.writeHead(500, generateCorsHeaders(jsonMimeType));
        return response.end(
          JSON.stringify({
            "status": "error",
            "message": (error as Error).message,
          }),
        );
      }
    } catch (error) {
      response.writeHead(400, generateCorsHeaders(jsonMimeType));
      return response.end(
        JSON.stringify({
          "status": "error",
          "message": (error as Error).message,
        }),
      );
    }
  }

  async function processReindexAllRequest(
    requestBody: ReindexAllRequestBody,
    response: HttpResponseLike,
  ) {
    try {
      const startIndex: number = requestBody.start !== undefined
        ? Math.max(0, parseInt(String(requestBody.start), 10))
        : 0;
      const stopIndex: number | null = requestBody.stop !== undefined
        ? Math.max(startIndex, parseInt(String(requestBody.stop), 10))
        : null;
      const siteFilter: string = requestBody.siteFilter || "";
      const chunkSizeOverride: number = requestBody.chunkSize
        ? Math.max(1, parseInt(String(requestBody.chunkSize), 10))
        : config.chunkSize;

      const allPlaylists = await PlaylistMetadata.findAll({
        where: { sortOrder: { [Op.gte]: 0 } },
        order: [["sortOrder", "ASC"]],
      });

      const totalCount = allPlaylists.length;
      const subset = stopIndex !== null
        ? allPlaylists.slice(startIndex, stopIndex)
        : allPlaylists.slice(startIndex);

      const filtered = siteFilter
        ? subset.filter((p: Model) =>
          (p.getDataValue("playlistUrl") as string).includes(siteFilter)
        )
        : subset;

      if (filtered.length === 0) {
        response.writeHead(200, generateCorsHeaders(jsonMimeType));
        return response.end(
          JSON.stringify({
            status: "success",
            message: siteFilter
              ? `No playlists matching "${siteFilter}" in range [${startIndex}, ${
                stopIndex ?? totalCount
              })`
              : `No playlists in range [${startIndex}, ${
                stopIndex ?? totalCount
              })`,
            queued: 0,
            total: totalCount,
          }),
        );
      }

      const items: ListingItem[] = filtered.map((p: Model) => ({
        url: p.getDataValue("playlistUrl") as string,
        type: "playlist",
        currentMonitoringType: "Full",
        isScheduledUpdate: true,
        reason: "Batch re-index",
      }));

      response.writeHead(200, generateCorsHeaders(jsonMimeType));
      response.end(
        JSON.stringify({
          status: "success",
          message: `Queued ${items.length} playlist(s) for re-indexing`,
          queued: items.length,
          total: totalCount,
          start: startIndex,
          stop: stopIndex ?? totalCount,
          siteFilter: siteFilter || undefined,
          chunkSize: chunkSizeOverride,
        }),
      );

      void (async () => {
        try {
          logger.info("Starting batch re-index of playlists", {
            count: items.length,
            start: startIndex,
            stop: stopIndex ?? totalCount,
            siteFilter: siteFilter || "none",
            chunkSize: chunkSizeOverride,
          });
          const results = await listItemsConcurrently(
            items,
            chunkSizeOverride,
            true,
          );
          const completedCount = results.filter(
            (r: { status?: string }) =>
              r && (r.status === "completed" || r.status === "success"),
          ).length;
          logger.info("Batch re-index completed", {
            total: items.length,
            completedCount,
          });
        } catch (err) {
          logger.error("Batch re-index failed", {
            error: (err as Error).message,
            stack: (err as Error).stack,
          });
        }
      })();
    } catch (error) {
      logger.error("processReindexAllRequest failed", {
        error: (error as Error).message,
      });
      response.writeHead(500, generateCorsHeaders(jsonMimeType));
      return response.end(
        JSON.stringify({
          status: "error",
          message: (error as Error).message,
        }),
      );
    }
  }

  async function processDeleteVideosRequest(
    requestBody: DeleteVideosRequestBody,
    response: HttpResponseLike,
  ) {
    try {
      logger.debug("Received video delete request", {
        "requestBody": JSON.stringify(requestBody),
      });

      const playListUrl = requestBody.playListUrl || "";
      const videoUrls = requestBody.videoUrls || [];
      const cleanUp = requestBody.cleanUp || false;
      const deleteVideoMappings = requestBody.deleteVideoMappings || false;
      const deleteVideosInDB = requestBody.deleteVideosInDB || false;

      if (!playListUrl) {
        logger.error("Need a playListUrl", {
          "requestBody": JSON.stringify(requestBody),
        });
        response.writeHead(400, generateCorsHeaders(jsonMimeType));
        return response.end(
          JSON.stringify({ "status": "error", "message": "Need a playListUrl" }),
        );
      }

      if (!Array.isArray(videoUrls)) {
        logger.error("videoUrls must be an array", {
          "requestBody": JSON.stringify(requestBody),
        });
        response.writeHead(400, generateCorsHeaders(jsonMimeType));
        return response.end(
          JSON.stringify({
            "status": "error",
            "message": "videoUrls must be an array",
          }),
        );
      }

      if (videoUrls.length === 0) {
        logger.error("videoUrls array cannot be empty", {
          "requestBody": JSON.stringify(requestBody),
        });
        response.writeHead(400, generateCorsHeaders(jsonMimeType));
        return response.end(
          JSON.stringify({
            "status": "error",
            "message": "videoUrls array cannot be empty",
          }),
        );
      }

      const playlist = await PlaylistMetadata.findByPk(playListUrl);
      if (!playlist) {
        logger.error("Playlist not found", {
          "requestBody": JSON.stringify(requestBody),
        });
        response.writeHead(404, generateCorsHeaders(jsonMimeType));
        return response.end(
          JSON.stringify({ "status": "error", "message": "Playlist not found" }),
        );
      }

      const transaction = await sequelize.transaction();
      try {
        const deleted = [];
        const failed = [];

        const videos = await VideoMetadata.findAll({
          where: { videoUrl: { [Op.in]: videoUrls } },
          transaction,
        });

        const videoUrlsToDestroy = [];
        const videoUrlsToReset = [];
        const videoUrlsToDeleteMapping = [];

        for (const videoUrl of videoUrls) {
          try {
            const video = videos.find((v: any) =>
              v.getDataValue("videoUrl") === videoUrl
            ) as any;

            if (!video) {
              logger.warn("Video not found", { videoUrl });
              failed.push({ videoUrl, reason: "Video not found" });
              continue;
            }

            let allFilesRemoved = true;

            if (cleanUp && video.getDataValue("downloadStatus")) {
              const filesToRemove: Record<string, string | null> = {
                "fileName": video.getDataValue("fileName"),
                "thumbNailFile": video.getDataValue("thumbNailFile"),
                "subTitleFile": video.getDataValue("subTitleFile"),
                "commentsFile": video.getDataValue("commentsFile"),
                "descriptionFile": video.getDataValue("descriptionFile"),
              };

              logger.debug("Removing files for video", {
                videoUrl,
                filesToRemove: JSON.stringify(filesToRemove),
              });

              for (const [key, value] of Object.entries(filesToRemove)) {
                if (value) {
                  try {
                    const filePath = join(
                      config.saveLocation,
                      video.getDataValue("saveDirectory") || "",
                      value,
                    );
                    logger.debug("Removing file", {
                      videoUrl,
                      key,
                      value,
                      filePath,
                    });
                    if (existsSync(filePath)) {
                      unlinkSync(filePath);
                      logger.debug("Removed file", {
                        videoUrl,
                        key,
                        value,
                        filePath,
                      });
                    } else {
                      logger.warn("File to remove not found", {
                        videoUrl,
                        key,
                        value,
                        filePath,
                      });
                    }
                  } catch (error) {
                    logger.error("Failed to remove file", {
                      videoUrl,
                      key,
                      value,
                      error: (error as Error).message,
                    });
                    allFilesRemoved = false;
                  }
                }
              }
            }

            if (allFilesRemoved || !cleanUp) {
              if (deleteVideosInDB) {
                videoUrlsToDestroy.push(videoUrl);
              } else {
                if (cleanUp && allFilesRemoved) {
                  videoUrlsToReset.push(videoUrl);
                }
                if (deleteVideoMappings) {
                  videoUrlsToDeleteMapping.push(videoUrl);
                }
              }
              deleted.push(videoUrl);
            } else {
              failed.push({
                videoUrl,
                reason: "Some files could not be removed",
              });
            }
          } catch (error) {
            logger.error("Failed to process video", {
              videoUrl,
              error: (error as Error).message,
            });
            failed.push({ videoUrl, reason: (error as Error).message });
          }
        }

        if (videoUrlsToDestroy.length > 0) {
          await VideoMetadata.destroy({
            where: { videoUrl: { [Op.in]: videoUrlsToDestroy } },
            transaction,
          });
        }

        if (videoUrlsToReset.length > 0) {
          await VideoMetadata.update({
            downloadStatus: false,
            fileName: null,
            thumbNailFile: null,
            subTitleFile: null,
            commentsFile: null,
            descriptionFile: null,
            saveDirectory: null,
          }, {
            where: { videoUrl: { [Op.in]: videoUrlsToReset } },
            transaction,
          });
        }

        if (videoUrlsToDeleteMapping.length > 0) {
          await PlaylistVideoMapping.destroy({
            where: {
              videoUrl: { [Op.in]: videoUrlsToDeleteMapping },
              playlistUrl: playListUrl,
            },
            transaction,
          });
        }

        await transaction.commit();

        response.writeHead(200, generateCorsHeaders(jsonMimeType));
        return response.end(JSON.stringify({
          "message": `Processed ${deleted.length} video(s) from playlist ${
            (playlist as any).title
          }`,
          "deleted": deleted,
          "failed": failed,
          "cleanUp": cleanUp,
          "deleteVideoMappings": deleteVideoMappings,
          "deleteVideosInDB": deleteVideosInDB,
        }));
      } catch (error) {
        await transaction.rollback();
        logger.error(
          `Video deletion failed with error ${(error as Error).message}`,
          {
            playListUrl,
            videoUrls: JSON.stringify(videoUrls),
            cleanUp,
            deleteVideoMappings,
            deleteVideosInDB,
          },
        );
        response.writeHead(500, generateCorsHeaders(jsonMimeType));
        return response.end(
          JSON.stringify({
            "status": "error",
            "message": (error as Error).message,
          }),
        );
      }
    } catch (error) {
      response.writeHead(400, generateCorsHeaders(jsonMimeType));
      return response.end(
        JSON.stringify({
          "status": "error",
          "message": (error as Error).message,
        }),
      );
    }
  }

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

  return {
    updatePlaylistMonitoring,
    processDeletePlaylistRequest,
    processReindexAllRequest,
    processDeleteVideosRequest,
    getPlaylistsForDisplay,
    getSubListVideos,
  };
}
