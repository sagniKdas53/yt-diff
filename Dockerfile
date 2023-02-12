FROM ubuntu:22.04
# This for x86_64 will make one for AArch64
# This one is made using binaries from github python one would have become too large too fast

RUN echo 'APT::Install-Suggests "0";' >> /etc/apt/apt.conf.d/00-docker

RUN echo 'APT::Install-Recommends "0";' >> /etc/apt/apt.conf.d/00-docker

RUN DEBIAN_FRONTEND=noninteractive \
    apt-get update \
    && apt install ca-certificates xz-utils wget -y 
#&& rm -rf /var/lib/apt/lists/*

WORKDIR /

COPY /ffmpeg/yt-dlp_linux /

#RUN wget "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux" -O "yt-dlp_linux"

RUN chmod +x yt-dlp_linux && mv yt-dlp_linux bin/yt-dlp

#RUN wget "https://github.com/yt-dlp/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz" -O "ffmpeg/ffmpeg-master-latest-linux64-gpl.tar.xz"

COPY /ffmpeg/ffmpeg-master-latest-linux64-gpl.tar.xz /

RUN tar -xf ffmpeg-master-latest-linux64-gpl.tar.xz \
    && cd ffmpeg-master-latest-linux64-gpl/bin \
    && mv ffmpeg ffplay ffprobe ../../bin \
    && cd ../.. \
    && rm -rf ffmpeg-master-latest-linux64-gpl ffmpeg-master-latest-linux64-gpl.tar.xz

COPY index.js index.html package-lock.json package.json favicon.ico show.html /

EXPOSE 8888

# Doing it manually to make it faster
#RUN wget "https://nodejs.org/dist/v18.12.1/node-v18.12.1-linux-x64.tar.xz" -O "node-v18.12.1-linux-x64.tar.xz"

COPY /nvm/node-v18.12.1-linux-x64.tar.xz /

RUN tar -xf node-v18.12.1-linux-x64.tar.xz  \
    && cd node-v18.12.1-linux-x64/bin \
    && mv node ../../bin \
    && cd ../.. \
    && node node-v18.12.1-linux-x64/lib/node_modules/npm/bin/npm-cli.js install \
    && rm -rf node-v18.12.1-linux-x64 node-v18.12.1-linux-x64.tar.xz \
    && sed -i 's/localhost/yt-db/g' index.js

CMD [ "node", "index.js" ]

#CMD ["tail", "-f", "/dev/null"]