FROM ubuntu:22.04

RUN echo 'APT::Install-Suggests "0";' >> /etc/apt/apt.conf.d/00-docker

RUN echo 'APT::Install-Recommends "0";' >> /etc/apt/apt.conf.d/00-docker

ENV OPENSSL_CONF=/dev/null

RUN DEBIAN_FRONTEND=noninteractive \
    apt-get update \
    && apt-get -y upgrade \
    && apt install ca-certificates xz-utils bzip2 wget git -y \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /

ARG ARCH=$(dpkg --print-architecture)

RUN if [ "$ARCH" = "amd64" ]; then \
    wget "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux" -O "yt-dlp_linux" \
    elif [ "$ARCH" = "arm64" ]; then \
    wget "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux_aarch64" -O "yt-dlp_linux" \
    fi

RUN chmod +x yt-dlp_linux && mv yt-dlp_linux bin/yt-dlp

RUN if [ "$ARCH" = "amd64" ]; then \
    wget "https://github.com/yt-dlp/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz" -O "ffmpeg-master-latest-linux64-gpl.tar.xz"; \
    elif [ "$ARCH" = "arm64" ]; then \
    wget "https://github.com/yt-dlp/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linuxarm64-gpl.tar.xz" -O "ffmpeg-master-latest-linuxarm64-gpl.tar.xz"; \
    fi

RUN if [ "$ARCH" = "amd64" ]; then \
    tar -xf ffmpeg-master-latest-linux64-gpl.tar.xz \
    && cd ffmpeg-master-latest-linux64-gpl/bin \
    && mv ffmpeg ffplay ffprobe ../../bin \
    && cd ../.. \
    && rm -rf ffmpeg-master-latest-linux64-gpl ffmpeg-master-latest-linux64-gpl.tar.xz; \
    elif [ "$ARCH" = "arm64" ]; then \
    tar -xf ffmpeg-master-latest-linuxarm64-gpl.tar.xz \
    && cd ffmpeg-master-latest-linuxarm64-gpl/bin \
    && mv ffmpeg ffplay ffprobe ../../bin \
    && cd ../.. \
    && rm -rf ffmpeg-master-latest-linuxarm64-gpl ffmpeg-master-latest-linuxarm64-gpl.tar.xz; \
    fi

# Sometimes the download fails, it's bitbuckets not having bandwidth most of the time
RUN wget "https://bitbucket.org/ariya/phantomjs/downloads/phantomjs-2.1.1-linux-x86_64.tar.bz2" -O "phantomjs-2.1.1-linux-x86_64.tar.bz2"

RUN tar -xf phantomjs-2.1.1-linux-x86_64.tar.bz2 \
    && cd phantomjs-2.1.1-linux-x86_64/bin \
    && mv phantomjs ../../bin \
    && cd ../.. \
    && rm -rf phantomjs-2.1.1-linux-x86_64.tar.bz2 phantomjs-2.1.1-linux-x86_64

COPY package.json /

RUN if [ "$ARCH" = "amd64" ]; then \
    wget "https://nodejs.org/dist/v18.19.0/node-v18.19.0-linux-x64.tar.xz" -O "node-v18.19.0-linux-x64.tar.xz"; \
    elif [ "$ARCH" = "arm64" ]; then \
    wget "https://nodejs.org/dist/v18.19.0/node-v18.19.0-linux-arm64.tar.xz" -O "node-v18.19.0-linux-arm64.tar.xz"; \
    fi

RUN if [ "$ARCH" = "amd64" ]; then \
    tar -xf node-v18.19.0-linux-x64.tar.xz \
    && cd node-v18.19.0-linux-x64/bin \
    && mv node ../../bin \
    && cd ../.. \
    && node node-v18.19.0-linux-x64/lib/node_modules/npm/bin/npm-cli.js install \
    elif [ "$ARCH" = "arm64" ]; then \
    tar -xf node-v18.19.0-linux-arm64.tar.xz \
    && cd node-v18.19.0-linux-arm64/bin \
    && mv node ../../bin \
    && cd ../.. \
    && node node-v18.19.0-linux-arm64/lib/node_modules/npm/bin/npm-cli.js install \
    fi

COPY index.js /

RUN git clone -b material https://github.com/sagniKdas53/yt-diff-react frontend

RUN cd frontend \
    && node /node-v18.19.0-linux-x64/lib/node_modules/npm/bin/npm-cli.js install \
    && /node-v18.19.0-linux-x64/lib/node_modules/npm/bin/npm-cli.js run build \
    && cd .. \
    && rm -rf node-v18.19.0-linux-x64 node-v18.19.0-linux-x64.tar.xz frontend

RUN apt remove git ca-certificates xz-utils bzip2 wget -y

EXPOSE 8888

RUN groupadd -g 1000 ytdiff \
    && useradd -u 1000 -g ytdiff -s /bin/bash -m ytdiff

USER ytdiff

CMD [ "node", "index.js" ]
