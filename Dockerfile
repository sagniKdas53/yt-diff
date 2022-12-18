FROM ubuntu:22.04
# This for x86_64 will make one for AArch64
# This one is made using binaries from github python one would have become too large too fast

LABEL name="yt-dlp-x86_64" 

RUN echo 'APT::Install-Suggests "0";' >> /etc/apt/apt.conf.d/00-docker

RUN echo 'APT::Install-Recommends "0";' >> /etc/apt/apt.conf.d/00-docker

RUN DEBIAN_FRONTEND=noninteractive \
    apt-get update \
    && apt install ca-certificates xz-utils wget -y 
#&& rm -rf /var/lib/apt/lists/*

WORKDIR /

COPY /ffmpeg/yt-dlp_linux /

#RUN wget "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux" -O "yt-dlp_linux"

RUN chmod +x yt-dlp_linux && mv yt-dlp_linux bin/

#RUN wget "https://github.com/yt-dlp/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz" -O "ffmpeg/ffmpeg-master-latest-linux64-gpl.tar.xz"

COPY /ffmpeg/ffmpeg-master-latest-linux64-gpl.tar.xz /

RUN tar -xf ffmpeg-master-latest-linux64-gpl.tar.xz \
    && cd ffmpeg-master-latest-linux64-gpl/bin \
    && mv ffmpeg ffplay ffprobe ../../bin \
    && cd ../.. \
    && rm -rf ffmpeg-master-latest-linux64-gpl ffmpeg-master-latest-linux64-gpl.tar.xz

CMD ["tail", "-f", "/dev/null"]