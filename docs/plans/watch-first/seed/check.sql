-- Measures the shape of the Unlisted pile using the rules in
-- ../05-unlisted-filing.md, within the pack's scope (YouTube). Run it on the
-- seed before edge-cases.sql is loaded and compare with seed/README.md; it was
-- also run on production to get those numbers, so a difference means the pack no
-- longer represents the archive. Only session-local temp tables are written.
\pset pager off
\pset format aligned

CREATE TEMP TABLE un AS
  SELECT m."videoUrl" AS u, m."createdAt" AS added, m."positionInPlaylist" AS pos,
    v."downloadStatus" AS saved,
    lower(regexp_replace(split_part(v."videoUrl", '/', 3), '^(www\.|m\.)', '')) AS host,
    CASE WHEN v.raw_metadata->>'duration' ~ '^[0-9.]+$'
         THEN (v.raw_metadata->>'duration')::numeric END AS seconds,
    lower(coalesce(nullif(v.raw_metadata->>'channel_id', 'NA'),
                   nullif(v.raw_metadata->>'uploader_id', 'NA'),
                   nullif(v.raw_metadata->>'uploader', 'NA'))) AS ch,
    lower(nullif(v.raw_metadata->>'uploader_id', 'NA')) AS uid,
    EXISTS (SELECT 1 FROM playlist_video_mappings o
            WHERE o."videoUrl" = m."videoUrl" AND o."playlistUrl" <> 'None'
              AND lower(regexp_replace(split_part(o."playlistUrl", '/', 3), '^(www\.|m\.)', ''))
                  IN ('youtube.com', 'youtu.be')) AS also
  FROM playlist_video_mappings m JOIN video_metadata v USING ("videoUrl")
  WHERE m."playlistUrl" = 'None'
    AND lower(regexp_replace(split_part(v."videoUrl", '/', 3), '^(www\.|m\.)', ''))
        IN ('youtube.com', 'youtu.be');

CREATE TEMP TABLE seg AS
  SELECT lower(regexp_replace(split_part("playlistUrl", '/', 3), '^(www\.|m\.)', '')) AS host,
    lower(unnest(string_to_array(
      split_part(regexp_replace("playlistUrl", '^https?://[^/]+/', ''), '?', 1), '/'))) AS s
  FROM playlist_metadata
  WHERE lower(regexp_replace(split_part("playlistUrl", '/', 3), '^(www\.|m\.)', ''))
        IN ('youtube.com', 'youtu.be');

CREATE TEMP TABLE placed AS
  SELECT un.*,
    also OR (uid IS NOT NULL AND EXISTS (SELECT 1 FROM seg WHERE seg.host = un.host
             AND seg.s NOT IN ('videos', 'playlist', 'profile', 'channel', 'user', 'shorts')
             AND seg.s IN (uid, '@' || ltrim(uid, '@')))) AS in_playlist,
    coalesce(seconds < 120, false) AS clip
  FROM un;

CREATE TEMP TABLE big AS
  SELECT host, ch FROM placed
  WHERE NOT in_playlist AND NOT clip AND ch IS NOT NULL
  GROUP BY 1, 2 HAVING count(*) >= 3;

\echo positions: rows, distinct positions, tied positions, rows in ties, inversions
WITH r AS (
  SELECT pos, added, lag(added) OVER (ORDER BY pos, u) AS prev FROM un
)
SELECT count(*) AS rows, count(DISTINCT pos) AS positions,
  (SELECT count(*) FROM (SELECT pos FROM un GROUP BY pos HAVING count(*) > 1) t) AS tied_positions,
  (SELECT coalesce(sum(n), 0) FROM (SELECT count(*) n FROM un GROUP BY pos HAVING count(*) > 1) t) AS rows_in_ties,
  count(*) FILTER (WHERE added < prev) AS inversions
FROM r;

\echo placement
SELECT count(*) AS unlisted,
  count(*) FILTER (WHERE in_playlist) AS in_playlist,
  count(*) FILTER (WHERE NOT in_playlist AND clip) AS clips,
  count(*) FILTER (WHERE NOT in_playlist AND NOT clip AND b.ch IS NOT NULL) AS in_auto_channels,
  (SELECT count(*) FROM big) AS auto_channels,
  count(*) FILTER (WHERE NOT in_playlist AND NOT clip AND b.ch IS NULL AND saved) AS archive_saved,
  count(*) FILTER (WHERE NOT in_playlist AND NOT clip AND b.ch IS NULL AND NOT saved) AS archive_links
FROM placed p LEFT JOIN big b ON b.host = p.host AND b.ch = p.ch;
