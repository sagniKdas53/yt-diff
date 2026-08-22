import type { z } from "zod";

import { downloadCost, listingCost } from "../middleware/requestCost.ts";
import type { RequestContext } from "../middleware/rateLimit.ts";
import type { HttpRequestLike, HttpResponseLike } from "../transport/http.ts";
import {
  BulkRefreshSignedUrlsRequestBodySchema,
  BulkSignedFilesRequestBodySchema,
  DedupRequestBodySchema,
  DeletePlaylistRequestBodySchema,
  DeleteVideosRequestBodySchema,
  DownloadRequestBodySchema,
  ListingRequestBodySchema,
  PlaylistDisplayRequestSchema,
  QueueStatusRequestBodySchema,
  RefreshSignedUrlRequestBodySchema,
  ReindexAllRequestBodySchema,
  SignedFileRequestBodySchema,
  SubListRequestSchema,
  UpdatePlaylistMonitoringRequestSchema,
} from "../middleware/validator.ts";

/** A handler behind `authenticateRequest`, taking the body its schema produces. */
export type BodyHandler<T> = (
  data: T,
  res: HttpResponseLike,
  context?: RequestContext,
) => unknown;

/** Shorthand: the body type a schema in this file parses to. */
type Body<S> = S extends z.ZodType<infer T> ? T : never;

/**
 * Handlers that run behind `authenticateRequest`.
 *
 * They receive the already-parsed body, the response, and the verified
 * identity — they never see the request, which is why they cannot read the
 * body themselves and why the schema is applied for them.
 *
 * Each signature is derived from the endpoint's own schema, so a handler that
 * does not accept what its schema produces is a type error here rather than at
 * whatever call site happened to pair the two. That pairing used to live in
 * `index.ts`, two hundred lines from the route it belonged to.
 */
export interface AuthenticatedHandlers {
  /** No schema: reads only the verified identity, never the body. */
  refreshAuthToken: BodyHandler<unknown>;
  processListingRequest: BodyHandler<Body<typeof ListingRequestBodySchema>>;
  processDownloadRequest: BodyHandler<Body<typeof DownloadRequestBodySchema>>;
  updatePlaylistMonitoring: BodyHandler<
    Body<typeof UpdatePlaylistMonitoringRequestSchema>
  >;
  getPlaylistsForDisplay: BodyHandler<
    Body<typeof PlaylistDisplayRequestSchema>
  >;
  processDeletePlaylistRequest: BodyHandler<
    Body<typeof DeletePlaylistRequestBodySchema>
  >;
  getSubListVideos: BodyHandler<Body<typeof SubListRequestSchema>>;
  processDeleteVideosRequest: BodyHandler<
    Body<typeof DeleteVideosRequestBodySchema>
  >;
  makeSignedUrl: BodyHandler<Body<typeof SignedFileRequestBodySchema>>;
  refreshSignedUrl: BodyHandler<
    Body<typeof RefreshSignedUrlRequestBodySchema>
  >;
  refreshSignedUrls: BodyHandler<
    Body<typeof BulkRefreshSignedUrlsRequestBodySchema>
  >;
  makeSignedUrls: BodyHandler<Body<typeof BulkSignedFilesRequestBodySchema>>;
  processReindexAllRequest: BodyHandler<
    Body<typeof ReindexAllRequestBodySchema>
  >;
  processDedupUnlistedRequest: BodyHandler<Body<typeof DedupRequestBodySchema>>;
  processDedupPlaylistsRequest: BodyHandler<
    Body<typeof DedupRequestBodySchema>
  >;
  processQueueStatusRequest: BodyHandler<
    Body<typeof QueueStatusRequestBodySchema>
  >;
}

/**
 * Handlers that take the raw request.
 *
 * These are the endpoints that run *before* anyone is authenticated, so they
 * read and validate the body themselves — there is no middleware ahead of them
 * to have done it.
 */
export interface PublicHandlers {
  authenticateUser: (req: HttpRequestLike, res: HttpResponseLike) => unknown;
  registerUser: (req: HttpRequestLike, res: HttpResponseLike) => unknown;
  isRegistrationAllowed: (
    req: HttpRequestLike,
    res: HttpResponseLike,
  ) => unknown;
}

/**
 * Which admission bucket gates an endpoint, before any user is known.
 *
 * `"none"` means only `authenticateRequest` stands in front of it: a valid
 * token is the admission control. The two endpoints that mint or extend a
 * credential use `"auth"`, whether or not they are themselves authenticated.
 */
export type AdmissionTier = "auth" | "publicRead" | "action" | "none";

interface EndpointBase {
  method: "POST";
  /** Path below `config.urlBase`, with its leading slash. */
  path: string;
  /** One line, so the table reads as the contract it is. */
  summary: string;
  admission: AdmissionTier;
}

export interface AuthenticatedEndpoint extends EndpointBase {
  kind: "authenticated";
  handler: keyof AuthenticatedHandlers;
  /**
   * Applied to the parsed body before the handler runs. Omitted only where the
   * endpoint genuinely ignores its body.
   */
  // deno-lint-ignore no-explicit-any
  schema?: z.ZodType<any>;
  /**
   * Charge against the per-user work budget, in units of queued work. Read
   * from the unvalidated body, which is all that exists at that point in the
   * chain — see `requestCost.ts` for why the unit is work rather than requests.
   */
  cost?: (body: never) => number;
}

export interface PublicEndpoint extends EndpointBase {
  kind: "public";
  handler: keyof PublicHandlers;
}

export type ApiEndpoint = AuthenticatedEndpoint | PublicEndpoint;

/**
 * Every HTTP endpoint this server exposes, in one place.
 *
 * Each of these used to be described in three: the path and the auth wrapper
 * in `api.ts`, the schema two hundred lines away in `index.ts`, and the
 * handler itself reached through a twenty-field dependency interface that was
 * spelled out twice. Nothing tied the three together, so an endpoint could —
 * and did — end up with a schema that was never applied, or an auth wrapper
 * that did not match the one its neighbours used.
 *
 * `api.ts` maps over this table and builds each runner from the record. The
 * record is the contract; there is no second place to keep in step with it.
 */
export const API_ENDPOINTS: readonly ApiEndpoint[] = [
  {
    kind: "authenticated",
    method: "POST",
    path: "/list",
    summary: "Queue a listing pass over one or more playlist or video URLs.",
    handler: "processListingRequest",
    schema: ListingRequestBodySchema,
    admission: "action",
    cost: listingCost,
  },
  {
    kind: "authenticated",
    method: "POST",
    path: "/download",
    summary: "Queue downloads for one or more already-indexed videos.",
    handler: "processDownloadRequest",
    schema: DownloadRequestBodySchema,
    admission: "action",
    cost: downloadCost,
  },
  {
    kind: "authenticated",
    method: "POST",
    path: "/watch",
    summary: "Set a playlist's monitoring type.",
    handler: "updatePlaylistMonitoring",
    schema: UpdatePlaylistMonitoringRequestSchema,
    admission: "none",
  },
  {
    kind: "authenticated",
    method: "POST",
    path: "/getplay",
    summary: "Page through playlists.",
    handler: "getPlaylistsForDisplay",
    schema: PlaylistDisplayRequestSchema,
    admission: "none",
  },
  {
    kind: "authenticated",
    method: "POST",
    path: "/delplay",
    summary: "Delete a playlist, optionally with its videos and files.",
    handler: "processDeletePlaylistRequest",
    schema: DeletePlaylistRequestBodySchema,
    admission: "none",
  },
  {
    kind: "authenticated",
    method: "POST",
    path: "/getsub",
    summary: "Page through the videos in one playlist.",
    handler: "getSubListVideos",
    schema: SubListRequestSchema,
    admission: "none",
  },
  {
    kind: "authenticated",
    method: "POST",
    path: "/delsub",
    summary: "Delete videos from a playlist, optionally with their files.",
    handler: "processDeleteVideosRequest",
    schema: DeleteVideosRequestBodySchema,
    admission: "none",
  },
  {
    kind: "authenticated",
    method: "POST",
    path: "/getfile",
    summary: "Mint a signed URL for one downloaded file.",
    handler: "makeSignedUrl",
    schema: SignedFileRequestBodySchema,
    admission: "none",
  },
  {
    kind: "authenticated",
    method: "POST",
    path: "/refreshfile",
    summary: "Extend the expiry of one signed URL.",
    handler: "refreshSignedUrl",
    schema: RefreshSignedUrlRequestBodySchema,
    admission: "none",
  },
  {
    kind: "authenticated",
    method: "POST",
    path: "/refreshfiles",
    summary: "Extend the expiry of several signed URLs.",
    handler: "refreshSignedUrls",
    schema: BulkRefreshSignedUrlsRequestBodySchema,
    admission: "none",
  },
  {
    kind: "authenticated",
    method: "POST",
    path: "/getfiles",
    summary: "Mint signed URLs for a batch of files; partial success.",
    handler: "makeSignedUrls",
    schema: BulkSignedFilesRequestBodySchema,
    admission: "none",
  },
  {
    kind: "authenticated",
    method: "POST",
    path: "/reindexall",
    summary: "Re-index a range of playlists.",
    handler: "processReindexAllRequest",
    schema: ReindexAllRequestBodySchema,
    admission: "none",
  },
  {
    kind: "authenticated",
    method: "POST",
    path: "/dedup-unlisted",
    summary: "Find, and optionally merge, duplicates outside any playlist.",
    handler: "processDedupUnlistedRequest",
    schema: DedupRequestBodySchema,
    admission: "none",
  },
  {
    kind: "authenticated",
    method: "POST",
    path: "/dedup-playlists",
    summary: "Find, and optionally merge, duplicate playlists.",
    handler: "processDedupPlaylistsRequest",
    schema: DedupRequestBodySchema,
    admission: "none",
  },
  {
    kind: "authenticated",
    method: "POST",
    path: "/queuestatus",
    summary: "Report the current listing and download queues.",
    handler: "processQueueStatusRequest",
    schema: QueueStatusRequestBodySchema,
    admission: "none",
  },
  {
    kind: "authenticated",
    method: "POST",
    path: "/refresh",
    // Behind authenticateRequest, so an expired token gets a 401 here just
    // like anywhere else — this extends a live session, it cannot revive a
    // dead one. Charged against the auth budget rather than the public one:
    // it mints a credential, so it belongs with login. No schema: it reads
    // nothing from the body, only the verified identity.
    summary: "Mint a fresh token for the caller's live session.",
    handler: "refreshAuthToken",
    admission: "auth",
  },
  {
    kind: "public",
    method: "POST",
    path: "/register",
    summary: "Create an account, when registration is open.",
    handler: "registerUser",
    admission: "auth",
  },
  {
    kind: "public",
    method: "POST",
    path: "/login",
    summary: "Exchange credentials for a token.",
    handler: "authenticateUser",
    admission: "auth",
  },
  {
    kind: "public",
    method: "POST",
    path: "/isregallowed",
    // The login page calls this on every load, so it gets the read budget
    // rather than the brute-force one it would otherwise share with /login.
    summary: "Report whether registration is currently open.",
    handler: "isRegistrationAllowed",
    admission: "publicRead",
  },
];
