# Search Feature Documentation

## Overview

Both the **Playlist panel** (left side) and the **SubList panel** (right side) have a search/title field. The field supports several prefix syntaxes to control how results are filtered.

---

## Playlist Panel Search

The playlist search field filters the list of playlists.

| Syntax | Behavior |
|---|---|
| `any text` | Case-insensitive **partial match** on the playlist title (default) |
| `url:youtube.com` | Partial match on the playlist **URL** |
| `title:regex` | **Regex** match on the playlist title (case-insensitive) |

### Playlist Examples
```
# Find playlists whose title contains "gaming"
gaming

# Find playlists from a specific channel URL
url:@theblackbirdcalls

# Find playlists matching a regex (titles starting with "My")
title:^My

# Find playlists with "vlog" or "gaming" in the title
title:vlog|gaming
```

---

## SubList Panel Search (Videos)

The SubList search field filters the videos shown in the right panel.

> **Important:** The `global:` prefix is the **only** prefix that works when **no playlist is loaded** (the initial `init` state). All other prefixes require a playlist to be selected first.

| Syntax | Scope | Behavior |
|---|---|---|
| `any text` | Current playlist | Case-insensitive **partial match** on the video title (default) |
| `url:youtube.com` | Current playlist | Partial match on the video **URL** |
| `title:regex` | Current playlist | **Regex** match on the video title (case-insensitive) |
| `global:regex` | **All playlists** | Regex match on the video title across **every** playlist |
| `global:` *(empty)* | **All playlists** | Returns **all videos** from every playlist |

### SubList Examples
```
# Find videos in the current playlist containing "dance"
dance

# Find videos by URL fragment
url:DhbHdN

# Find videos matching a regex in the current playlist
title:^\[Private\]

# From init (no playlist loaded): find all videos mentioning "mmd" globally
global:mmd

# From init: find all videos across every playlist
global:

# From init: find videos whose title starts with a year
global:^20[0-9]{2}
```

---

## Notes

- **Regex syntax** uses PostgreSQL case-insensitive regex (`~*`). Standard regex features like `^`, `$`, `|`, `.*`, `[...]`, `{n}` are all supported.
- **Partial match** (default / `url:`) uses SQL `ILIKE` — no regex needed, just type the fragment you're looking for.
- The `global:` prefix only bypasses the playlist filter when no playlist is loaded (`init` state). Once a playlist is selected, `global:` behaves like `title:` scoped to that playlist.
- Downloads initiated from a `global:` search will automatically resolve each video's correct **save directory** from its original playlist mapping.
