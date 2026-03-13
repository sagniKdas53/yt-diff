import pg from "pg";
import { QueryTypes, Sequelize } from "sequelize";
const s = new Sequelize({
  host: "localhost",
  dialect: "postgres",
  dialectModule: pg,
  logging: false,
  username: "ytdiff",
  password: "ytd1ff",
  database: "vidlist",
});
await s.authenticate();
const [, count] = await s.query(
  'UPDATE video_metadata SET "saveDirectory" = NULL WHERE "downloadStatus" = true',
  { type: QueryTypes.UPDATE },
);
console.log("Reset", count, "videos");
await s.close();
