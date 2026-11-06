-- Read-only extract for build_seed.ts. Run on the production database with
-- psql -XAt. Every line of output is one JSON object tagged with its table.
-- Nothing here writes, and raw_metadata is cut down to named keys before it
-- leaves the host: the keys left out include `cookies`, `http_headers`,
-- `_filename` and `description`.
--
-- YouTube only, by the owner's decision: this pack is published in a public
-- repository, and the rest of the archive stays out of it. Synthetic rows in
-- edge-cases.sql stand in for other sites.
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;

WITH yt_videos AS (
  SELECT "videoUrl" FROM video_metadata
  WHERE lower(regexp_replace(split_part("videoUrl", '/', 3), '^(www\.|m\.)', ''))
    IN ('youtube.com', 'youtu.be')
), yt_playlists AS (
  SELECT "playlistUrl" FROM playlist_metadata
  WHERE "playlistUrl" = 'None'
     OR lower(regexp_replace(split_part("playlistUrl", '/', 3), '^(www\.|m\.)', ''))
        IN ('youtube.com', 'youtu.be')
), scoped AS (
  SELECT m.* FROM playlist_video_mappings m
  JOIN yt_videos USING ("videoUrl") JOIN yt_playlists USING ("playlistUrl")
), keep AS (
  -- Every Unlisted row.
  SELECT id FROM scoped WHERE "playlistUrl" = 'None'
  UNION
  -- Every other home of a video that is also Unlisted.
  SELECT id FROM scoped
  WHERE "playlistUrl" <> 'None' AND "videoUrl" IN
    (SELECT "videoUrl" FROM scoped WHERE "playlistUrl" = 'None')
  UNION
  -- A real playlist's first and last three rows, so its numbering keeps its shape.
  SELECT id FROM (
    SELECT id,
      row_number() OVER (PARTITION BY "playlistUrl" ORDER BY "positionInPlaylist", id) AS a,
      row_number() OVER (PARTITION BY "playlistUrl" ORDER BY "positionInPlaylist" DESC, id DESC) AS z
    FROM scoped WHERE "playlistUrl" <> 'None'
  ) s WHERE a <= 3 OR z <= 3
), bots AS (
  SELECT b.* FROM bot_submissions b
  WHERE lower(regexp_replace(split_part(b."requestedUrl", '/', 3), '^(www\.|m\.)', ''))
        IN ('youtube.com', 'youtu.be')
    AND (b."canonicalUrl" IS NULL OR b."canonicalUrl" IN (SELECT "videoUrl" FROM yt_videos))
    AND (b."playlistUrl" IS NULL OR b."playlistUrl" IN (SELECT "playlistUrl" FROM yt_playlists))
), videos AS (
  SELECT "videoUrl" FROM scoped WHERE id IN (SELECT id FROM keep)
  UNION
  SELECT "canonicalUrl" FROM bots WHERE "canonicalUrl" IS NOT NULL
)
SELECT json_build_object('t', 'playlist', 'r', row_to_json(p))
FROM playlist_metadata p WHERE p."playlistUrl" IN (SELECT "playlistUrl" FROM yt_playlists)
UNION ALL
SELECT json_build_object('t', 'mapping', 'r', row_to_json(m))
FROM playlist_video_mappings m WHERE m.id IN (SELECT id FROM keep)
UNION ALL
SELECT json_build_object('t', 'bot', 'r', row_to_json(b))
FROM bots b
UNION ALL
SELECT json_build_object('t', 'video', 'r', json_build_object(
  'videoUrl', v."videoUrl", 'videoId', v."videoId", 'title', v.title,
  'approximateSize', v."approximateSize", 'downloadStatus', v."downloadStatus",
  'isAvailable', v."isAvailable", 'fileName', v."fileName",
  'thumbNailFile', v."thumbNailFile", 'subTitleFile', v."subTitleFile",
  'commentsFile', v."commentsFile", 'descriptionFile', v."descriptionFile",
  'isMetaDataSynced', v."isMetaDataSynced", 'createdAt', v."createdAt",
  'updatedAt', v."updatedAt", 'saveDirectory', v."saveDirectory",
  'onlineThumbnail', v."onlineThumbnail", 'missingExtras', v."missingExtras",
  'lastDownloadError', v."lastDownloadError",
  'downloadFailureReason', v."downloadFailureReason",
  'extrasSyncAttempts', v."extrasSyncAttempts", 'chapters', v.chapters,
  'raw_metadata', CASE WHEN v.raw_metadata IS NULL THEN NULL ELSE (
    SELECT coalesce(jsonb_object_agg(key, value), '{}'::jsonb)
    FROM jsonb_each(v.raw_metadata)
    WHERE key IN (
      'id', 'title', 'extractor', 'extractor_key', 'webpage_url', 'original_url',
      'webpage_url_domain', 'channel', 'channel_id', 'channel_url', 'uploader',
      'uploader_id', 'uploader_url', 'upload_date', 'duration',
      'filesize_approx', 'ext', 'vcodec', 'acodec', 'height', 'width', 'fps',
      'playlist', 'playlist_id', 'playlist_title', 'playlist_webpage_url',
      'playlist_index'
    )
  ) END
))
FROM video_metadata v WHERE v."videoUrl" IN (SELECT "videoUrl" FROM videos);

ROLLBACK;
