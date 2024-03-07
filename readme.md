# yt-dlp-diff-maker

yt-dlp bundled with a node-js server and somewhat usable UI to download vidoes from youtube and some other site (Didn't test extensively).

## How to start?

1. Modify the docker compose as needed and fill the .env
2. `docker-compose up -d --build`

## To use a vpn

1. Modify the docker compose as needed and fill the .env in the vpn-mode folder
2. `docker-compose up -d --build`

### Test VPN by using

VPN will need more testing before it's implemented. [TODO]

## Usage

TODO

## Commands that run thw whole thing

### List

```bash
yt-dlp --playlist-start {start_num} --playlist-end {stop_num} --flat-playlist \
 --print "%(title)s\t%(id)s\t%(webpage_url)s" {body_url}
```

### Test

```bash
yt-dlp --playlist-start 1 --playlist-end 2 --flat-playlist \
 --print "%(title)s\t%(id)s\t%(webpage_url)s\t%(filesize)s\t%(filesize_approx)s" https://www.youtube.com/playlist?list=PL4Oo6H2hGqj0YkYoOLFmrbhsVWfAjCLZw
```

```log
Yes... this Voice Line is actually in the game\tK1VVWJrpDgs\thttps://www.youtube.com/watch?v=K1VVWJrpDgs\tNA\tNA
Yes... this Voice Line is actually in the game\tK1VVWJrpDgs\thttps://www.youtube.com/watch?v=K1VVWJrpDgs\tNA\tNA
```


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