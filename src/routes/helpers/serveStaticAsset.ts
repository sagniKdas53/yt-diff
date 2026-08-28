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
