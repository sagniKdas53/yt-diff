import { z } from "zod";
import type { HttpResponseLike } from "../transport/http.ts";
import { generateCorsHeaders, MIME_TYPES } from "../utils/http.ts";
import { logger } from "../logger.ts";

type BodyHandler<T> = (data: T, res: HttpResponseLike) => unknown;

export function validateBody<T>(
  schema: z.ZodType<T>,
  handler: BodyHandler<T>
) {
  return (data: unknown, res: HttpResponseLike) => {
    const result = schema.safeParse(data);
    if (!result.success) {
      logger.warn("Payload validation failed", {
        errors: JSON.stringify(result.error.format()),
        data: JSON.stringify(data)
      });
      res.writeHead(400, generateCorsHeaders(MIME_TYPES[".json"]));
      return res.end(
        JSON.stringify({
          status: "error",
          message: "Invalid payload",
          errors: result.error.errors
        })
      );
    }
    return handler(result.data, res);
  };
}

// Specific Schemas

export const ListingRequestBodySchema = z.object({
  urlList: z.array(z.string()).optional(),
  chunkSize: z.union([z.string(), z.number()]).optional(),
  sleep: z.boolean().optional(),
  monitoringType: z.string().optional(),
});

export const DownloadRequestBodySchema = z.object({
  urlList: z.array(z.string()),
  playListUrl: z.string().optional(),
});

export const UpdatePlaylistMonitoringRequestSchema = z.object({
  url: z.string().optional(),
  watch: z.string().optional(),
});

export const PlaylistDisplayRequestSchema = z.object({
  start: z.number().optional(),
  stop: z.number().optional(),
  sort: z.string().optional(),
  order: z.string().optional(),
  query: z.string().optional(),
});

export const DeletePlaylistRequestBodySchema = z.object({
  playListUrl: z.string().optional(),
  deleteAllVideosInPlaylist: z.boolean().optional(),
  deletePlaylist: z.boolean().optional(),
  cleanUp: z.boolean().optional(),
});

export const SubListRequestSchema = z.object({
  url: z.string().optional(),
  start: z.number().optional(),
  stop: z.number().optional(),
  query: z.string().optional(),
  sortDownloaded: z.boolean().optional(),
});

export const DeleteVideosRequestBodySchema = z.object({
  playListUrl: z.string().optional(),
  videoUrls: z.array(z.string()).optional(),
  cleanUp: z.boolean().optional(),
  deleteVideoMappings: z.boolean().optional(),
  deleteVideosInDB: z.boolean().optional(),
});

export const ReindexAllRequestBodySchema = z.object({
  start: z.union([z.string(), z.number()]).optional(),
  stop: z.union([z.string(), z.number()]).optional(),
  siteFilter: z.string().optional(),
  chunkSize: z.union([z.string(), z.number()]).optional(),
});

export const SignedFileRequestBodySchema = z.object({
  saveDirectory: z.string().optional(),
  fileName: z.string().regex(/^[^\\/]+$/, "File name must not contain directory traversal segments").optional(),
});

export const RefreshSignedUrlRequestBodySchema = z.object({
  fileId: z.string().optional(),
});

export const BulkSignedFilesRequestBodySchema = z.object({
  files: z.array(SignedFileRequestBodySchema).optional(),
});

export const UserAuthSchema = z.object({
  userName: z.string().min(1, "Username is required"),
  password: z.string().min(1, "Password is required").max(72, "Password too long"),
  expiry_time: z.string().optional(),
});

export const IsRegistrationAllowedSchema = z.object({
  sendStats: z.boolean().optional(),
});
