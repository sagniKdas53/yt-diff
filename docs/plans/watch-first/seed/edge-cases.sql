-- Hand-written rows for what the YouTube-only pack can't show: more than one site,
-- short clips from a site where most videos are short, `www.` and `m.` hosts, tied
-- positions, broken metadata, hostile names, and bot expiry. None of this is real.
-- Everything lives on `.example` hosts, so it's easy to tell apart and check.sql
-- ignores it.
BEGIN;

CREATE TEMP TABLE edge_video (
  url text, title text, added date, saved boolean, raw jsonb, tied boolean DEFAULT false
) ON COMMIT DROP;

INSERT INTO edge_video (url, title, added, saved, raw) VALUES
  -- A clip-heavy site. Five singles, and one account with three clips: clips are
  -- placed before channels, so these three must not produce an auto-channel.
  ('https://clips.example/a/status/1', 'Clip one',   '2026-03-02', true,  '{"uploader_id":"a","uploader":"Clip A","duration":12,"extractor_key":"ClipSite"}'),
  ('https://clips.example/b/status/2', 'Clip two',   '2026-03-09', true,  '{"uploader_id":"b","uploader":"Clip B","duration":40.5,"extractor_key":"ClipSite"}'),
  ('https://clips.example/c/status/3', 'Clip three', '2026-04-14', false, '{"uploader_id":"c","uploader":"Clip C","duration":90,"extractor_key":"ClipSite"}'),
  ('https://clips.example/n/status/4', 'Busy one',   '2026-05-01', true,  '{"uploader_id":"busy","uploader":"Busy","duration":30,"extractor_key":"ClipSite"}'),
  ('https://clips.example/n/status/5', 'Busy two',   '2026-05-02', true,  '{"uploader_id":"busy","uploader":"Busy","duration":31,"extractor_key":"ClipSite"}'),
  ('https://clips.example/n/status/6', 'Busy three', '2026-05-03', true,  '{"uploader_id":"busy","uploader":"Busy","duration":32,"extractor_key":"ClipSite"}'),
  -- The boundary: 119.9 is a clip, 120 isn't, and a bad duration is unknown, not 0.
  ('https://clips.example/e/status/7', 'Just under', '2026-06-01', true,  '{"uploader_id":"e","duration":119.9,"extractor_key":"ClipSite"}'),
  ('https://clips.example/f/status/8', 'Exactly at', '2026-06-02', true,  '{"uploader_id":"f","duration":120,"extractor_key":"ClipSite"}'),
  ('https://clips.example/g/status/9', 'Bad length', '2026-06-03', true,  '{"uploader_id":"g","duration":"abc","extractor_key":"ClipSite"}'),
  -- One channel seen on three spellings of one host, with a key that attacks SQL.
  -- Three long videos, so it must become one auto-channel on one site.
  ('https://www.edge.example/v/1', 'Host www',  '2026-02-01', true,  '{"uploader_id":"o''neil''; DROP TABLE video_metadata;--","uploader":"O''Neil","duration":600,"channel_url":"https://edge.example/u/oneil"}'),
  ('https://m.edge.example/v/2',   'Host m',    '2026-02-02', false, '{"uploader_id":"O''Neil''; DROP TABLE video_metadata;--","uploader":"O''Neil","duration":700}'),
  ('https://edge.example/v/3',     'Host bare', '2026-02-03', false, '{"uploader_id":"o''neil''; DROP TABLE video_metadata;--","uploader":"O''Neil","duration":800}'),
  -- The same id on another site is a different channel, and two videos aren't enough.
  ('https://other.example/v/1', 'Same id A', '2026-02-04', false, '{"uploader_id":"o''neil''; DROP TABLE video_metadata;--","duration":600}'),
  ('https://other.example/v/2', 'Same id B', '2026-02-05', false, '{"uploader_id":"o''neil''; DROP TABLE video_metadata;--","duration":600}'),
  -- The uploader matches a playlist on this host, with different case and an `@`.
  ('https://match.example/v/1', 'Matches monitored', '2026-01-10', false, '{"uploader_id":"@Match-Me","duration":500}'),
  -- The uploader's handle is a URL word, which must not match every playlist.
  ('https://match.example/v/2', 'Handle is a word', '2026-01-11', false, '{"uploader_id":"videos","duration":500}'),
  -- Missing data: every one of these lands in Archive, with a site from its URL.
  ('https://nodata.example/v/1', 'No metadata', '2025-12-01', false, NULL),
  ('https://nodata.example/v/2', 'NA strings',  '2025-12-02', false, '{"uploader_id":"NA","channel_id":"NA","uploader":"NA","duration":"NA","upload_date":"NA"}'),
  ('https://nodata.example/v/3', 'Blank',       '2025-12-03', true,  '{"uploader_id":"  ","channel_id":"","duration":null}'),
  ('https://nodata.example/v/4', 'テスト ''quoted'' title', '2025-12-04', true, '{"uploader":"チャンネル","duration":400}');

INSERT INTO edge_video (url, title, added, saved, raw, tied) VALUES
  -- Two rows at one position, as a race can leave them.
  ('https://nodata.example/tie/1', 'Tied first',  '2026-07-01', false, '{"duration":300}', true),
  ('https://nodata.example/tie/2', 'Tied second', '2026-07-01', false, '{"duration":300}', true);

INSERT INTO video_metadata ("videoUrl", "videoId", title, "approximateSize",
  "downloadStatus", "isAvailable", "isMetaDataSynced", "fileName", "saveDirectory",
  raw_metadata, "createdAt", "updatedAt")
SELECT url, md5(url), title, 1000000, saved, true, saved,
  CASE WHEN saved THEN md5(url) || '.mp4' END, CASE WHEN saved THEN '' END,
  raw, added + time '12:00', added + time '12:00'
FROM edge_video;

INSERT INTO playlist_metadata ("playlistUrl", title, "sortOrder", "monitoringType",
  "saveDirectory", "createdAt", "updatedAt", "lastUpdatedByScheduler") VALUES
  -- A monitored End playlist: filing must not change where its tail scan starts.
  ('https://match.example/@match-me/videos', 'Match Me', 1000, 'End', 'match-me', '2026-01-01', '2026-01-01', '2026-01-01'),
  -- A mixed playlist: its videos have different owners, so it isn't a channel.
  ('https://match.example/playlist?list=mixed', 'Mixed list', 1001, 'N/A', 'mixed', '2026-01-01', '2026-01-01', '1970-01-01');

INSERT INTO video_metadata ("videoUrl", "videoId", title, "approximateSize",
  "downloadStatus", "isAvailable", "isMetaDataSynced", raw_metadata, "createdAt", "updatedAt")
SELECT 'https://match.example/v/m' || n, 'm' || n, 'Monitored ' || n, 1000000, false, true, false,
  jsonb_build_object('uploader_id', '@Match-Me', 'duration', 500), '2026-01-01'::timestamptz, '2026-01-01'::timestamptz
FROM generate_series(1, 3) n
UNION ALL
SELECT 'https://match.example/v/x' || n, 'x' || n, 'Mixed ' || n, 1000000, false, true, false,
  jsonb_build_object('uploader_id', 'owner' || n, 'duration', 500), '2026-01-01'::timestamptz, '2026-01-01'::timestamptz
FROM generate_series(1, 3) n;

INSERT INTO playlist_video_mappings (id, "videoUrl", "playlistUrl", "positionInPlaylist", "createdAt", "updatedAt")
SELECT gen_random_uuid(), 'https://match.example/v/m' || n,
  'https://match.example/@match-me/videos', n, '2026-01-01'::timestamptz, '2026-01-01'::timestamptz
FROM generate_series(1, 3) n
UNION ALL
SELECT gen_random_uuid(), 'https://match.example/v/x' || n,
  'https://match.example/playlist?list=mixed', n, '2026-01-01'::timestamptz, '2026-01-01'::timestamptz
FROM generate_series(1, 3) n;

-- Append to Unlisted. Numbering continues after the pack, and ties share a slot.
INSERT INTO playlist_video_mappings (id, "videoUrl", "playlistUrl", "positionInPlaylist", "createdAt", "updatedAt")
SELECT gen_random_uuid(), url, 'None',
  (SELECT coalesce(max("positionInPlaylist"), 0) FROM playlist_video_mappings WHERE "playlistUrl" = 'None')
    + dense_rank() OVER (ORDER BY added, CASE WHEN tied THEN '' ELSE url END),
  added + time '12:00', added + time '12:00'
FROM edge_video;

-- Bot rows: a clock that's running, one that has run out, and a kept video. Filing
-- must leave all of these exactly as they are.
INSERT INTO bot_submissions (id, platform, "chatId", "requestedUrl", "canonicalUrl", kind,
  status, retention, "downloadedByBot", "expiresAt", "createdAt", "updatedAt") VALUES
  (gen_random_uuid(), 'telegram', '111111111', 'https://clips.example/a/status/1', 'https://clips.example/a/status/1', 'video', 'delivered', 'ephemeral',  true, now() + interval '1 day', now(), now()),
  (gen_random_uuid(), 'telegram', '111111111', 'https://clips.example/b/status/2', 'https://clips.example/b/status/2', 'video', 'delivered', 'ephemeral',  true, now() - interval '1 day', now(), now()),
  (gen_random_uuid(), 'telegram', '111111111', 'https://clips.example/n/status/4', 'https://clips.example/n/status/4', 'video', 'delivered', 'persistent', true, NULL, now(), now());

COMMIT;
