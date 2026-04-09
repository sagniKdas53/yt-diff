import type { IncomingMessage, ServerResponse } from "node:http";

import { logger } from "../../logger.ts";

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
  req: IncomingMessage,
  res: ServerResponse,
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

  if (!assetPath || !staticAssets[assetPath]) {
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

  const resHeaders = generateCorsHeaders(staticAssets[assetPath]!.type) as Record<
    string,
    string | number
  >;
  if (reqEncoding.includes("br") && staticAssets[assetPath + ".br"]) {
    resHeaders["Content-Encoding"] = "br";
    res.writeHead(200, resHeaders);
    res.write(staticAssets[assetPath + ".br"].file);
    res.end();
    return true;
  }

  if (reqEncoding.includes("gzip") && staticAssets[assetPath + ".gz"]) {
    resHeaders["Content-Encoding"] = "gzip";
    res.writeHead(200, resHeaders);
    res.write(staticAssets[assetPath + ".gz"].file);
    res.end();
    return true;
  }

  res.writeHead(200, resHeaders);
  res.write(staticAssets[assetPath].file);
  res.end();
  return true;
}
