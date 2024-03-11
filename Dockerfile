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

COPY package.json /

COPY get-packages.sh /

COPY index.js /

RUN ./get-packages.sh | tee exec-log.txt

RUN git clone -b material https://github.com/sagniKdas53/yt-diff-react frontend \
    && cd frontend \
    && node /node-v18.19.0-linux-x64/lib/node_modules/npm/bin/npm-cli.js install \
    && /node-v18.19.0-linux-x64/lib/node_modules/npm/bin/npm-cli.js run build \
    && cd .. \
    && rm -rf node-v18.19.0-linux-x64 node-v18.19.0-linux-x64.tar.xz frontend \
    && apt remove git ca-certificates xz-utils bzip2 wget -y \
    && groupadd -g 1000 ytdiff \
    && useradd -u 1000 -g ytdiff -s /bin/bash -m ytdiff

EXPOSE 8888

USER ytdiff

CMD [ "node", "index.js" ]
