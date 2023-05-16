-- Adminer 4.8.1 PostgreSQL 14.7 (Debian 14.7-1.pgdg110+1) dump
DROP TABLE IF EXISTS "playlist_list";

CREATE TABLE "public"."playlist_list" (
    "title" character varying(255) NOT NULL,
    "playlist_url" character varying(255) NOT NULL,
    "order_added" integer DEFAULT '0' NOT NULL,
    "monitoring_type" smallint NOT NULL,
    "save_dir" character varying(255) NOT NULL,
    "createdat" date NOT NULL,
    "updatedat" date NOT NULL,
    CONSTRAINT "playlist_list_pkey" PRIMARY KEY ("playlist_url")
) WITH (oids = false);

INSERT INTO
    "playlist_list" (
        "title",
        "playlist_url",
        "order_added",
        "monitoring_type",
        "save_dir",
        "createdat",
        "updatedat"
    )
VALUES
    (
        'SQL Basics',
        'https://www.youtube.com/playlist?list=pl456',
        0,
        1,
        'SQLBasics',
        '2023-05-15',
        '2023-05-15'
    ),
    (
        'SQL Advanced',
        'https://www.youtube.com/playlist?list=pl789',
        1,
        1,
        'pl789',
        '2023-05-15',
        '2023-05-15'
    );

DROP TABLE IF EXISTS "playlist_video_indexer";

DROP SEQUENCE IF EXISTS playlist_video_indexer_id_seq;

CREATE SEQUENCE playlist_video_indexer_id_seq INCREMENT 1 MINVALUE 1 MAXVALUE 2147483647 CACHE 1;

CREATE TABLE "public"."playlist_video_indexer" (
    "id" integer DEFAULT nextval('playlist_video_indexer_id_seq') NOT NULL,
    "video_url" character varying(255) NOT NULL,
    "playlist_url" character varying(255) NOT NULL,
    "index_in_playlist" integer NOT NULL,
    CONSTRAINT "playlist_video_indexer_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "playlist_video_indexer_video_url_playlist_url_index_in_playlist" UNIQUE ("video_url", "playlist_url", "index_in_playlist")
) WITH (oids = false);

INSERT INTO
    "playlist_video_indexer" (
        "id",
        "video_url",
        "playlist_url",
        "index_in_playlist"
    )
VALUES
    (
        1,
        'https://www.youtube.com/watch?v=def456',
        'https://www.youtube.com/playlist?list=pl789',
        2
    ),
    (
        2,
        'https://www.youtube.com/watch?v=def456',
        'https://www.youtube.com/playlist?list=pl789',
        1
    ),
    (
        4,
        'https://www.youtube.com/watch?v=abc123',
        'https://www.youtube.com/playlist?list=pl456',
        1
    );

DROP TABLE IF EXISTS "video_list";

CREATE TABLE "public"."video_list" (
    "video_url" character varying(255) NOT NULL,
    "video_id" character varying(255) NOT NULL,
    "title" character varying(255) NOT NULL,
    "downloaded" boolean NOT NULL,
    "available" boolean NOT NULL,
    "createdat" date NOT NULL,
    "updatedat" date NOT NULL,
    CONSTRAINT "video_list_pkey" PRIMARY KEY ("video_url")
) WITH (oids = false);

INSERT INTO
    "video_list" (
        "video_url",
        "video_id",
        "title",
        "downloaded",
        "available",
        "createdat",
        "updatedat"
    )
VALUES
    (
        'https://www.youtube.com/watch?v=abc123',
        'abc123',
        'Introduction to SQL',
        'f',
        't',
        '2023-05-15',
        '2023-05-15'
    ),
    (
        'https://www.youtube.com/watch?v=def456',
        'def456',
        'Advanced SQL Queries',
        'f',
        't',
        '2023-05-15',
        '2023-05-15'
    );

ALTER TABLE
    ONLY "public"."playlist_video_indexer"
ADD
    CONSTRAINT "playlist_video_indexer_playlist_url_fkey" FOREIGN KEY (playlist_url) REFERENCES playlist_list(playlist_url) ON UPDATE CASCADE ON DELETE CASCADE NOT DEFERRABLE;

ALTER TABLE
    ONLY "public"."playlist_video_indexer"
ADD
    CONSTRAINT "playlist_video_indexer_video_url_fkey" FOREIGN KEY (video_url) REFERENCES video_list(video_url) ON UPDATE CASCADE ON DELETE CASCADE NOT DEFERRABLE;

-- 2023-05-15 09:55:35.527117+00
-- Inner join test
SELECT
    video_list.video_url,
    video_list.video_id,
    video_list.title,
    video_list.downloaded,
    video_list.available,
    playlist_video_indexer.playlist_url,
    playlist_video_indexer.index_in_playlist
FROM
    video_list
    INNER JOIN playlist_video_indexer ON video_list.video_url = playlist_video_indexer.video_url
ORDER BY
    playlist_video_indexer.index_in_playlist ASC 
    
-- Inner join with where clause
SELECT
    video_list.title,
    video_list.video_id,
    video_list.video_url,
    video_list.downloaded,
    video_list.available,
    playlist_video_indexer.playlist_url,
    playlist_video_indexer.index_in_playlist
FROM
    video_list
    INNER JOIN playlist_video_indexer ON video_list.video_url = playlist_video_indexer.video_url
WHERE
    playlist_video_indexer.playlist_url = 'https://www.youtube.com/playlist?list=pl789'
ORDER BY
    playlist_video_indexer.index_in_playlist ASC;

-- Two joins which can query all the data needed
SELECT
    *
FROM
    video_list
    INNER JOIN playlist_video_indexer ON video_list.video_url = playlist_video_indexer.video_url
    INNER JOIN playlist_list ON playlist_list.playlist_url = playlist_video_indexer.playlist_url
WHERE
    playlist_video_indexer.playlist_url = 'https://www.youtube.com/playlist?list=pl789'
ORDER BY
    playlist_video_indexer.index_in_playlist ASC;

-- Sequelize 
SELECT
    "video_list".*,
    "playlist_video_indexers"."id" AS "playlist_video_indexers.id",
    "playlist_video_indexers"."playlist_url" AS "playlist_video_indexers.playlist_url",
    "playlist_video_indexers"."index_in_playlist" AS "playlist_video_indexers.index_in_playlist"
FROM
    (
        SELECT
            "video_list"."title",
            "video_list"."video_id",
            "video_list"."video_url",
            "video_list"."downloaded",
            "video_list"."available"
        FROM
            "video_lists" AS "video_list"
        WHERE
            (
                SELECT
                    "video_url"
                FROM
                    "playlist_video_indexers" AS "playlist_video_indexers"
                WHERE
                    (
                        "playlist_video_indexers"."playlist_url" = 'None'
                        AND "playlist_video_indexers"."video_url" = "video_list"."video_url"
                    )
                LIMIT
                    1
            ) IS NOT NULL
        LIMIT
            10 OFFSET 0
    ) AS "video_list"
    INNER JOIN "playlist_video_indexers" AS "playlist_video_indexers" ON "video_list"."video_url" = "playlist_video_indexers"."video_url"
    AND "playlist_video_indexers"."playlist_url" = 'None'
ORDER BY
    "playlist_video_indexers"."index_in_playlist" ASC;