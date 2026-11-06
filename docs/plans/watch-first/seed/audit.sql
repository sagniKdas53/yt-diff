\pset pager off
\echo === Unlisted by download state and availability
SELECT v."downloadStatus" downloaded, v."isAvailable" available, count(*), pg_size_pretty(sum(v."approximateSize")::bigint) approx FROM playlist_video_mappings m JOIN video_metadata v USING ("videoUrl") WHERE m."playlistUrl"='None' GROUP BY 1,2 ORDER BY 1 DESC,2 DESC;
\echo === Unlisted not in a real playlist: download state x duration band
WITH u AS (SELECT v."downloadStatus" dl, (v.raw_metadata->>'duration')::numeric d FROM playlist_video_mappings m JOIN video_metadata v USING ("videoUrl") WHERE m."playlistUrl"='None' AND (v.raw_metadata->>'duration') ~ '^[0-9.]+$')
SELECT CASE WHEN d<60 THEN '1 under 1m' WHEN d<300 THEN '2 1-5m' WHEN d<1200 THEN '3 5-20m' WHEN d<3600 THEN '4 20-60m' ELSE '5 over 1h' END band, count(*), count(*) FILTER (WHERE dl) downloaded FROM u GROUP BY 1 ORDER BY 1;
\echo === age_limit/tags/categories presence on Unlisted
SELECT count(*) n, count(v.raw_metadata->>'age_limit') age_known, count(*) FILTER (WHERE (v.raw_metadata->>'age_limit')::int>=18) adult, count(*) FILTER (WHERE jsonb_array_length(CASE WHEN jsonb_typeof(v.raw_metadata->'tags')='array' THEN v.raw_metadata->'tags' ELSE '[]' END)>0) has_tags, count(*) FILTER (WHERE jsonb_array_length(CASE WHEN jsonb_typeof(v.raw_metadata->'categories')='array' THEN v.raw_metadata->'categories' ELSE '[]' END)>0) has_cats FROM playlist_video_mappings m JOIN video_metadata v USING ("videoUrl") WHERE m."playlistUrl"='None';
\echo === Age of not-downloaded links
SELECT to_char(m."createdAt",'YYYY-"Q"Q') q, count(*) FILTER (WHERE NOT v."downloadStatus") links_only, count(*) FILTER (WHERE v."downloadStatus") saved FROM playlist_video_mappings m JOIN video_metadata v USING ("videoUrl") WHERE m."playlistUrl"='None' GROUP BY 1 ORDER BY 1;
\echo === whole library: downloaded rows and DB-claimed size
SELECT count(*) videos, count(*) FILTER (WHERE "downloadStatus") downloaded, pg_size_pretty(sum("approximateSize") FILTER (WHERE "downloadStatus")::bigint) approx_downloaded FROM video_metadata;
\echo === duplicate identity: same site+videoId, more than one URL
WITH v AS (SELECT "videoUrl", "videoId", "downloadStatus", "fileName", lower(regexp_replace(split_part("videoUrl",'/',3),'^(www\.|m\.)','')) host, "approximateSize" sz FROM video_metadata WHERE coalesce("videoId",'') NOT IN ('','NA')),
 g AS (SELECT host,"videoId", count(*) urls, count(*) FILTER (WHERE "downloadStatus") dl, max(sz) FILTER (WHERE "downloadStatus") mx FROM v GROUP BY 1,2 HAVING count(*)>1)
SELECT count(*) groups, sum(urls) rows_in_groups, count(*) FILTER (WHERE dl>1) groups_downloaded_twice, pg_size_pretty(coalesce(sum(mx*(dl-1)) FILTER (WHERE dl>1),0)::bigint) reclaimable_estimate FROM g;
\echo === same identity by url shape only (http/https, www, m, trailing params)
WITH v AS (SELECT "videoUrl", lower(regexp_replace(regexp_replace("videoUrl",'^https?://(www\.|m\.)?',''),'[/?#]+$','')) k, "downloadStatus" dl FROM video_metadata)
SELECT count(*) groups, sum(n) rows, count(*) FILTER (WHERE d>1) both_downloaded FROM (SELECT k,count(*) n,count(*) FILTER (WHERE dl) d FROM v GROUP BY 1 HAVING count(*)>1) t;
\echo === same title+duration across different URLs among downloaded (cross-site candidates)
WITH v AS (SELECT "videoUrl", title, raw_metadata->>'duration' d FROM video_metadata WHERE "downloadStatus" AND (raw_metadata->>'duration') ~ '^[0-9.]+$' AND length(title)>8)
SELECT count(*) groups, coalesce(sum(n),0) rows FROM (SELECT title,round(d::numeric),count(*) n FROM v GROUP BY 1,2 HAVING count(*)>1) t;
\echo === 0b candidates: long-ish downloaded, 2160p AV1 / 1080p H264 by listing metadata
SELECT raw_metadata->>'vcodec' vc, raw_metadata->>'height' h, raw_metadata->>'ext' ext, count(*) FROM video_metadata WHERE "downloadStatus" AND (raw_metadata->>'height') IN ('2160','1080','1440') AND raw_metadata->>'vcodec' ~ '^(av01|avc1|vp9|vp09)' GROUP BY 1,2,3 ORDER BY 2 DESC,4 DESC LIMIT 20;
SELECT count(*) dl_no_codec_with_height FROM video_metadata WHERE "downloadStatus" AND raw_metadata->>'vcodec' IS NULL;
