import { config } from "../config.ts";
import type { VideoMetadata } from "../db/models.ts";
import { logger } from "../logger.ts";
import { exists, unlink } from "../utils/fs.ts";
import { join } from "../utils/path.ts";

/**
 * Removes a video's media file and all of its sidecars from disk.
 *
 * Shared by the web UI's delete-with-cleanup path and the bot's retention
 * reaper so the two cannot drift on which columns count as files. Callers own
 * the decision of *whether* to clean up (and any subsequent DB reset); this
 * only touches the filesystem.
 *
 * A missing file is not a failure — it is logged and skipped, matching the
 * previous inline behaviour.
 *
 * @param video - The video whose files should be removed
 * @returns true when every present file was removed, false if any unlink failed
 */
export async function removeVideoFiles(
  video: VideoMetadata,
): Promise<boolean> {
  const videoUrl = video.videoUrl;
  const filesToRemove: Record<string, string | null> = {
    "fileName": video.fileName,
    "thumbNailFile": video.thumbNailFile,
    "subTitleFile": video.subTitleFile,
    "commentsFile": video.commentsFile,
    "descriptionFile": video.descriptionFile,
  };

  logger.debug("Removing files for video", {
    videoUrl,
    filesToRemove: JSON.stringify(filesToRemove),
  });

  let allFilesRemoved = true;

  for (const [key, value] of Object.entries(filesToRemove)) {
    if (!value) {
      continue;
    }

    try {
      const filePath = join(
        config.saveLocation,
        video.saveDirectory || "",
        value,
      );
      logger.debug("Removing file", { videoUrl, key, value, filePath });
      if (await exists(filePath)) {
        await unlink(filePath);
        logger.debug("Removed file", { videoUrl, key, value, filePath });
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

  return allFilesRemoved;
}
