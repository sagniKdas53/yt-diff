// deno-lint-ignore-file no-explicit-any
import he from "he";
import { Model, Op } from "sequelize";
import { config } from "../../config.ts";
import {
  PlaylistMetadata,
  PlaylistVideoMapping,
  sequelize,
  VideoMetadata,
} from "../../db/models.ts";
import { logger } from "../../logger.ts";
import type { HttpResponseLike } from "../../transport/http.ts";
import { existsSync, rmSync, unlinkSync } from "../../utils/fs.ts";
import { join } from "../../utils/path.ts";
import type {
  DeletePlaylistRequestBody,
  DeleteVideosRequestBody,
  HttpError,
  ListingItem,
  PlaylistHandlerDependencies,
  ReindexAllRequestBody,
  UpdatePlaylistMonitoringRequest,
} from "./types.ts";
import { generateCorsHeaders, MIME_TYPES } from "../../utils/http.ts";

export function createMutationHandlers(deps: PlaylistHandlerDependencies) {
  const { listItemsConcurrently, resetPendingPlaylistSortCounter } = deps;
  const jsonMimeType = MIME_TYPES[".json"];

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
          JSON.stringify({
            "status": "error",
            "message": "Need a playListUrl",
          }),
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
          JSON.stringify({
            "status": "error",
            "message": "Playlist not found",
          }),
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

          // Force the next addPlaylist call to re-read the tail sortOrder from DB
          // after deletions reshuffle the playlist ordering.
          resetPendingPlaylistSortCounter();
          logger.debug(
            "Updated sortOrder for playlists after deleted playlist",
            {
              deletedSortOrder,
            },
          );
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
                // Multiple videos can share a playlist saveDirectory; once that
                // directory is deleted, those records must no longer look downloaded.
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
      const mappingIds = requestBody.mappingIds || [];
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
          JSON.stringify({
            "status": "error",
            "message": "Need a playListUrl",
          }),
        );
      }

      if (!Array.isArray(mappingIds)) {
        logger.error("mappingIds must be an array", {
          "requestBody": JSON.stringify(requestBody),
        });
        response.writeHead(400, generateCorsHeaders(jsonMimeType));
        return response.end(
          JSON.stringify({
            "status": "error",
            "message": "mappingIds must be an array",
          }),
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

      if (mappingIds.length === 0 && videoUrls.length === 0) {
        logger.error("mappingIds or videoUrls array cannot be empty", {
          "requestBody": JSON.stringify(requestBody),
        });
        response.writeHead(400, generateCorsHeaders(jsonMimeType));
        return response.end(
          JSON.stringify({
            "status": "error",
            "message": "mappingIds or videoUrls array cannot be empty",
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
          JSON.stringify({
            "status": "error",
            "message": "Playlist not found",
          }),
        );
      }

      const transaction = await sequelize.transaction();
      try {
        const deleted = [];
        const failed = [];

        const mappings = mappingIds.length > 0
          ? await PlaylistVideoMapping.findAll({
            where: {
              id: { [Op.in]: mappingIds },
              playlistUrl: playListUrl,
            },
            transaction,
          })
          : [];

        const mappingsById = new Map(
          mappings.map((mapping) => [
            mapping.getDataValue("id") as string,
            mapping,
          ]),
        );

        const effectiveVideoUrls = mappingIds.length > 0
          ? mappings.map((mapping) =>
            mapping.getDataValue("videoUrl") as string
          )
          : videoUrls;

        const videos = await VideoMetadata.findAll({
          where: { videoUrl: { [Op.in]: effectiveVideoUrls } },
          transaction,
        });

        const videoUrlsToDestroy = [];
        const videoUrlsToReset = [];
        const mappingIdsToDelete = [];

        const deleteTargets = mappingIds.length > 0 ? mappingIds : videoUrls;

        for (const deleteTarget of deleteTargets) {
          let currentVideoUrl = "";
          try {
            const mapping = mappingIds.length > 0
              ? mappingsById.get(deleteTarget)
              : null;
            const videoUrl = mapping
              ? mapping.getDataValue("videoUrl") as string
              : deleteTarget;
            currentVideoUrl = videoUrl;

            if (mappingIds.length > 0 && !mapping) {
              logger.warn("Playlist mapping not found", {
                mappingId: deleteTarget,
                playListUrl,
              });
              failed.push({
                mappingId: deleteTarget,
                reason: "Playlist mapping not found",
              });
              continue;
            }

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
                  if (mapping) {
                    mappingIdsToDelete.push(mapping.getDataValue("id"));
                  } else {
                    const mappingRows = await PlaylistVideoMapping.findAll({
                      where: {
                        videoUrl,
                        playlistUrl: playListUrl,
                      },
                      attributes: ["id"],
                      transaction,
                    });
                    mappingIdsToDelete.push(
                      ...mappingRows.map((row) =>
                        row.getDataValue("id") as string
                      ),
                    );
                  }
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
              videoUrl: currentVideoUrl || deleteTarget,
              error: (error as Error).message,
            });
            failed.push({
              videoUrl: currentVideoUrl || deleteTarget,
              reason: (error as Error).message,
            });
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

        if (mappingIdsToDelete.length > 0) {
          await PlaylistVideoMapping.destroy({
            where: {
              id: { [Op.in]: [...new Set(mappingIdsToDelete)] },
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

  return {
    updatePlaylistMonitoring,
    processDeletePlaylistRequest,
    processReindexAllRequest,
    processDeleteVideosRequest,
  };
}
