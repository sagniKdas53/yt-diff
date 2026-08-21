import { z } from "zod";
import type { HttpResponseLike } from "../transport/http.ts";
import { generateCorsHeaders, MIME_TYPES } from "../utils/http.ts";
import { toHttpUrl } from "../utils/url.ts";
import { logger } from "../logger.ts";

type BodyHandler<T> = (data: T, res: HttpResponseLike) => unknown;

export function validateBody<T>(
  schema: z.ZodType<T>,
  handler: BodyHandler<T>,
) {
  return (data: unknown, res: HttpResponseLike) => {
    const result = schema.safeParse(data);
    if (!result.success) {
      logger.warn("Payload validation failed", {
        errors: JSON.stringify(result.error.format()),
        data: JSON.stringify(data),
      });
      res.writeHead(400, generateCorsHeaders(MIME_TYPES[".json"]));
      return res.end(
        JSON.stringify({
          status: "error",
          message: "Invalid payload",
          errors: result.error.issues,
        }),
      );
    }
    return handler(result.data, res);
  };
}

// Shared field schemas

/**
 * A URL that the pipeline may hand to `yt-dlp` as a positional argument.
 *
 * yt-dlp parses any argument starting with `-` as an option, so a plain
 * `z.string()` here let a body like `{"urlList":["--config-location=/tmp/x"]}`
 * reach the subprocess argv as a flag. The argv builders now also pass `--`
 * before the URL; this is the other half of that fix.
 *
 * This parses rather than merely validates: scheme-less input is accepted and
 * comes out with a scheme attached, so `youtube.com/watch?v=…` still works
 * while the value reaching argv is always a serialized http(s) URL. See
 * `toHttpUrl` for what stays rejected and why.
 */
const HttpUrlSchema = z.string().transform((value, ctx) => {
  const normalized = toHttpUrl(value);
  if (normalized === null) {
    ctx.addIssue({
      code: "custom",
      message: "Must be an http(s) URL",
    });
    return z.NEVER;
  }
  return normalized;
});

/**
 * A playlist key: either a real URL or one of the `None`/`init`
 * pseudo-playlists, which is why this is a non-empty string rather than a URL.
 */
const PlaylistKeySchema = z.string().min(1, "Playlist URL is required");

// Specific Schemas

export const ListingRequestBodySchema = z.object({
  urlList: z.array(HttpUrlSchema),
  chunkSize: z.union([z.string(), z.number()]).optional(),
  sleep: z.boolean().optional(),
  monitoringType: z.string().optional(),
});

export const DownloadRequestBodySchema = z.object({
  urlList: z.array(HttpUrlSchema),
  playListUrl: PlaylistKeySchema.optional(),
});

export const UpdatePlaylistMonitoringRequestSchema = z.object({
  url: PlaylistKeySchema,
  watch: z.string().min(1, "Monitoring type is required"),
});

export const PlaylistDisplayRequestSchema = z.object({
  start: z.number().optional(),
  stop: z.number().optional(),
  sort: z.string().optional(),
  order: z.string().optional(),
  query: z.string().optional(),
});

export const DeletePlaylistRequestBodySchema = z.object({
  playListUrl: PlaylistKeySchema,
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
  playListUrl: PlaylistKeySchema,
  mappingIds: z.array(z.string()).optional(),
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
  // Deliberately permissive about the name itself: yt-dlp writes spaces,
  // unicode, emoji and multi-dot extensions, and every one of those has to
  // keep resolving. What is excluded is only what cannot name a real file
  // here — path separators, control characters (which would also forge log
  // lines), and the two path-segment references, which `basename` preserves
  // and which resolve to a directory rather than to a file.
  fileName: z.string()
    .regex(
      /^[^\\/\p{Cc}]+$/u,
      "File name must not contain path separators or control characters",
    )
    .refine(
      (name) => name !== "." && name !== "..",
      "File name must not be a path-segment reference",
    ),
});

export const RefreshSignedUrlRequestBodySchema = z.object({
  fileId: z.string().min(1, "File id is required"),
});

export const BulkRefreshSignedUrlsRequestBodySchema = z.object({
  fileIds: z.array(z.string()),
});

export const BulkSignedFilesRequestBodySchema = z.object({
  files: z.array(SignedFileRequestBodySchema),
});

export const UserAuthSchema = z.object({
  username: z.string().min(1, "Username is required"),
  password: z.string().min(1, "Password is required").max(
    72,
    "Password too long",
  ),
  expiry_time: z.string().optional(),
});

export const IsRegistrationAllowedSchema = z.object({
  sendStats: z.boolean().optional(),
});

export const DedupRequestBodySchema = z.object({
  dryRun: z.boolean().optional().default(true),
  siteFilter: z.string().optional(),
});

export const QueueStatusRequestBodySchema = z.object({});
