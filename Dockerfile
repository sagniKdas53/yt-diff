# Stage 0: Define global arguments
# Automatically set by Docker BuildKit to 'amd64', 'arm64', etc.
ARG TARGETARCH
ARG NODE_VERSION=22.20.0
ARG VITE_BASE_PATH=/ytdiff

# ---- Stage 1: Prebuilt Binaries Builder ----
# This stage downloads/extracts ffmpeg and phantomjs
FROM debian:stable-slim AS prebuilt-binaries-builder

ARG TARGETARCH

# Install essential tools for downloading and extraction
RUN echo 'APT::Get::Install-Recommends "false"; APT::Get::Install-Suggests "false";' > /etc/apt/apt.conf.d/00-no-extras && \
    DEBIAN_FRONTEND=noninteractive apt-get update && \
    apt-get -y upgrade && \
    apt-get install -y wget ca-certificates xz-utils bzip2 --no-install-recommends && \
    mkdir -p /dist/bin && \
    cd /tmp && \
    # Download FFmpeg
    FFMPEG_ARCH_SUFFIX="linux64" && \
    if [ "$TARGETARCH" = "arm64" ]; then FFMPEG_ARCH_SUFFIX="linuxarm64"; fi && \
    wget "https://github.com/yt-dlp/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-${FFMPEG_ARCH_SUFFIX}-gpl.tar.xz" -O "ffmpeg.tar.xz" && \
    tar -xf ffmpeg.tar.xz && \
    mv ffmpeg-master-latest-${FFMPEG_ARCH_SUFFIX}-gpl/bin/ffmpeg ffmpeg-master-latest-${FFMPEG_ARCH_SUFFIX}-gpl/bin/ffprobe ffmpeg-master-latest-${FFMPEG_ARCH_SUFFIX}-gpl/bin/ffplay /dist/bin/ && \
    # Download PhantomJS (Note: x86_64 only from this source, will be skipped on ARM64)
    if [ "$TARGETARCH" = "amd64" ]; then \
    wget "https://bitbucket.org/ariya/phantomjs/downloads/phantomjs-2.1.1-linux-x86_64.tar.bz2" -O "phantomjs.tar.bz2" && \
    tar -xf phantomjs.tar.bz2 && \
    mv phantomjs-2.1.1-linux-x86_64/bin/phantomjs /dist/bin/phantomjs; \
    else \
    echo "INFO: Skipping PhantomJS for $TARGETARCH as only x86_64 binary is available from the script's original source."; \
    fi && \
    # Cleanup build dependencies and downloaded files
    cd / && rm -rf /tmp/* && \
    apt-get purge -y wget xz-utils bzip2 && \
    apt-get autoremove -y --purge && \
    rm -rf /var/lib/apt/lists/*

# ---- Stage 2: Frontend Builder ----
# This stage builds the React frontend
FROM node:${NODE_VERSION}-slim AS frontend-builder

ARG VITE_BASE_PATH
ENV VITE_BASE_PATH=${VITE_BASE_PATH}

WORKDIR /app

# Install git for cloning the repository
RUN apt-get update && \
    apt-get install -y git ca-certificates --no-install-recommends && \
    rm -rf /var/lib/apt/lists/*

# Clone the frontend repository, install dependencies, and build
# Assuming the frontend has its own package.json
RUN git clone -b material https://github.com/sagniKdas53/yt-diff-react ./frontend_src
WORKDIR /app/frontend_src
RUN npm install
RUN npm run build

# ---- Stage 3: Final Application Image ----
FROM debian:stable-slim AS final

ARG TARGETARCH
ARG NODE_VERSION
ARG VITE_BASE_PATH

ENV LANG=C.UTF-8
ENV NODE_ENV=production
ENV OPENSSL_CONF=/dev/null
ENV VITE_BASE_PATH=${VITE_BASE_PATH}

WORKDIR /app

# Apply APT settings to avoid recommends/suggests
RUN echo 'APT::Get::Install-Recommends "false"; APT::Get::Install-Suggests "false";' > /etc/apt/apt.conf.d/00-no-extras

# Install runtime dependencies:
# - ca-certificates: for HTTPS
# - tini: as an init process
# - wget & xz-utils: for Node.js download
# - python3 & python3-pip: for yt-dlp and its dependencies
RUN DEBIAN_FRONTEND=noninteractive apt-get update && \
    apt-get -y upgrade && \
    apt-get install -y ca-certificates tini wget xz-utils python3 python3-pip python3-venv --no-install-recommends && \
    # Install Node.js runtime
    NODE_ARCH="" && \
    if [ "$TARGETARCH" = "amd64" ]; then NODE_ARCH="x64"; \
    elif [ "$TARGETARCH" = "arm64" ]; then NODE_ARCH="arm64"; \
    else echo "ERROR: Unsupported TARGETARCH for Node.js: $TARGETARCH"; exit 1; fi && \
    wget "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz" -O node.tar.xz && \
    tar -xJf node.tar.xz --strip-components=1 -C /usr/local && \
    rm node.tar.xz && \
    # Install yt-dlp and its dependencies using pip
    echo "DEBUG: Creating Python virtual environment at /opt/venv" && \
    python3 -m venv /opt/venv && \
    # Now, use the pip from the venv to install packages
    echo "DEBUG: Upgrading pip inside venv" && \
    /opt/venv/bin/pip install --no-cache-dir --upgrade pip && \
    # Install yt-dlp with default dependencies, yt-dlp-ejs, and curl_cffi
    echo "DEBUG: Installing yt-dlp, ejs, and curl_cffi into venv" && \
    /opt/venv/bin/pip install --no-cache-dir 'yt-dlp[default]' yt-dlp-ejs curl_cffi && \
    # Verify yt-dlp installation
    echo "DEBUG: Checking yt-dlp version:" && \
    /opt/venv/bin/yt-dlp --version && \
    # Verify npm is installed and working from the manually installed Node.js
    echo "DEBUG: Checking npm version in final stage after Node.js install:" && \
    /usr/local/bin/npm --version && \
    # Cleanup build dependencies for Node.js installation and apt cache
    apt-get purge -y xz-utils && \
    apt-get autoremove -y --purge && \
    rm -rf /var/lib/apt/lists/*

# This ensures that when the script runs 'yt-dlp', it finds the one we just installed in /opt/venv/bin/yt-dlp
ENV PATH="/opt/venv/bin:$PATH"

# Copy prebuilt binaries (ffmpeg, phantomjs) from the prebuilt-binaries-builder stage
COPY --from=prebuilt-binaries-builder /dist/bin/* /usr/local/bin/

# Copy built frontend assets from the frontend-builder stage
# IMPORTANT: Adjust './public' if your Node.js server (index.js) expects frontend assets in a different directory (e.g., './frontend/dist' or similar)
COPY --from=frontend-builder /app/dist ./dist

# Copy backend application files (package.json, package-lock.json if it exists, and index.js)
# Ensure these files are in the same directory as your Dockerfile when building
COPY package.json package-lock.json* ./
COPY index.js ./

# Install backend Node.js dependencies for production
RUN npm install --omit=dev

# Create a non-root user and group for running the application
RUN groupadd ytdiff --gid=1000 && \
    useradd --system --shell /bin/false --gid 1000 --uid 1000 --home /home/ytdiff ytdiff && \
    # Create cache directory with proper permissions
    mkdir -p /home/ytdiff/.cache/yt-dlp && \
    chown -R ytdiff:ytdiff /home/ytdiff && \
    # Ensure the app directory exists and set ownership
    mkdir -p /app && chown -R ytdiff:ytdiff /app

USER ytdiff

EXPOSE 8888

# Use tini as the entrypoint to handle signals and reap zombie processes
ENTRYPOINT [ "/usr/bin/tini", "--" ]
CMD [ "node", "index.js" ]