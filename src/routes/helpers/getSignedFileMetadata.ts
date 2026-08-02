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
  };

  try {
    signedEntry = JSON.parse(cachedEntry);
  } catch {
    return null;
  }

  // Keep actively watched/downloaded files alive by sliding the TTL forward on
  // access. Every entry has the same lifetime, so this matches what
  // refreshSignedUrl does — there is no per-entry TTL to honour.
  await redis.expire(`signed:${fileId}`, cacheMaxAge);

  return {
    filePath: signedEntry.filePath,
    mimeType: signedEntry.mimeType || "application/octet-stream",
    inline,
  };
}
