FROM ubuntu:22.04
# This for x86_64 will make one for AArch64

LABEL name="yt-dlp-x86_64" 

RUN echo 'APT::Install-Suggests "0";' >> /etc/apt/apt.conf.d/00-docker

RUN echo 'APT::Install-Recommends "0";' >> /etc/apt/apt.conf.d/00-docker

RUN DEBIAN_FRONTEND=noninteractive \
    && rm -rf /var/lib/apt/lists/*

ADD https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux /

RUN chmod +x yt-dlp_linux

RUN mv yt-dlp_linux bin/

#RUN pip install -U yt-dlp

ADD https://github.com/yt-dlp/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz /

RUN ls 

RUN tar -xvf ffmpeg-master-latest-linux64-gpl.tar.xz

RUN cd ffmpeg-master-latest-linux64-gpl/bin

RUN mv ffmpeg ffplay ffprobe ../../bin

ENTRYPOINT ["tail", "-f", "/dev/null"]