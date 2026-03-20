# yt-diff

[![Build](https://github.com/sagniKdas53/yt-diff/actions/workflows/docker-build-and-push.yml/badge.svg)](https://github.com/sagniKdas53/yt-diff/actions/workflows/docker-build-and-push.yml )
![Top Lang](https://img.shields.io/github/languages/top/sagniKdas53/yt-diff)

yt-diff: yt-dlp web-ui that's built different. Deno backend with a somewhat usable UI made in react and mui. It can be used to index and download videos from youtube and some other site almost all of the ones supported by yt-dlp.

[See all supported sites](https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md)

## Requirements

- Deno
- Postgres
- Valkey
- VPN (optional)
- Docker Compose or Docker to use postgres (Can be installed on system directly)
- Linux (Not tested on Windows)
- yt-dlp (Installed with `python3 -m pip install -U "yt-dlp[default]"`)
- curl-cffi (optional)
- ffmpeg (optional)

## How to use?

Populate the .env file with variables that you want to use. Build the docker image or pull one form github container registry.

### Building the docker image an

```bash
make build
```

### Using pre-built image

This is built using github actions replace it in docker-compose.yml and just run

```bash
make up CONTAINER=name
```

#### Github container registry (ghcr.io)`ghcr.io/sagnikdas53/yt-diff:master`

## Usage

TODO

## Examples

TODO
