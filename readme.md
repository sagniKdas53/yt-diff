# yt-diff

[![Build](https://github.com/sagniKdas53/yt-diff/actions/workflows/docker-image.yml/badge.svg)](https://github.com/sagniKdas53/yt-diff/actions/workflows/docker-image.yml)

yt-dlp bundled with a node-js server and somewhat usable UI made in react and mui. It's used to download videos from youtube and some other site almost all of the ones supported by yt-dlp.

[See all supported sites](https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md)

## Requirements

- Node.js
- Docker Compose or Docker to use postgres (Can be installed on system directly)
- Linux (Not tested on Windows)
- yt-dlp (Installed with `pip install yt-dlp`)
- yt-diff (this project)
- ffmpeg (optional)
- Watchtower (optional)
- phantomjs (optional)

## How to use?

Populate the .env file with the following variables


### Building the docker image

Amd64:

```bash
docker build --build-arg VITE_BASE_PATH="/ytdiff" --no-cache -t purevert/yt-diff:amd64 .
```
Alpine-amd64:

```bash
docker build --build-arg VITE_BASE_PATH="/ytdiff" --build-arg ARCH=amd64 --file Dockerfile.alpine  --no-cache -t purevert/yt-diff:amd64-alpine .
```

### Using pre-built image

This is built using github actions replace it in docker-compose.yml and just run 

```bash
docker-compose up -d
```

#### Github container registry (ghcr.io)`ghcr.io/sagnikdas53/yt-diff:master`

## Usage

TODO

## Commands that run the whole thing

### List

```bash
yt-dlp --playlist-start {start_num} --playlist-end {stop_num} --flat-playlist \
    --print "%(title)s\t%(id)s\t%(webpage_url)s\t%(filesize)s\t%(filesize_approx)s" {body_url}
```

### Download

```bash
yt-dlp --embed-metadata --write-subs --write-auto-subs --write-description \
    --write-comments --write-thumbnail --paths {save_path} {body_url}
```

### Example

Executing this command will return a list of some of the videos in the playlist
```bash
yt-dlp --playlist-start 1 --playlist-end 2 --flat-playlist \
 --print "%(title)s\t%(id)s\t%(webpage_url)s\t%(filesize)s\t%(filesize_approx)s" https://www.youtube.com/playlist?list=PL4Oo6H2hGqj0YkYoOLFmrbhsVWfAjCLZw
```
Output:
```log
Yes... this Voice Line is actually in the game\tK1VVWJrpDgs\thttps://www.youtube.com/watch?v=K1VVWJrpDgs\tNA\tNA
Yes... this Voice Line is actually in the game\tK1VVWJrpDgs\thttps://www.youtube.com/watch?v=K1VVWJrpDgs\tNA\tNA
```

### Database Queries

```sql
SELECT *
FROM video_indexers
INNER JOIN video_lists ON video_indexers.video_url = video_lists.video_url
WHERE video_indexers.playlist_url = 'https://www.youtube.com/playlist?list=PL4Oo6H2hGqj3qXOV_XHT_FVR-e0gvkhtJ'
ORDER BY index_in_playlist DESC;
```


```sql
SELECT DISTINCT video_lists.video_url,video_indexers.index_in_playlist,video_lists.title,video_indexers."createdAt",video_indexers."updatedAt"
FROM video_indexers
INNER JOIN video_lists ON video_indexers.video_url = video_lists.video_url
WHERE video_indexers.playlist_url = 'https://www.youtube.com/playlist?list=PLyIwTNqpN_9ZKZoQ8XzADGtbuVtbsTCjH'
ORDER BY video_indexers."updatedAt" DESC
LIMIT 50
```
### Experimental

Trying out this logging format

```bash
yt-dlp --progress-template "download:[download] %(progress._percent_str)s of %(progress._total_bytes_str)s at %(progress._speed_str)s ETA %(progress._eta_str)s" https://www.youtube.com/watch?v=K1VVWJrpDgs
```