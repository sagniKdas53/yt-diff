{
  description = "Rootless, immutable OCI image for yt-diff";

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

          frontendPackage = pkgs.stdenvNoCC.mkDerivation {
            pname = "yt-diff-frontend";
            version = "${builtins.substring 0 12 frontend.rev}";
            src = frontend;
            nativeBuildInputs = [
              pkgs.nodejs_22
              pkgs.importNpmLock.npmConfigHook
            ];
            npmDeps = pkgs.importNpmLock.buildNodeModules {
              npmRoot = frontend;
              nodejs = pkgs.nodejs_22;
            };
            VITE_BASE_PATH = "/ytdiff";
            buildPhase = ''
              runHook preBuild
              npm run build
              runHook postBuild
            '';
            installPhase = ''
              runHook preInstall
              cp -r dist "$out"
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

          entrypoint = pkgs.writeShellScriptBin "yt-diff-entrypoint" ''
            exec ${pkgs.tini}/bin/tini -- ${pkgs.deno}/bin/deno run --allow-all ${application}/app/index.ts "$@"
          '';

          image = pkgs.dockerTools.buildLayeredImage {
            name = "yt-diff";
            tag = "nix";
            maxLayers = 100;
            contents = [
              pkgs.cacert
              pkgs.curl
              pkgs.deno
              pkgs.dockerTools.fakeNss
              pkgs.ffmpeg-headless
              pkgs.tini
              pkgs.yt-dlp
              entrypoint
            ];
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
                "PATH=${pkgs.lib.makeBinPath [ pkgs.curl pkgs.deno pkgs.ffmpeg-headless pkgs.yt-dlp ]}"
                "VITE_BASE_PATH=/ytdiff"
              ];
              ExposedPorts = { "8888/tcp" = { }; };
              Labels = {
                "org.opencontainers.image.source" = "https://github.com/sagniKdas53/yt-diff";
                "org.opencontainers.image.description" = "Rootless yt-diff image built reproducibly with Nix";
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
