import type Redis from "ioredis";

export interface SignedFileMetadata {
  filePath: string;
  mimeType: string;
  inline: boolean;
}

/**
 * Retrieves file metadata from Redis based on the fileId in the URL.
 */
export async function getSignedFileMetadata(
  request: Request,
  redis: Redis,
  cacheMaxAge: number,
): Promise<SignedFileMetadata | null> {
  const url = new URL(request.url);
  const fileId = url.searchParams.get("fileId");
  const inline = url.searchParams.get("inline") === "true";

  if (!fileId) {
    return null;
  }

  const cachedEntry = await redis.get(`signed:${fileId}`);
  if (!cachedEntry) {
    return null;
  }

  let signedEntry: {
    filePath: string;
    mimeType?: string;
    ttl?: number;
  };

  try {
    signedEntry = JSON.parse(cachedEntry);
  } catch {
    return null;
  }

  // Keep actively watched/downloaded files alive by sliding the TTL forward on access.
  // Slide by the TTL the entry was minted with rather than the global default, otherwise
  // a deliberately long-lived link collapses to CACHE_MAX_AGE the first time it is opened.
  // Entries written before `ttl` was recorded fall back to the previous behaviour.
  const slideSeconds =
    typeof signedEntry.ttl === "number" && signedEntry.ttl > 0
      ? signedEntry.ttl
      : cacheMaxAge;
  await redis.expire(`signed:${fileId}`, slideSeconds);

  return {
    filePath: signedEntry.filePath,
    mimeType: signedEntry.mimeType || "application/octet-stream",
    inline,
  };
}
