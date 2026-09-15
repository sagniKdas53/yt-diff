import { config } from "../../config.ts";
import { durationToSeconds } from "../../utils/duration.ts";

/**
 * Cache policy for the two response paths that serve bytes.
 *
 * Nothing this server sent used to carry a caching directive — no
 * `Cache-Control`, no `ETag`, no `Last-Modified` — so a browser had no grounds
 * to reuse anything and every reload pulled the whole bundle again.
 *
 * The directives deliberately do not go through `generateCorsHeaders`, which
 * is where all three response paths build their headers. That function has 22
 * direct callers across 21 execution flows, and one of them is `json()` — every
 * API response. A directive added there would be added to the API too, and a
 * cached `/getplay` is a stale playlist. So policy lives here, and the two leaf
 * functions that serve bytes opt into it.
 */

/**
 * How long a content-hashed asset stays fresh.
 *
 * Pinned to the login token's lifetime rather than the conventional year: a
 * client that has to log in again is the natural point for it to be holding
 * freshly-fetched bytes, and it bounds how long a deploy can be shadowed by
 * caches on any client that never reloads. `immutable` is still correct within
 * that window — the URL names a content hash, so those bytes cannot change.
 */
export function hashedAssetMaxAge(): number {
  // 24h, matching the config default, if TOKEN_EXPIRY is set to nonsense.
  return durationToSeconds(config.auth.tokenExpiry, 86400);
}

/** Vite writes the content hash into every file it emits under this segment. */
function isContentHashed(assetPath: string): boolean {
  return assetPath.startsWith(`${config.urlBase}/assets/`);
}

/**
 * `Cache-Control` for a static asset.
 *
 * Assets split by whether their name can be reused. Anything under `assets/`
 * carries a content hash, so those bytes can never change under that URL and a
 * deploy asks for different names instead. Everything else — the entry
 * document, the icons, the manifest — keeps a name a deploy reuses, so it must
 * be revalidated before reuse. That matters most for the entry document, since
 * a stale one names bundles that no longer exist.
 */
export function staticCacheControl(assetPath: string): string {
  return isContentHashed(assetPath)
    ? `public, max-age=${hashedAssetMaxAge()}, immutable`
    : "no-cache";
}

/**
 * `Cache-Control` for a signed file.
 *
 * `private`, never `public`: these are per-user signed URLs, and a shared cache
 * holding one is a shared cache holding someone's file. The lifetime is the
 * entry's remaining TTL, which `getSignedFileMetadata` has just slid to
 * `cacheMaxAge` on the way in, so a cached thumbnail cannot outlive the
 * signature that authorised it. An unset or elapsed TTL caches nothing.
 */
export function signedFileCacheControl(
  expiresInSeconds: number | undefined,
): string {
  if (expiresInSeconds === undefined || !Number.isFinite(expiresInSeconds)) {
    return "private, no-store";
  }
  const seconds = Math.floor(expiresInSeconds);
  return seconds > 0 ? `private, max-age=${seconds}` : "private, no-store";
}

/**
 * A strong `ETag` over the exact bytes being sent.
 *
 * Computed once at boot, where the asset table is built — the whole table is
 * already read into memory there, so this costs one pass at startup and
 * nothing per request.
 *
 * It is computed per encoded variant rather than per URL on purpose. A gzip
 * and a brotli response for the same path are different representations, and
 * giving them one validator lets a cache answer an `Accept-Encoding: gzip`
 * request with brotli bytes.
 */
export async function computeETag(
  content: Uint8Array | string,
): Promise<string> {
  const bytes = typeof content === "string"
    ? new TextEncoder().encode(content)
    : content;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    bytes.slice().buffer as ArrayBuffer,
  );
  // 16 hex characters is 64 bits of the digest: collisions are not a concern
  // for a validator over a few dozen build outputs, and the header stays short.
  const hex = Array.from(new Uint8Array(digest).slice(0, 8))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `"${hex}"`;
}

/**
 * Whether the request's `If-None-Match` matches the entity we would send.
 *
 * Handles the `W/` prefix and the comma-separated list form, plus `*`, which
 * matches any existing entity.
 */
export function etagMatches(
  ifNoneMatch: string | undefined,
  etag: string,
): boolean {
  if (!ifNoneMatch) {
    return false;
  }
  const normalize = (tag: string) => tag.trim().replace(/^W\//, "");
  const target = normalize(etag);
  return ifNoneMatch
    .split(",")
    .some((candidate) => {
      const normalized = normalize(candidate);
      return normalized === "*" || normalized === target;
    });
}
