# Experimental Nix image

This is an isolated preparation path for a future Nix-built image. The current
Dockerfiles, Docker Compose build, Makefile `build` target, and Docker image
workflows remain the active path.

## Findings from PR #127

PR #127 established the intended image shape, but its head was not ready to
replace the Docker path:

1. Both Nix jobs failed in the frontend derivation. `importNpmLock` populated
   store entries for the lockfile but the later offline npm install did not
   have `zod-validation-error-4.0.2.tgz` in its npm cache, producing
   `ENOTCACHED`.
2. The PR deleted the root `Dockerfile` while
   `validation/docker-compose.test.yml` still builds `yt-diff-test` from
   `../Dockerfile`. The E2E job therefore failed before registering any tests.
3. The frontend build script writes to `../dist/`. The PR's frontend
   derivation copied `dist` from the package working directory, which does not
   match the existing Docker build's `/app/dist` output location.
4. The PR changed production Compose security settings, the Makefile build
   contract, and publishing workflows in the same change. Those changes make
   the Nix experiment harder to isolate and were intentionally left out here.

The first three points are addressed in the flake preparation. The frontend
dependency hash has been generated from the pinned lockfile, and the complete
x86_64 image derivation now succeeds. The aarch64 output has been evaluated but
not built on this host.

The first hardened local startup also found that Deno's default
`nodeModulesDir: auto` tried to write under the read-only Nix store. The image
entrypoint now uses `--node-modules-dir=none`, so Deno keeps its npm cache in
the writable `/tmp` tmpfs. A cold start downloads the npm packages into that
cache. The runtime also mirrors the Dockerfile's Python dependency contract:
`python3`, `yt-dlp[default,curl-cffi]`, and `yt-dlp-ejs` are bundled into one
Nix Python environment. The health endpoint, database/Valkey initialization,
and the reported YouTube listing URL pass.

## Bootstrap the frontend dependency hash

With Nix installed, run the frontend package build for the host architecture:

```bash
nix build .#packages.x86_64-linux.frontend --print-build-logs
```

The pinned hash is currently
`sha256-BHzLjnCE6WDjP7RLkTH42wpMKqDTa3na1Mkry/tbwik=`. If the frontend lockfile
changes, this command will fail with a new fixed-output hash; replace the
`npmDepsHash` value in `flake.nix` with that value and rerun it. Repeat the
build on an ARM64 Linux runner for the ARM image.

## Build the image experiment

After the frontend hash is fixed, build the image:

```bash
nix flake check --no-build
nix build .#packages.x86_64-linux.container --print-build-logs
docker load < result
```

For a direct runtime probe, provide writable temporary state explicitly:

```bash
docker run --rm --read-only \
  --tmpfs /tmp:rw,nosuid,nodev,noexec,mode=1777 \
  yt-diff:nix-experiment
```

For the local Compose deployment used during this experiment, keep the
override outside the repository so the Docker Compose path stays unchanged:

```bash
docker compose -f docker-compose.yml \
  -f /tmp/yt-diff-nix-deploy.XXXXXX/docker-compose.nix-experiment.yml \
  up -d --no-build yt-db valkey yt-diff
curl -fsS http://127.0.0.1:8888/ytdiff/ping
```

On 2026-09-30 this returned `pong` with the Nix image running as UID 1000,
read-only rootfs, dropped capabilities, and `no-new-privileges`. Frontend
asset serving and isolated E2E/download paths remain unmeasured. The image is
not wired into the tracked Compose or CI configuration; a separate change can
decide whether to add a manual Nix workflow or compare it with the existing
Docker build.
