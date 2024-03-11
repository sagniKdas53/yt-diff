#!/bin/bash

# Check if all three arguments are provided
if [ "$#" -ne 3 ]; then
  echo "Usage: $0 start_num stop_num playlist_url"
  exit 1
fi

start_num="$1"
stop_num="$2"
body_url="$3"

yt-dlp \
  --playlist-start "$start_num" \
  --playlist-end "$stop_num" \
  --flat-playlist \
  --print "%(title)s\t%(id)s\t%(webpage_url)s\t%(filesize_approx)s" \
  "$body_url"
