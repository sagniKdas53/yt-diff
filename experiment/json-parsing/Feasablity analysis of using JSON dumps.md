# Feasablity analysis of using JSON returned by yt-dlp instead of --print to list items

## Exploratory Runs

### Using --flat-playlist and --print (--no-download not needed as --print prevents downloads but we can add it just in case)

```bash
yt-dlp --impersonate Chrome-133 --proxy http://proton:n436b5CXcPkrRbKADE1VUhq@192.168.0.110:3128 --playlist-start 1 --flat-playlist --print "%(title)s\t%(id)s\t%(webpage_url)s\t%(filesize_approx)s" https://www.iwara.tv/profile/zzpai/videos > flat-playlist-json-dump-unmod.csv
```
#### Advantages

- Fast

#### Disadvantages

- Often the extractors fail and gives something like `NA\tNA\thttps://iwara.tv/video/bzv4lh0gqwhlzzewo\tNA`
- `\t` can appear in a title and break stuff (possible never observed)

### Using --flat-playlist and --dump-single-json

```bash
yt-dlp --impersonate Chrome-133 --proxy http://proton:n436b5CXcPkrRbKADE1VUhq@192.168.0.110:3128 --playlist-start 1 --flat-playlist --dump-single-json https://www.iwara.tv/profile/zzpai/videos > flat-playlist-json-dump-unmod.json
```
#### Advantages

- None

#### Disadvantages

- Often the extractors fail and gives something like 
   `{
      "_type": "url",
      "url": "https://iwara.tv/video/ly4hQ335deOlq9",
      "__x_forwarded_for_ip": null
    }`
- Very slow

### Using --dump-single-json and --no-download to subtitute --flat-playlist (if nither --flat-playlist nor --no-download is passed it starts downloading everything)

```bash
yt-dlp --impersonate Chrome-133 --proxy http://proton:n436b5CXcPkrRbKADE1VUhq@192.168.0.110:3128 --no-download --playlist-start 1 --dump-single-json https://www.iwara.tv/profile/zzpai/videos > playlist-json-dump-unmod.json
```

#### Advantages

- Extractors are not used so as long as service returns proper JSON it should work

#### Disadvantages

- Very slow

### Using --dump-json and --no-download to subtitute --flat-playlist (if nither --flat-playlist nor --no-download is passed it starts downloading everything)

```bash
yt-dlp --impersonate Chrome-133 --proxy http://proton:n436b5CXcPkrRbKADE1VUhq@192.168.0.110:3128 --no-download --playlist-start 1 --dump-json https://www.iwara.tv/profile/zzpai/videos > playlist-json-dump-unmod-multipart.json
```

#### Advantages

- Extractors are not used so as long as service returns proper JSON it should work
- Fast
- Print each video item as a JSON object on a new line

#### Disadvantages

- Need to explore if there are any edge cases where this fails
- JSON parsing can be slower than printing
- Need to handle the case where the service returns an invalid JSON

## Conclusion

Add JSON parsing and use --dump-json and --no-download to subtitute --flat-playlist (as if nither --flat-playlist nor --no-download is passed it starts downloading everything) in index.ts for listing operations. This is more reliable than using --print as it does not rely on the extractors to return the correct format.

## Implementation Plan