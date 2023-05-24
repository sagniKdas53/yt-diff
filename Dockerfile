FROM ubuntu:22.10

RUN echo 'APT::Install-Suggests "0";' >> /etc/apt/apt.conf.d/00-docker

RUN echo 'APT::Install-Recommends "0";' >> /etc/apt/apt.conf.d/00-docker

ENV OPENSSL_CONF=/dev/null

RUN DEBIAN_FRONTEND=noninteractive \
    apt-get update \
    && apt install ca-certificates xz-utils bzip2 wget git -y \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /

RUN wget "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux" -O "yt-dlp_linux"

RUN chmod +x yt-dlp_linux && mv yt-dlp_linux bin/yt-dlp

RUN wget "https://github.com/yt-dlp/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz" -O "ffmpeg-master-latest-linux64-gpl.tar.xz"

RUN tar -xf ffmpeg-master-latest-linux64-gpl.tar.xz \
    && cd ffmpeg-master-latest-linux64-gpl/bin \
    && mv ffmpeg ffplay ffprobe ../../bin \
    && cd ../.. \
    && rm -rf ffmpeg-master-latest-linux64-gpl ffmpeg-master-latest-linux64-gpl.tar.xz

# Sometimes the download fails, it's bitbuckets fault most of the time
RUN wget "https://files.catbox.moe/mkb5pq.bz2" -O "phantomjs-2.1.1-linux-x86_64.tar.bz2"

RUN tar -xf phantomjs-2.1.1-linux-x86_64.tar.bz2 \
    && cd phantomjs-2.1.1-linux-x86_64/bin \
    && mv phantomjs ../../bin \
    && cd ../.. \
    && rm -rf phantomjs-2.1.1-linux-x86_64.tar.bz2 phantomjs-2.1.1-linux-x86_64

RUN wget "https://nodejs.org/dist/v18.12.1/node-v18.12.1-linux-x64.tar.xz" -O "node-v18.12.1-linux-x64.tar.xz"

COPY package.json /

RUN tar -xf node-v18.12.1-linux-x64.tar.xz  \
    && cd node-v18.12.1-linux-x64/bin \
    && mv node ../../bin \
    && cd ../.. \
    && node node-v18.12.1-linux-x64/lib/node_modules/npm/bin/npm-cli.js install

COPY index.js /

RUN git clone -b material https://github.com/sagniKdas53/yt-diff-react frontend

RUN cd frontend \
    && node /node-v18.12.1-linux-x64/lib/node_modules/npm/bin/npm-cli.js install \
    && /node-v18.12.1-linux-x64/lib/node_modules/npm/bin/npm-cli.js run build \
    && cd .. \
    && rm -rf node-v18.12.1-linux-x64 node-v18.12.1-linux-x64.tar.xz frontend

EXPOSE 8888

RUN groupadd -g 1000 ytdiff && \
    useradd -u 1000 -g ytdiff -s /bin/bash -m ytdiff

USER ytdiff

CMD [ "node", "index.js" ]
