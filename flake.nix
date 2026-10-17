{
  description = "Experimental rootless OCI image for yt-diff";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    frontend = {
      url = "github:sagniKdas53/yt-diff-react/ffa6e8ae3b6029c5e74991856fdeccda52346122";
      flake = false;
    };
  };

  outputs = { self, nixpkgs, frontend }:
    let
      supportedSystems = [ "x86_64-linux" "aarch64-linux" ];
      forAllSystems = nixpkgs.lib.genAttrs supportedSystems;
    in {
      packages = forAllSystems (system:
        let
          pkgs = import nixpkgs { inherit system; };

          frontendPackage = pkgs.buildNpmPackage {
            pname = "yt-diff-frontend";
            version = builtins.substring 0 12 frontend.rev;
            src = frontend;

            # Generated with nixpkgs' prefetch-npm-deps path from the pinned
            # frontend package-lock.json.
            npmDepsHash = "sha256-BHzLjnCE6WDjP7RLkTH42wpMKqDTa3na1Mkry/tbwik=";
            npmBuildScript = "build";

            installPhase = ''
              runHook preInstall
              mkdir -p "$out"
              # frontend/package.json deliberately writes Vite output to
              # ../dist, matching the existing Dockerfile's /app/dist copy.
              cp -r ../dist/. "$out/"
              runHook postInstall
            '';
          };

          application = pkgs.stdenvNoCC.mkDerivation {
            pname = "yt-diff";
            version = self.shortRev or "dirty";
            src = self;
            dontBuild = true;

            installPhase = ''
              mkdir -p "$out/app"
              cp deno.json deno.lock index.ts "$out/app/"
              cp -r src "$out/app/src"
              cp -r ${frontendPackage} "$out/app/dist"
            '';
          };

          # Match the Dockerfile runtime dependency contract:
          # python3 + yt-dlp[default,curl-cffi] + yt-dlp-ejs. Nix packages the
          # same set into one immutable Python runtime instead of creating a
          # mutable /opt/venv during container startup.
          pythonRuntime = pkgs.python3.withPackages (pythonPackages: with pythonPackages; [
            yt-dlp
            yt-dlp-ejs
            pythonPackages."curl-cffi"
          ]);

          entrypoint = pkgs.writeShellScriptBin "yt-diff-entrypoint" ''
            exec ${pkgs.tini}/bin/tini -- \
              ${pkgs.deno}/bin/deno run --allow-all --node-modules-dir=none \
              ${application}/app/index.ts "$@"
          '';

          image = pkgs.dockerTools.buildLayeredImage {
            name = "yt-diff";
            tag = "nix-experiment";
            maxLayers = 100;

            contents = [
              pkgs.cacert
              pkgs.curl
              pkgs.deno
              pkgs.dockerTools.fakeNss
              pkgs.ffmpeg-headless
              pythonRuntime
              pkgs.tini
              entrypoint
            ];

            # The normal Compose experiment will provide a tmpfs at runtime;
            # keeping the directory in the image also makes the image layout
            # explicit for direct `docker run` experiments.
            extraCommands = ''
              mkdir -m 1777 tmp
            '';

            config = {
              User = "1000:1000";
              WorkingDir = "${application}/app";
              Entrypoint = [ "${entrypoint}/bin/yt-diff-entrypoint" ];
              Env = [
                "DENO_DIR=/tmp/deno-cache"
                "HOME=/tmp"
                "LANG=C.UTF-8"
                "PATH=${pkgs.lib.makeBinPath [ pkgs.curl pkgs.deno pkgs.ffmpeg-headless pythonRuntime ]}"
                "VITE_BASE_PATH=/ytdiff"
              ];
              ExposedPorts = { "8888/tcp" = { }; };
              Labels = {
                "org.opencontainers.image.source" = "https://github.com/sagniKdas53/yt-diff";
                "org.opencontainers.image.description" = "Experimental yt-diff image built with Nix";
              };
            };
          };
        in {
          default = image;
          container = image;
          frontend = frontendPackage;
        });

      formatter = forAllSystems (system: nixpkgs.legacyPackages.${system}.nixfmt-rfc-style);
    };
}
