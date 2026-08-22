import { config } from "../config.ts";
import type {
  RateLimitFunction,
  RequestContext,
  RequestHandler,
} from "../middleware/rateLimit.ts";
import type { GcraPolicy } from "../middleware/gcra.ts";
import { downloadCost, listingCost } from "../middleware/requestCost.ts";
import type { HttpRequestLike, HttpResponseLike } from "../transport/http.ts";
import type { RouteDefinition } from "./http.ts";

type BodyHandler = (
  data: unknown,
  res: HttpResponseLike,
  context?: RequestContext,
) => unknown;
type AuthenticatedMiddleware = (
  req: HttpRequestLike,
  res: HttpResponseLike,
  next: BodyHandler,
) => unknown;

interface ApiRouteDependencies {
  authenticateRequest: AuthenticatedMiddleware;
  authenticateUser: RequestHandler;
  isRegistrationAllowed: RequestHandler;
  refreshAuthToken: BodyHandler;
  rateLimit: RateLimitFunction & {
    withCost: (
      policy: GcraPolicy,
      costOf: (body: never) => number,
      handler: BodyHandler,
    ) => BodyHandler;
  };
  registerUser: RequestHandler;
  processListingRequest: BodyHandler;
  processDownloadRequest: BodyHandler;
  updatePlaylistMonitoring: BodyHandler;
  getPlaylistsForDisplay: BodyHandler;
  processDeletePlaylistRequest: BodyHandler;
  getSubListVideos: BodyHandler;
  processDeleteVideosRequest: BodyHandler;
  makeSignedUrl: BodyHandler;
  refreshSignedUrl: BodyHandler;
  refreshSignedUrls: BodyHandler;
  makeSignedUrls: BodyHandler;
  processReindexAllRequest: BodyHandler;
  processDedupUnlistedRequest: BodyHandler;
  processDedupPlaylistsRequest: BodyHandler;
  processQueueStatusRequest: BodyHandler;
}

export function createApiRoutes({
  authenticateRequest,
  authenticateUser,
  isRegistrationAllowed,
  rateLimit,
  refreshAuthToken,
  registerUser,
  processListingRequest,
  processDownloadRequest,
  updatePlaylistMonitoring,
  getPlaylistsForDisplay,
  processDeletePlaylistRequest,
  getSubListVideos,
  processDeleteVideosRequest,
  makeSignedUrl,
  refreshSignedUrl,
  refreshSignedUrls,
  makeSignedUrls,
  processReindexAllRequest,
  processDedupUnlistedRequest,
  processDedupPlaylistsRequest,
  processQueueStatusRequest,
}: ApiRouteDependencies): RouteDefinition[] {
  // Each bucket is a separate Redis key namespace. Before this, every limiter
  // shared one `ip:<addr>` counter, so login attempts and listing requests
  // drained the same budget and whichever limit was lowest silently governed
  // both.
  const authPolicy: GcraPolicy = { bucket: "auth", ...config.rateLimit.auth };
  const publicPolicy: GcraPolicy = {
    bucket: "public",
    ...config.rateLimit.publicRead,
  };
  const actionPolicy: GcraPolicy = {
    bucket: "action",
    ...config.rateLimit.action,
  };
  const workPolicy: GcraPolicy = { bucket: "work", ...config.rateLimit.work };

  // Two parameters, so `rateLimit` treats it as a plain RequestHandler and
  // calls it with (req, res) — the same shape /login and /register use.
  const runRefresh: RequestHandler = (req, res) =>
    authenticateRequest(req, res, refreshAuthToken);

  return [
    {
      method: "POST",
      path: config.urlBase + "/list",
      run: (req, res) =>
        rateLimit(
          req,
          res,
          authenticateRequest,
          rateLimit.withCost(workPolicy, listingCost, processListingRequest),
          actionPolicy,
        ),
    },
    {
      method: "POST",
      path: config.urlBase + "/download",
      run: (req, res) =>
        rateLimit(
          req,
          res,
          authenticateRequest,
          rateLimit.withCost(workPolicy, downloadCost, processDownloadRequest),
          actionPolicy,
        ),
    },
    {
      method: "POST",
      path: config.urlBase + "/watch",
      run: (req, res) =>
        authenticateRequest(req, res, updatePlaylistMonitoring),
    },
    {
      method: "POST",
      path: config.urlBase + "/getplay",
      run: (req, res) => authenticateRequest(req, res, getPlaylistsForDisplay),
    },
    {
      method: "POST",
      path: config.urlBase + "/delplay",
      run: (req, res) =>
        authenticateRequest(req, res, processDeletePlaylistRequest),
    },
    {
      method: "POST",
      path: config.urlBase + "/getsub",
      run: (req, res) => authenticateRequest(req, res, getSubListVideos),
    },
    {
      method: "POST",
      path: config.urlBase + "/delsub",
      run: (req, res) =>
        authenticateRequest(req, res, processDeleteVideosRequest),
    },
    {
      method: "POST",
      path: config.urlBase + "/getfile",
      run: (req, res) => authenticateRequest(req, res, makeSignedUrl),
    },
    {
      method: "POST",
      path: config.urlBase + "/refreshfile",
      run: (req, res) => authenticateRequest(req, res, refreshSignedUrl),
    },
    {
      method: "POST",
      path: config.urlBase + "/refreshfiles",
      run: (req, res) => authenticateRequest(req, res, refreshSignedUrls),
    },
    {
      method: "POST",
      path: config.urlBase + "/getfiles",
      run: (req, res) => authenticateRequest(req, res, makeSignedUrls),
    },
    {
      method: "POST",
      path: config.urlBase + "/reindexall",
      run: (req, res) =>
        authenticateRequest(req, res, processReindexAllRequest),
    },
    {
      method: "POST",
      path: config.urlBase + "/dedup-unlisted",
      run: (req, res) =>
        authenticateRequest(req, res, processDedupUnlistedRequest),
    },
    {
      method: "POST",
      path: config.urlBase + "/dedup-playlists",
      run: (req, res) =>
        authenticateRequest(req, res, processDedupPlaylistsRequest),
    },
    {
      method: "POST",
      path: config.urlBase + "/register",
      run: (req, res) =>
        rateLimit(
          req,
          res,
          registerUser,
          isRegistrationAllowed,
          authPolicy,
        ),
    },
    {
      method: "POST",
      path: config.urlBase + "/login",
      run: (req, res) =>
        rateLimit(
          req,
          res,
          authenticateUser,
          authenticateUser,
          authPolicy,
        ),
    },
    {
      method: "POST",
      path: config.urlBase + "/refresh",
      // Behind authenticateRequest, so an expired token gets a 401 here just
      // like anywhere else — this extends a live session, it cannot revive a
      // dead one. Charged against the auth budget rather than the public one:
      // it mints a credential, so it belongs with login.
      run: (req, res) =>
        rateLimit(req, res, runRefresh, runRefresh, authPolicy),
    },
    {
      method: "POST",
      path: config.urlBase + "/isregallowed",
      run: (req, res) =>
        rateLimit(
          req,
          res,
          isRegistrationAllowed,
          isRegistrationAllowed,
          publicPolicy,
        ),
    },
    {
      method: "POST",
      path: config.urlBase + "/queuestatus",
      run: (req, res) =>
        authenticateRequest(req, res, processQueueStatusRequest),
    },
  ];
}
