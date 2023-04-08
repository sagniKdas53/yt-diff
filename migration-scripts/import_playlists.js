#!/home/sagnik/.nvm/versions/node/v18.12.0/bin/node
const fs = require("fs");
const csv = require("csv-parser");
const { Sequelize, DataTypes, Op } = require("sequelize");

const sequelize = new Sequelize("vidlist", "ytdiff", "ytd1ff", {
  host: "localhost",
  dialect: "postgres",
  logging: false,
  timezone: "Asia/Kolkata",
});

try {
  sequelize.authenticate().then(() => {
    console.log("Connection to database has been established successfully.\n");
  });
} catch (error) {
  console.error(`Unable to connect to the database: ${error}\n`);
}

const play_lists = sequelize.define("play_lists", {
  title: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  url: {
    type: DataTypes.STRING,
    allowNull: false,
    primaryKey: true,
  },
  order_added: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0,
  },
  watch: {
    type: DataTypes.SMALLINT,
    allowNull: false,
  },
  save_dir: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  createdAt: {
    type: DataTypes.DATE,
    allowNull: false,
  },
  updatedAt: {
    type: DataTypes.DATE,
    allowNull: false,
  },
});

sequelize
  .sync()
  .then(() => {
    console.log(
      "vid_list and play_lists tables exist or are created successfully!\n"
    );
  })
  .catch((error) => {
    console.error(`Unable to create table : ${error}\n`);
  })
  .then(() => {
    fs.createReadStream("./play_lists.csv")
      .pipe(csv())
      .on("data", async (row) => {
        try {
          const entity = await play_lists.create({
            title: Object.entries(row)[0][1],
            url: row.url,
            order_added: row.order_added,
            watch: row.watch,
            save_dir: row.save_dir,
            createdAt: row.createdAt,
            // this can't be set, it's automatic
            updatedAt: row.updatedAt,
          });
          console.log("Created: " + JSON.stringify(entity));
          // This doesn't work either.
          //const [results, metadata] = await play_lists.sequelize.query(
          //  `UPDATE play_lists SET updatedAt = '${row.updatedAt}' WHERE url = ${row.url};`
          //);
        } catch (error) {
          console.error(error);
        }
      })
      .on("end", () => {
        console.log("CSV file successfully processed");
      });
  });
