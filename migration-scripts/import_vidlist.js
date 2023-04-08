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

const vid_list = sequelize.define("vid_list", {
  url: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  id: {
    type: DataTypes.STRING,
    allowNull: false,
    primaryKey: true,
  },
  title: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  downloaded: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
  },
  available: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
  },
  reference: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  list_order: {
    type: DataTypes.INTEGER,
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
    fs.createReadStream("./vid_lists.csv")
      .pipe(csv())
      .on("data", async (row) => {
        try {
          const entity = await vid_list.create({
            url: Object.entries(row)[0][1],
            id: row.id,
            title: row.title,
            downloaded: row.downloaded,
            available: row.available,
            reference: row.reference,
            list_order: row.list_order,
            createdAt: row.createdAt,
            // this can't be set, it's automatic
            updatedAt: row.updatedAt,
          });
          console.log("Created: " + JSON.stringify(entity));
        } catch (error) {
          console.error(error);
        }
      })
      .on("end", () => {
        console.log("CSV file successfully processed");
      });
  });
