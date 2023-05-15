CREATE TABLE video_list (
  video_url VARCHAR(255) NOT NULL PRIMARY KEY,
  video_id VARCHAR(255) NOT NULL,
  title VARCHAR(255) NOT NULL,
  approximate_size DOUBLE NOT NULL,
  downloaded BOOLEAN NOT NULL,
  available BOOLEAN NOT NULL,
  createdAt DATE NOT NULL,
  updatedAt DATE NOT NULL
);

CREATE TABLE playlist_list (
  title VARCHAR(255) NOT NULL,
  playlist_url VARCHAR(255) NOT NULL PRIMARY KEY,
  order_added INTEGER NOT NULL DEFAULT 0,
  monitoring_type SMALLINT NOT NULL,
  save_dir VARCHAR(255) NOT NULL,
  createdAt DATE NOT NULL,
  updatedAt DATE NOT NULL
);

CREATE TABLE playlist_video (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4 (),
  video_url VARCHAR(255) NOT NULL,
  playlist_url VARCHAR(255) NOT NULL,
  index_in_playlist INTEGER NOT NULL,
  CONSTRAINT fk_video_url FOREIGN KEY (video_url) REFERENCES video_list (video_url) ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT fk_playlist_url FOREIGN KEY (playlist_url) REFERENCES playlist_list (playlist_url) ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT uc_video_playlist_index UNIQUE (video_url, playlist_url, index_in_playlist)
);

-- Sample entries for video_list table
INSERT INTO
  video_list (
    video_url,
    video_id,
    title,
    approximate_size,
    downloaded,
    available,
    createdAt,
    updatedAt
  )
VALUES
  (
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'dQw4w9WgXcQ',
    'Rick Astley - Never Gonna Give You Up (Video)',
    10.5,
    true,
    true,
    '2022-05-13 10:00:00',
    '2022-05-13 11:00:00'
  ),
  (
    'https://www.youtube.com/watch?v=2Vv-BfVoq4g',
    '2Vv-BfVoq4g',
    'Michael Jackson - Billie Jean (Official Video)',
    20.2,
    true,
    true,
    '2022-05-13 12:00:00',
    '2022-05-13 13:00:00'
  ),
  (
    'https://www.youtube.com/watch?v=JGwWNGJdvx8',
    'JGwWNGJdvx8',
    'Queen - Bohemian Rhapsody (Official Video Remastered)',
    15.7,
    false,
    true,
    '2022-05-13 14:00:00',
    '2022-05-13 15:00:00'
  ),
  (
    'https://www.youtube.com/watch?v=3tmd-ClpJxA',
    '3tmd-ClpJxA',
    'The Cranberries - Zombie (Official Music Video)',
    18.9,
    true,
    false,
    '2022-05-13 16:00:00',
    '2022-05-13 17:00:00'
  ),
  (
    'https://www.youtube.com/watch?v=d1YBv2mWll0',
    'd1YBv2mWll0',
    'Metallica: Nothing Else Matters (Official Music Video)',
    25.3,
    false,
    true,
    '2022-05-13 18:00:00',
    '2022-05-13 19:00:00'
  ),
  (
    'https://www.youtube.com/watch?v=6SFNW5F8K9Y',
    '6SFNW5F8K9Y',
    'Nirvana - Smells Like Teen Spirit (Official Music Video)',
    19.6,
    true,
    true,
    '2022-05-13 20:00:00',
    '2022-05-13 21:00:00'
  ),
  (
    'https://www.youtube.com/watch?v=JaAWdljhD5o',
    'JaAWdljhD5o',
    'Guns N\' Roses - Sweet Child O\' Mine (Official Music Video)',
    23.1,
    true,
    false,
    '2022-05-13 22:00:00',
    '2022-05-13 23:00:00'
  ),
  (
    'https://www.youtube.com/watch?v=yrhJhd6PX8I',
    'yrhJhd6PX8I',
    'AC/DC - Highway to Hell (Official Video)',
    21.8,
    false,
    false,
    '2022-05-14 00:00:00',
    '2022-05-14 01:00:00'
  ),
  (
    'https://www.youtube.com/watch?v=fJ9rUzIMcZQ',
    'fJ9rUzIMcZQ',
    'Bon Jovi - Livin On A Prayer (Official Music Video)',
    17.5,
    true,
    true,
    '2022-05-14 02:00:00',
    '2022-05-14 01:00:00'
  ),
  -- Sample entries for video_list table
INSERT INTO
  video_list (
    video_url,
    video_id,
    title,
    approximate_size,
    downloaded,
    available,
    createdAt,
    updatedAt
  )
VALUES
  (
    'https://www.youtube.com/watch?v=abc123',
    'v123',
    'Introduction to SQL',
    200.50,
    true,
    true,
    NOW(),
    NOW()
  ),
  (
    'https://www.youtube.com/watch?v=def456',
    'v456',
    'Advanced SQL Queries',
    350.25,
    false,
    true,
    NOW(),
    NOW()
  ),
  (
    'https://www.youtube.com/watch?v=ghi789',
    'v789',
    'SQL Data Modeling',
    150.75,
    true,
    false,
    NOW(),
    NOW()
  ),
  (
    'https://www.youtube.com/watch?v=jkl012',
    'v012',
    'SQL Joins',
    250.30,
    true,
    true,
    NOW(),
    NOW()
  ),
  (
    'https://www.youtube.com/watch?v=lmn345',
    'v345',
    'SQL Indexes',
    100.80,
    false,
    false,
    NOW(),
    NOW()
  ),
  (
    'https://www.youtube.com/watch?v=opq678',
    'v678',
    'SQL Constraints',
    180.90,
    true,
    true,
    NOW(),
    NOW()
  ),
  (
    'https://www.youtube.com/watch?v=stu901',
    'v901',
    'SQL Subqueries',
    300.10,
    true,
    true,
    NOW(),
    NOW()
  ),
  (
    'https://www.youtube.com/watch?v=vwx234',
    'v234',
    'SQL Aggregation Functions',
    75.50,
    false,
    false,
    NOW(),
    NOW()
  ),
  (
    'https://www.youtube.com/watch?v=yza567',
    'v567',
    'SQL Stored Procedures',
    400.00,
    true,
    true,
    NOW(),
    NOW()
  ),
  (
    'https://www.youtube.com/watch?v=zxc890',
    'v890',
    'SQL Views',
    225.75,
    true,
    false,
    NOW(),
    NOW()
  );

-- Sample entries for playlist_list table
INSERT INTO
  playlist_list (
    title,
    playlist_url,
    order_added,
    monitoring_type,
    save_dir,
    createdAt,
    updatedAt
  )
VALUES
  (
    'SQL Basics',
    'https://www.youtube.com/playlist?list=pl456',
    1,
    1,
    '/home/user/videos/sql_basics/',
    NOW(),
    NOW()
  ),
  (
    'SQL Advanced',
    'https://www.youtube.com/playlist?list=pl789',
    2,
    2,
    '/home/user/videos/sql_advanced/',
    NOW(),
    NOW()
  ),
  (
    'SQL Performance Tuning',
    'https://www.youtube.com/playlist?list=pl012',
    3,
    3,
    '/home/user/videos/sql_tuning/',
    NOW(),
    NOW()
  ),
  (
    'SQL Data Modeling',
    'https://www.youtube.com/playlist?list=pl345',
    4,
    1,
    '/home/user/videos/sql_data_modeling/',
    NOW(),
    NOW()
  ),
  (
    'SQL Joins',
    'https://www.youtube.com/playlist?list=pl678',
    5,
    2,
    '/home/user/videos/sql_joins/',
    NOW(),
    NOW()
  ),
  (
    'SQL Indexes',
    'https://www.youtube.com/playlist?list=pl901',
    6,
    3,
    '/home/user/videos/sql_indexes/',
    NOW(),
    NOW()
  ),
  (
    'SQL Constraints',
    'https://www.youtube.com/playlist?list=pl234',
    7,
    1,
    '/home/user/videos/sql_constraints/',
    NOW(),
    NOW()
  ),
  (
    'SQL Subqueries',
    'https://www.youtube.com/playlist?list=pl567',
    8,
    2,
    '/home/user/videos/sql_subqueries/',
    NOW(),
    NOW()
  ),
  (
    'SQL Stored Procedures',
    'https://www.youtube.com/playlist?list=pl890',
    9,
    3,
    '/home/user/videos/sql/',
    NOW(),
    NOW()
  ),
  Executing (default): CREATE TABLE IF NOT EXISTS "video_lists" (
    "video_url" VARCHAR(255) NOT NULL,
    "video_id" VARCHAR(255) NOT NULL,
    "title" VARCHAR(255) NOT NULL,
    "approximate_size" BIGINT NOT NULL,
    "downloaded" BOOLEAN NOT NULL,
    "available" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL,
    "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL,
    PRIMARY KEY ("video_url")
  );

Executing (default):
SELECT
  i.relname AS name,
  ix.indisprimary AS primary,
  ix.indisunique AS unique,
  ix.indkey AS indkey,
  array_agg(a.attnum) as column_indexes,
  array_agg(a.attname) AS column_names,
  pg_get_indexdef(ix.indexrelid) AS definition
FROM
  pg_class t,
  pg_class i,
  pg_index ix,
  pg_attribute a
WHERE
  t.oid = ix.indrelid
  AND i.oid = ix.indexrelid
  AND a.attrelid = t.oid
  AND t.relkind = 'r'
  and t.relname = 'video_lists'
GROUP BY
  i.relname,
  ix.indexrelid,
  ix.indisprimary,
  ix.indisunique,
  ix.indkey
ORDER BY
  i.relname;

Executing (default):
SELECT
  table_name
FROM
  information_schema.tables
WHERE
  table_schema = 'public'
  AND table_name = 'playlist_lists' Executing (default): CREATE TABLE IF NOT EXISTS "playlist_lists" (
    "playlist_url" VARCHAR(255) NOT NULL,
    "title" VARCHAR(255) NOT NULL,
    "playlist_index" INTEGER NOT NULL DEFAULT 0,
    "monitoring_type" TINYINT NOT NULL,
    "save_dir" VARCHAR(255) NOT NULL,
    "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL,
    "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL,
    PRIMARY KEY ("playlist_url")
  );