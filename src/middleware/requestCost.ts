import { config } from "../config.ts";

/**
 * Cost weighting for throttled endpoints.
 *
 * A request-counting limiter treats `POST /list` with one URL and `POST /list`
 * with two hundred URLs as the same event, even though the second queues two
 * hundred `yt-dlp` processes. Since `MAX_LISTINGS`/`MAX_DOWNLOADS` cap
 * concurrency at 1, that difference does not show up as load — it shows up as
 * unbounded queue depth and a backlog measured in hours.
 *
 * So the unit charged here is a unit of queued work, not an HTTP request.
 *
 * The weights are deliberately coarse. They only need to get the ordering
 * right — a full playlist re-scan really is far more expensive than appending
 * to one — and every one is configurable for operators whose libraries or
 * hardware make a different ratio true.
 */

/** Body shape both throttled endpoints share. Parsed, but not yet validated. */
interface CostableBody {
  urlList?: unknown;
  monitoringType?: unknown;
}

function urlCount(body: CostableBody): number {
  return Array.isArray(body.urlList) ? body.urlList.length : 0;
}

/**
 * Cost of a listing request.
 *
 * `Full` and `Refresh` walk the entire playlist from the start; `Start` and
 * `End` only touch the head or tail. That gap is the single most important
 * signal available at admission time, and it is exactly the axis a request
 * counter is blind to.
 */
export function listingCost(body: CostableBody): number {
  const perUrl = body.monitoringType === "Full" ||
      body.monitoringType === "Refresh"
    ? config.rateLimit.weights.listFullScan
    : config.rateLimit.weights.listIncremental;

  return config.rateLimit.weights.requestBase + urlCount(body) * perUrl;
}

/**
 * Cost of a download request.
 *
 * Weighted below a full listing on purpose. Downloads are bounded per video,
 * explicitly requested, and serialized by the semaphore — and "select all in
 * this playlist, download" is a legitimate action that can carry hundreds of
 * URLs. Charging these like re-scans would throttle the app's normal use.
 */
export function downloadCost(body: CostableBody): number {
  return config.rateLimit.weights.requestBase +
    urlCount(body) * config.rateLimit.weights.download;
}
