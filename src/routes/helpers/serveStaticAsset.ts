import { logger } from "../../logger.ts";
import type {
  HttpRequestLike,
  HttpResponseLike,
} from "../../transport/http.ts";

type GenerateCorsHeaders = (
  contentType: string,
) => Record<string, string | number>;

export interface StaticAsset {
  file: Uint8Array | string;
  type: string;
}

interface StaticAssetDependencies {
  staticAssets: Record<string, StaticAsset>;
  generateCorsHeaders: GenerateCorsHeaders;
  htmlMimeType: string;
}

/**
 * How long a browser may reuse a response.
 *
 * Nothing here carried any caching directive before this — no `Cache-Control`,
 * no `ETag`, no `Last-Modified` — so a browser had no grounds to reuse
 * anything and pulled the whole bundle again on every load. Over a tunnel to a
 * small host that is most of what a reload costs.
 *
 * Vite writes content-hashed names into `assets/`, so those bytes can never
 * change under a given URL: they are the case `immutable` exists for, and a
 * deploy simply asks for different names. Everything else is served under a
 * name a deploy reuses, so it has to be revalidated rather than remembered —
 * the entry document most of all, since it is what names the hashed files. A
 * stale one would point at bundles that no longer exist.
 *
 * `no-cache` means "revalidate before reuse", not "do not store". With no
 * validator to revalidate against it currently costs a full refetch, which is
 * what already happened for every asset; adding an `ETag` would turn these
 * into 304s and is the obvious next step, but it is a change to how the asset
 * table is built rather than to how it is served.
 */
function cacheControlFor(assetPath: string): string {
  return assetPath.includes("/assets/")
    ? "public, max-age=31536000, immutable"
    : "no-cache";
}

/** Everything up to the first `?`, which is the part the asset table is keyed on. */
function stripQuery(url: string): string {
  const at = url.indexOf("?");
  return at === -1 ? url : url.slice(0, at);
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
  resHeaders["Cache-Control"] = cacheControlFor(assetPath);

  const brKey = assetPath + ".br";
  const gzKey = assetPath + ".gz";

  if (reqEncoding.includes("br") && Object.hasOwn(staticAssets, brKey)) {
    resHeaders["Content-Encoding"] = "br";
    res.writeHead(200, resHeaders);
    res.write(staticAssets[brKey].file);
    res.end();
    return true;
  }

  if (reqEncoding.includes("gzip") && Object.hasOwn(staticAssets, gzKey)) {
    resHeaders["Content-Encoding"] = "gzip";
    res.writeHead(200, resHeaders);
    res.write(staticAssets[gzKey].file);
    res.end();
    return true;
  }

  res.writeHead(200, resHeaders);
  res.write(staticAssets[assetPath].file);
  res.end();
  return true;
}
