FROM denoland/deno:2-alpine
WORKDIR /app
COPY mod.ts ./
RUN deno cache mod.ts
USER deno
CMD ["deno", "run", "--allow-net", "--allow-env", "mod.ts"]
