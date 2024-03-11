#!/bin/bash

ARCH=$(dpkg --print-architecture)

if [ "$ARCH" = "amd64" ]; then
    echo "detected amd64"
elif [ "$ARCH" = "arm64" ]; then
    echo "detected arm64"
else
    echo "unknown architecture: $ARCH"
    exit 1
fi

if [ "$ARCH" = "amd64" ]; then
    wget "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux" -O "yt-dlp_linux"
elif [ "$ARCH" = "arm64" ]; then
    wget "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux_aarch64" -O "yt-dlp_linux"
fi

chmod +x yt-dlp_linux && mv yt-dlp_linux bin/yt-dlp

if [ "$ARCH" = "amd64" ]; then
    wget "https://github.com/yt-dlp/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz" -O "ffmpeg-master-latest-linux64-gpl.tar.xz"
elif [ "$ARCH" = "arm64" ]; then
    wget "https://github.com/yt-dlp/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linuxarm64-gpl.tar.xz" -O "ffmpeg-master-latest-linuxarm64-gpl.tar.xz"
fi

if [ "$ARCH" = "amd64" ]; then
    tar -xf ffmpeg-master-latest-linux64-gpl.tar.xz &&
        cd ffmpeg-master-latest-linux64-gpl/bin &&
        mv ffmpeg ffplay ffprobe ../../bin &&
        cd ../.. &&
        rm -rf ffmpeg-master-latest-linux64-gpl ffmpeg-master-latest-linux64-gpl.tar.xz
elif [ "$ARCH" = "arm64" ]; then
    tar -xf ffmpeg-master-latest-linuxarm64-gpl.tar.xz &&
        cd ffmpeg-master-latest-linuxarm64-gpl/bin &&
        mv ffmpeg ffplay ffprobe ../../bin &&
        cd ../.. &&
        rm -rf ffmpeg-master-latest-linuxarm64-gpl ffmpeg-master-latest-linuxarm64-gpl.tar.xz
fi

wget "https://bitbucket.org/ariya/phantomjs/downloads/phantomjs-2.1.1-linux-x86_64.tar.bz2" -O "phantomjs-2.1.1-linux-x86_64.tar.bz2"

tar -xf phantomjs-2.1.1-linux-x86_64.tar.bz2 &&
    cd phantomjs-2.1.1-linux-x86_64/bin &&
    mv phantomjs ../../bin &&
    cd ../.. &&
    rm -rf phantomjs-2.1.1-linux-x86_64.tar.bz2 phantomjs-2.1.1-linux-x86_64

if [ "$ARCH" = "amd64" ]; then
    wget "https://nodejs.org/dist/v18.19.0/node-v18.19.0-linux-x64.tar.xz" -O "node-v18.19.0-linux-x64.tar.xz"
elif [ "$ARCH" = "arm64" ]; then
    wget "https://nodejs.org/dist/v18.19.0/node-v18.19.0-linux-arm64.tar.xz" -O "node-v18.19.0-linux-arm64.tar.xz"
fi

if [ "$ARCH" = "amd64" ]; then
    tar -xf node-v18.19.0-linux-x64.tar.xz &&
        cd node-v18.19.0-linux-x64/bin &&
        mv node ../../bin &&
        cd ../.. &&
        node node-v18.19.0-linux-x64/lib/node_modules/npm/bin/npm-cli.js install
elif [ "$ARCH" = "arm64" ]; then
    tar -xf node-v18.19.0-linux-arm64.tar.xz &&
        cd node-v18.19.0-linux-arm64/bin &&
        mv node ../../bin &&
        cd ../.. &&
        node node-v18.19.0-linux-arm64/lib/node_modules/npm/bin/npm-cli.js install
fi

if [ "$ARCH" = "amd64" ]; then
    git clone -b material https://github.com/sagniKdas53/yt-diff-react frontend &&
        cd frontend &&
        node /node-v18.19.0-linux-x64/lib/node_modules/npm/bin/npm-cli.js install &&
        /node-v18.19.0-linux-x64/lib/node_modules/npm/bin/npm-cli.js run build &&
        cd .. &&
        rm -rf node-v18.19.0-linux-x64 node-v18.19.0-linux-x64.tar.xz frontend
elif [ "$ARCH" = "arm64" ]; then
    git clone -b material https://github.com/sagniKdas53/yt-diff-react frontend &&
        cd frontend &&
        node /node-v18.19.0-linux-arm64/lib/node_modules/npm/bin/npm-cli.js install &&
        /node-v18.19.0-linux-arm64/lib/node_modules/npm/bin/npm-cli.js run build &&
        cd .. &&
        rm -rf node-v18.19.0-linux-arm64 node-v18.19.0-linux-arm64.tar.xz frontend
fi
