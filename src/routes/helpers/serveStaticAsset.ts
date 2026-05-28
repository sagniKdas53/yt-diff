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

  const assetPath = req.url;
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
