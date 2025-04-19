FROM ubuntu:25.04

RUN echo 'APT::Install-Suggests "0";' >> /etc/apt/apt.conf.d/00-docker

RUN echo 'APT::Install-Recommends "0";' >> /etc/apt/apt.conf.d/00-docker

ENV OPENSSL_CONF=/dev/null

RUN DEBIAN_FRONTEND=noninteractive \
    apt-get update \
    && apt-get -y upgrade \
    && apt install ca-certificates xz-utils bzip2 wget git -y \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /

COPY package.json /

COPY get-packages.sh /

COPY index.js /

ARG VITE_BASE_PATH=/ytdiff

ENV VITE_BASE_PATH=${VITE_BASE_PATH}

RUN ./get-packages.sh

RUN apt remove git ca-certificates xz-utils bzip2 -y \
    && groupadd -g 1000 ytdiff \
    && useradd -u 1000 -g ytdiff -s /bin/bash -m ytdiff

EXPOSE 8888

USER ytdiff

CMD [ "node", "index.js" ]
