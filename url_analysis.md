# URL Analysis and Canonicalization Rules

Based on the provided HTML file, I have aggregated the URLs, categorized them by domain, and derived patterns to establish canonicalization rules. These rules will be useful for deduplication, consistent indexing, and preventing redundant downloads.

## 1. YouTube

### Patterns Identified
**Videos:**
- Standard: `https://www.youtube.com/watch?v=PexSJ31niEI&list=...&pp=...`
- Shortened: `https://youtu.be/PexSJ31niEI?si=...`
- Mobile: `https://m.youtube.com/watch?v=PexSJ31niEI`
- Shorts: `https://www.youtube.com/shorts/jG9GuSUuHW0?si=...`

**Playlists/Channels:**
- Playlists: `https://www.youtube.com/playlist?list=PL4Oo6...`
- Channels: `https://www.youtube.com/@purevert/videos`, `https://www.youtube.com/@KamisatoFayato/shorts`

### Canonicalization Rules
**Videos:**
1. **Normalize Domain:** Convert `youtu.be` and `m.youtube.com` to `www.youtube.com`.
2. **Normalize Path:** Convert `/shorts/<ID>` to `/watch?v=<ID>`.
3. **Strip Queries:** Remove context/tracking parameters like `list`, `index`, `pp`, `si`, and `t`.
4. **Canonical Format:** `https://www.youtube.com/watch?v=<VIDEO_ID>`

**Playlists:**
1. **Strip Queries:** Remove all parameters other than `list`.
2. **Canonical Format:** `https://www.youtube.com/playlist?list=<PLAYLIST_ID>`
3. **Channels:** Maintain as `https://www.youtube.com/@<CHANNEL_NAME>/videos` or `/shorts`.

---

## 2. Iwara

### Patterns Identified
**Videos:**
- With slug: `https://www.iwara.tv/video/t8Un1BJoaDtvf6/burning-desires-dance`
- Without slug: `https://www.iwara.tv/video/eM56mFi2iRQT3J`
- With playlist query: `https://www.iwara.tv/video/9GHTbsaxV01DRD/new-costume-as?playlist=f125...`

**Playlists/Profiles:**
- Playlists: `https://www.iwara.tv/playlist/59b167e5-...`
- Profiles: `https://www.iwara.tv/profile/zzzwen/videos?sort=date&page=1`

### Canonicalization Rules
**Videos:**
1. **Strip Slug:** Remove the descriptive slug after the ID (e.g., `/burning-desires-dance`).
2. **Strip Queries:** Remove `playlist` and other tracking parameters.
3. **Canonical Format:** `https://www.iwara.tv/video/<VIDEO_ID>`

**Playlists/Profiles:**
1. **Strip Queries:** Remove pagination and sorting (`sort`, `page`).
2. **Canonical Format:** `https://www.iwara.tv/profile/<USERNAME>/videos` or `https://www.iwara.tv/playlist/<PLAYLIST_ID>`.

---

## 3. Spankbang

### Patterns Identified
**Videos:**
- With slug: `https://spankbang.com/a49d0/video/busty+japanese...`
- Without slug: `https://spankbang.com/a4g57/video`

**Playlists:**
- `https://spankbang.com/cwsbz/playlist/japanese+3/`
- Tracking suffix on ID: `https://spankbang.com/b47f4-nohrcs/playlist/porn`

**Profiles:**
- `https://spankbang.com/profile/xxg727/videos?o=new&p=5`

### Canonicalization Rules
**Videos:**
1. **Strip Slug:** Remove the descriptive text after `/video/`.
2. **Canonical Format:** `https://spankbang.com/<VIDEO_ID>/video`

**Playlists:**
1. **Strip Slug:** Remove the descriptive text after `/playlist/`.
2. **Clean ID Suffix:** Strip tracking appended to the ID (e.g., `-nohrcs`).
3. **Canonical Format:** `https://spankbang.com/<PLAYLIST_ID>/playlist`

**Profiles:**
1. **Strip Queries:** Remove sorting and pagination (`o`, `p`).
2. **Canonical Format:** `https://spankbang.com/profile/<USERNAME>/videos`

---

## 4. XHamster

### Patterns Identified
**Videos:**
- `https://xhamster.com/videos/18-year-student-real-desi-...-xhxHPqk`

**Creators (Playlists):**
- Base: `https://xhamster.com/creators/sir`
- Tab: `https://xhamster.com/creators/sir/newest`

### Canonicalization Rules
**Videos:**
1. **Retain Slug:** xHamster relies on the URL slug as part of the page resolution, so retain the full path but strip any queries if present.
2. **Canonical Format:** `https://xhamster.com/videos/<SLUG_AND_ID>`

**Creators:**
1. **Strip Tabs:** Remove sorting tabs or sub-paths like `/newest`.
2. **Canonical Format:** `https://xhamster.com/creators/<CREATOR_NAME>`

---

## 5. Pornhub

### Patterns Identified
**Videos:** `https://www.pornhub.com/view_video.php?viewkey=69b199b22948f`
**Models:** `https://www.pornhub.com/model/damien-soft/videos`

### Canonicalization Rules
**Videos:**
1. **Strip Extra Queries:** Keep only the `viewkey` parameter. Remove trackers.
2. **Canonical Format:** `https://www.pornhub.com/view_video.php?viewkey=<VIEWKEY>`

**Models:**
1. **Canonical Format:** `https://www.pornhub.com/model/<MODEL_NAME>/videos`

---

## 6. General / Others (Social Media, Forums)

### Patterns Identified
- **Reddit:** `https://www.reddit.com/r/interestingasfuck/comments/1sw4dpt/.../?utm_source=share...`
- **LinkedIn:** `https://www.linkedin.com/posts/.../?utm_source=...&rcm=...`
- **X (Twitter):** `https://x.com/daibao103_/status/2049494478768193694?s=20`
- **Bluesky:** `https://bsky.app/profile/.../post/...`
- **PeerTube:** `https://peertube.tv/videos/watch/bk5EEJV...`
- **NoodleMagazine:** `https://noodlemagazine.com/watch/-202231775_456243619`

### Canonicalization Rules
1. **Strip All UTM and Tracking Queries:** Ensure tracking parameters like `utm_*`, `si`, `s`, `rcm`, etc., are dropped.
2. **Reddit:** Normalize to `https://www.reddit.com/r/<SUBREDDIT>/comments/<POST_ID>/` (Stripping the slug improves deduplication).
3. **X (Twitter):** Normalize to `https://x.com/<USER>/status/<STATUS_ID>`
4. **LinkedIn:** Normalize to `https://www.linkedin.com/posts/<POST_SLUG_ID>` (Keep path, strip queries).
