import { logger } from "../../logger.ts";
import type {
  HttpRequestLike,
  HttpResponseLike,
} from "../../transport/http.ts";
import { etagMatches, staticCacheControl } from "./assetCache.ts";

type GenerateCorsHeaders = (
  contentType: string,
) => Record<string, string | number>;

export interface StaticAsset {
  file: Uint8Array | string;
  type: string;
  /**
   * Strong validator over these exact bytes, computed at boot. Absent only in
   * tests that build a table by hand; a variant without one simply does not
   * take part in revalidation.
   */
  etag?: string;
}

interface StaticAssetDependencies {
  staticAssets: Record<string, StaticAsset>;
  generateCorsHeaders: GenerateCorsHeaders;
  htmlMimeType: string;
}

/** Everything up to the first `?`, which is the part the asset table is keyed on. */
function stripQuery(url: string): string {
  const at = url.indexOf("?");
  return at === -1 ? url : url.slice(0, at);
}

/**
 * Adds `Accept-Encoding` to whatever `Vary` the CORS headers already set.
 *
 * This path answers one URL with brotli, gzip or identity bytes depending on
 * the request. Without naming `Accept-Encoding`, a shared cache is entitled to
 * hand the brotli body to a client that never asked for it — which only became
 * reachable once these responses were cacheable at all.
 */
function varyWithEncoding(existing: string | number | undefined): string {
  const parts = String(existing ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (!parts.some((part) => part.toLowerCase() === "accept-encoding")) {
    parts.push("Accept-Encoding");
  }
  return parts.join(", ");
}

export function serveStaticAsset(
  req: HttpRequestLike,
  res: HttpResponseLike,
  {
    staticAssets,
    generateCorsHeaders,
    htmlMimeType,
  }: StaticAssetDependencies,
): boolean {
  if (!req.url) {
    return false;
  }

  // `req.url` is pathname + search (see `DenoRequestAdapter`), but the asset
  // table is keyed on pathname alone, so a query string used to turn a real
  // asset into a 404: `/ytdiff/?utm_source=x` missed the `/ytdiff/` key and
  // the app failed to load from any link carrying a tracking parameter. No
  // static asset here is identified by its query, so the lookup drops it.
  //
  // This is also what a fragment-routed deep link relies on — the fragment
  // never reaches the server, but anything else pasted alongside it does.
  const assetPath = stripQuery(req.url);
  const reqEncoding = req.headers["accept-encoding"] || "";

  if (!assetPath || !Object.hasOwn(staticAssets, assetPath)) {
    logger.error("Requested Resource couldn't be found", {
      url: req.url,
      method: req.method,
      encoding: reqEncoding,
    });
    res.writeHead(404, generateCorsHeaders(htmlMimeType));
    res.write("Not Found");
    res.end();
    return true;
  }

  const resHeaders = generateCorsHeaders(
    staticAssets[assetPath]!.type,
  ) as Record<
    string,
    string | number
  >;
  resHeaders["Cache-Control"] = staticCacheControl(assetPath);
  resHeaders["Vary"] = varyWithEncoding(resHeaders["Vary"]);

  // Pick the encoded variant first: its bytes are what the validator has to
  // describe, and the 304 below must answer for that same representation.
  const brKey = assetPath + ".br";
  const gzKey = assetPath + ".gz";
  let variant = staticAssets[assetPath]!;

  if (reqEncoding.includes("br") && Object.hasOwn(staticAssets, brKey)) {
    resHeaders["Content-Encoding"] = "br";
    variant = staticAssets[brKey]!;
  } else if (
    reqEncoding.includes("gzip") && Object.hasOwn(staticAssets, gzKey)
  ) {
    resHeaders["Content-Encoding"] = "gzip";
    variant = staticAssets[gzKey]!;
  }

  if (variant.etag) {
    resHeaders["ETag"] = variant.etag;

    // `no-cache` means revalidate before reuse, not "do not store" — so the
    // entry document still gets asked for on every load. With a validator that
    // question is answered by an empty 304 instead of the whole document.
    if (etagMatches(req.headers["if-none-match"], variant.etag)) {
      // A 304 carries no body and no `Content-Length`; the cached entry
      // supplies those. `Content-Encoding` would describe a body that is not
      // here, so it comes back off.
      delete resHeaders["Content-Encoding"];
      res.writeHead(304, resHeaders);
      res.end();
      return true;
    }
  }

  res.writeHead(200, resHeaders);
  res.write(variant.file);
  res.end();
  return true;
}
