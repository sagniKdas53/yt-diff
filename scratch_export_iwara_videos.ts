import { Op } from "sequelize";

// Fix up secrets paths for host execution (since .env has docker paths)
if (!Deno.env.get("DB_PASSWORD_FILE") || Deno.env.get("DB_PASSWORD_FILE") === "/run/secrets/db_password") {
  Deno.env.set("DB_PASSWORD_FILE", "./db_password.txt");
}
if (!Deno.env.get("SECRET_KEY_FILE") || Deno.env.get("SECRET_KEY_FILE") === "/run/secrets/secret_key") {
  Deno.env.set("SECRET_KEY_FILE", "./secret_key.txt");
}
if (Deno.env.get("DB_HOST") === "yt-db") {
  Deno.env.set("DB_HOST", "127.0.0.1");
}

const { PlaylistVideoMapping, VideoMetadata, sequelize } = await import("./src/db/models.ts");
const { logger } = await import("./src/logger.ts");

async function run() {
  Deno.env.set("LOG_LEVELS", "info");

  logger.info("Fetching Iwara videos...");

  const mappings = await PlaylistVideoMapping.findAll({
    where: {
      videoUrl: {
        [Op.like]: "%iwara%",
      },
    },
    include: [{
      model: VideoMetadata,
      where: {
        downloadStatus: true,
      },
      required: true,
    }],
  });

  const allIwara = [];
  const filteredIwara = [];

  for (const mapping of mappings) {
    const videoUrl = mapping.getDataValue("videoUrl") as string;
    const playlistUrl = mapping.getDataValue("playlistUrl") as string;
    const position = mapping.getDataValue("positionInPlaylist") as number;

    const entry = { playlistUrl, videoUrl };
    allIwara.push(entry);

    if (playlistUrl !== "None" || (playlistUrl === "None" && position < 2552)) {
      filteredIwara.push(entry);
    }
  }

  logger.info(`Found ${allIwara.length} total Iwara video mappings.`);
  logger.info(`Found ${filteredIwara.length} filtered Iwara video mappings.`);

  Deno.writeTextFileSync("iwara_videos_all.json", JSON.stringify(allIwara, null, 2));
  Deno.writeTextFileSync("iwara_videos_filtered.json", JSON.stringify(filteredIwara, null, 2));

  logger.info("Exported to iwara_videos_all.json and iwara_videos_filtered.json");
}

try {
  await run();
} catch (err) {
  logger.error("Failed:", err as any);
} finally {
  await sequelize.close();
}
