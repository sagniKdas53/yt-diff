#!/bin/bash

echo "DEBUG: Applying iwara extractor patch (PR #16014)"
IWARA_PY=$(find /home/sagnik/Projects/docker-composes/yt-diff/venv/lib -name 'iwara.py' -path '*/yt_dlp/extractor/*')
sed -i \
-e "s|'https://api\.iwara\.tv/|'https://apiq.iwara.tv/|g" \
-e 's|"https://api\.iwara\.tv/|"https://apiq.iwara.tv/|g' \
-e "s|https://files\.iwara\.tv/|https://filesq.iwara.tv/|g" \
-e "s|5nFp9kmbNnHdAFhaqMvt|mSvL05GfEmeEmsEYfGCnVpEjYgTJraJN|g" \
"$IWARA_PY"
echo "DEBUG: Iwara patch applied to $IWARA_PY"