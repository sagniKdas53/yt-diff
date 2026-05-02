# yt-diff Database Schema

`yt-diff` utilizes **Sequelize** with a **PostgreSQL** dialect to manage its
relational data. The architecture relies on four primary tables, utilizing a
many-to-many relationship structure to map videos to playlists.

---

## 1. `VideoMetadata` (video_metadata)

This is the core table responsible for storing the specific state and metadata
of individual videos, independent of any playlist.

| Field                             | Type      | Description                                                                                                                   |
| :-------------------------------- | :-------- | :---------------------------------------------------------------------------------------------------------------------------- |
| **`videoUrl`**                    | `STRING`  | **(Primary Key)** The canonical URL of the video, normalized at ingest time (see URL Normalization below). |
| **`videoId`**                     | `STRING`  | The platform-specific unique identifier (e.g., the YouTube video ID). **Indexed** (non-unique) to support deduplication queries and the `videoId`-based fallback lookup. |
| **`title`**                       | `STRING`  | The title of the video. May temporarily hold the `videoId` if `"NA"` was returned during a flat playlist parse.               |
| **`approximateSize`**             | `BIGINT`  | Estimated file size in bytes returned blindly from the platform.                                                              |
| **`downloadStatus`**              | `BOOLEAN` | Defaults to `false`. Becomes `true` only when the physical file is verified complete on disk.                                 |
| **`isAvailable`**                 | `BOOLEAN` | Defaults to `true`. Marks if the video has been deleted, privated, or removed from the platform.                              |
| **`fileName`**                    | `STRING`  | The name of the file on the local disk (including extension). `null` if not downloaded.                                       |
| **`thumbNailFile`**               | `STRING`  | Path/Name to the downloaded thumbnail file.                                                                                   |
| **`subTitleFile`**                | `STRING`  | Path/Name to the downloaded subtitle file.                                                                                    |
| **`commentsFile`**                | `STRING`  | Path/Name to the downloaded JSON comments file.                                                                               |
| **`descriptionFile`**             | `STRING`  | Path/Name to the downloaded text description file.                                                                            |
| **`isMetaDataSynced`**            | `BOOLEAN` | Marker for secondary asynchronous processes to verify if they have finished migrating metadata from the filesystem to the DB. |
| **`onlineThumbnail`**             | `TEXT`    | Online thumbnail URL scraped from `yt-dlp` output. Used as a fallback when `thumbNailFile` is not available. `TEXT` type because some platform CDN URLs exceed 255 characters. Explicitly set to `null` for platforms with ephemeral thumbnails (see note below). |
| **`saveDirectory`**               | `STRING`  | Directory relative to `saveLocation` where this video's files are stored. `null` if not downloaded, empty string for root.    |
| **`raw_metadata`**                | `JSONB`   | Full pruned `yt-dlp` JSON output (bulky arrays like `formats`, `thumbnails`, `subtitles` are removed before storage). **Excluded from the default Sequelize scope** — must be explicitly requested in queries. |
| **`createdAt`** / **`updatedAt`** | `DATE`    | Sequelize automatic timestamps.                                                                                               |

> [!IMPORTANT]
> **Ephemeral Thumbnail Handling**: Facebook and Instagram CDN thumbnail
> URLs (`fbcdn.net` / `cdninstagram.com`) contain signed authentication tokens
> (`_nc_ohc`, `_nc_oc`, `_nc_sid`) that expire within hours to days, after which
> the URL returns `403 Forbidden`. Because storing these URLs would result in
> broken images, the `hasEphemeralThumbnails()` helper detects FB/IG video URLs
> and sets `onlineThumbnail` to `null` at ingestion time. Thumbnails from other
> platforms are **permanent** and safe to store:
>
> | Platform    | Thumbnail Host                   | Ephemeral? | Stored? |
> | :---------- | :------------------------------- | :--------- | :------ |
> | YouTube     | `i.ytimg.com`                 | No      | ✅ Yes  |
> | X / Twitter | `pbs.twimg.com`               | No      | ✅ Yes  |
> | LinkedIn    | `dms.licdn.com`               | No      | ✅ Yes  |
> | Bluesky     | `video.bsky.app`              | No      | ✅ Yes  |
> | Reddit      | `external-preview.redd.it`    | No      | ✅ Yes  |
> | Bilibili    | `i2.hdslb.com`                | No      | ✅ Yes  |
> | Rumble      | `hugh.cdn.rumble.cloud`       | No      | ✅ Yes  |
> | Odysee      | `thumbs.odycdn.com`           | No      | ✅ Yes  |
> | Facebook    | `scontent-*.xx.fbcdn.net`     | **Yes** | ❌ Skip |
> | Instagram   | `scontent-*.cdninstagram.com` | **Yes** | ❌ Skip |

---

## URL Normalization & Deduplication

The `videoUrl` primary key is **not** the raw URL submitted by the user — it is
the output of `normalizeUrl()`, which canonicalizes URLs before any database
write. This prevents duplicate records when the same video is indexed via
different URL forms.

**Normalization pipeline (applied to every inbound URL):**
1. Force `https://` protocol
2. Strip trailing slashes from pathname
3. Remove tracking/noise query parameters (`utm_*`, `fbclid`, `gclid`, `si`, `pp`)
4. Apply the first matching **site-specific canonicalizer** from the registry in `process-manager.ts`

**Built-in site rules:**

| Site | Rule |
| :--- | :--- |
| YouTube / youtu.be | Extract video ID → `https://www.youtube.com/watch?v={id}`; strip `list=`, `start_radio=`, `index=`, `si=`, `pp=` |
| iwara.tv | Strip trailing title slug: `/video/{id}/{slug}` → `/video/{id}` |
| All sites | `m.` → `www.` for YouTube mobile; force `https`; strip tracking params |

**Fallback deduplication lookup:**
If an incoming URL does not match any existing `videoUrl` PK after normalization,
a secondary lookup fires using the `videoId` field, scoped to the same domain.
This catches edge cases where normalization rules are incomplete, preventing
a duplicate `VideoMetadata` row from being created.

**Retroactive deduplication:**
Use the `POST /dedup` endpoint to scan for and merge existing duplicate groups
(same `videoId`, different `videoUrl` values). See
[API_ENDPOINTS.md](API_ENDPOINTS.md) for the request/response format.

---

## 2. `PlaylistMetadata` (playlist_metadata)

Stores high-level tracking configurations and metadata for playlists, channels,
or generic collections.

| Field                             | Type      | Description                                                                                  |
| :-------------------------------- | :-------- | :------------------------------------------------------------------------------------------- |
| **`playlistUrl`**                 | `STRING`  | **(Primary Key)** The exact URL of the playlist/channel.                                     |
| **`title`**                       | `STRING`  | The title of the playlist.                                                                   |
| **`sortOrder`**                   | `INTEGER` | Used to define the display order sequence in the frontend UI grids.                          |
| **`monitoringType`**              | `STRING`  | The background scheduled polling strategy: `"Start"`, `"End"`, `"Full"`, or `"N/A"`.         |
| **`saveDirectory`**               | `STRING`  | The target subdirectory pathway on disk for videos belonging to this playlist hierarchy.     |
| **`lastUpdatedByScheduler`**      | `DATE`    | Timestamp marking the last precise moment the background cron job executed against this URL. |
| **`createdAt`** / **`updatedAt`** | `DATE`    | Sequelize automatic timestamps.                                                              |

> [!NOTE]
> **Pseudo-Playlists**: There are a few reserved `playlistUrl` values that do not represent actual playlists:
> - **`None`**: Used for individual videos that were downloaded without a playlist context (unlisted).
> - **`init`**: A frontend-only placeholder value signifying that no specific playlist needs to be loaded by default. This should not be treated as a real playlist in backend processing.

---

## 3. `PlaylistVideoMapping` (playlist_video_mapping)

The **Junction Table** managing the Many-to-Many relationship between videos and
playlists. _A video can belong to zero (unlisted) or many playlists. A playlist
possesses many videos._

| Field                    | Type      | Description                                                                                                                         |
| :----------------------- | :-------- | :---------------------------------------------------------------------------------------------------------------------------------- |
| **`id`**                 | `UUID`    | **(Primary Key)** Autogenerated UUIDv4 for the mapping record.                                                                      |
| **`videoUrl`**           | `STRING`  | **(Foreign Key)** References `VideoMetadata.videoUrl`.                                                                              |
| **`playlistUrl`**        | `STRING`  | **(Foreign Key)** References `PlaylistMetadata.playlistUrl`.                                                                        |
| **`positionInPlaylist`** | `INTEGER` | Crucial integer tracking the exact chronological/indexed order the video appears inside the targeted playlist. Prevents scattering. |

> [!NOTE]
> **Cascading Behavior**: This table uses strict `CASCADE` rules on
> delete/update. If a `video_metadata` entry is destroyed, all mappings attached
> to it across all playlists immediately vaporize. Same rule applies to
> `playlist_metadata` deletions.

---

## 4. `UserAccount` (user_account)

Responsible for securing access to the web interface and API endpoints.

| Field              | Type     | Description                                                  |
| :----------------- | :------- | :----------------------------------------------------------- |
| **`id`**           | `UUID`   | **(Primary Key)** Autogenerated UUIDv4 identifier.           |
| **`username`**     | `STRING` | Unique login username.                                       |
| **`passwordHash`** | `STRING` | Securely hashed user password via `bcrypt`.                  |
| **`passwordSalt`** | `STRING` | The bcrypt salt generated specifically for this user's hash. |
