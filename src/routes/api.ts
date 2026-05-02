import { config } from "../config.ts";
import type {
  RateLimitFunction,
  RequestHandler,
} from "../middleware/rateLimit.ts";
import type {
  HttpRequestLike,
  HttpResponseLike,
} from "../transport/http.ts";
import type { RouteDefinition } from "./http.ts";

type BodyHandler = (data: unknown, res: HttpResponseLike) => unknown;
type AuthenticatedMiddleware = (
  req: HttpRequestLike,
  res: HttpResponseLike,
  next: BodyHandler,
) => unknown;

interface ApiRouteDependencies {
  authenticateRequest: AuthenticatedMiddleware;
  authenticateUser: RequestHandler;
  isRegistrationAllowed: RequestHandler;
  rateLimit: RateLimitFunction;
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
}

export function createApiRoutes({
  authenticateRequest,
  authenticateUser,
  isRegistrationAllowed,
  rateLimit,
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
}: ApiRouteDependencies): RouteDefinition[] {
  return [
    {
      method: "POST",
      path: config.urlBase + "/list",
      run: (req, res) =>
        rateLimit(
          req,
          res,
          authenticateRequest,
          processListingRequest,
          config.cache.actionReqPerIP,
          config.cache.actionWindowSec,
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
          processDownloadRequest,
          config.cache.actionReqPerIP,
          config.cache.actionWindowSec,
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
      run: (req, res) =>
        authenticateRequest(req, res, getPlaylistsForDisplay),
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
      run: (req, res) =>
        authenticateRequest(req, res, getSubListVideos),
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
      run: (req, res) =>
        authenticateRequest(req, res, makeSignedUrl),
    },
    {
      method: "POST",
      path: config.urlBase + "/refreshfile",
      run: (req, res) =>
        authenticateRequest(req, res, refreshSignedUrl),
    },
    {
      method: "POST",
      path: config.urlBase + "/refreshfiles",
      run: (req, res) =>
        authenticateRequest(req, res, refreshSignedUrls),
    },
    {
      method: "POST",
      path: config.urlBase + "/getfiles",
      run: (req, res) =>
        authenticateRequest(req, res, makeSignedUrls),
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
          config.cache.reqPerIP,
          config.cache.maxAge,
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
          config.cache.reqPerIP,
          config.cache.maxAge,
        ),
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
          config.cache.reqPerIP,
          config.cache.maxAge,
        ),
    },
  ];
}
