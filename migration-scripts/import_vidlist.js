const fs = require("fs");
const csv = require("csv-parser");

const { Sequelize, DataTypes } = require("sequelize");
const db_host = process.env.db_host || "localhost";

const sequelize = new Sequelize("vidlist", "ytdiff", "ytd1ff", {
    host: db_host,
    dialect: "postgres",
    logging: false,
});

try {
    sequelize.authenticate().then(() => {
        console.log("Connection has been established successfully.");
    });
} catch (error) {
    console.error("Unable to connect to the database:", error);
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
});

sequelize.sync().then(() => {
    console.log("vid_list and play_lists tables exist or are created successfully!");
}).catch((error) => {
    console.error("Unable to create table : ", error);
}).then(() => {
    fs.createReadStream("vid_lists.csv")
        .pipe(csv())
        .on("data", async (row) => {
            //console.log("row: ", row);
            try {
                const downloaded = row.downloaded === "t",
                    available = row.available === "t";
                const [found, created] = await vid_list.findOrCreate({
                    where: { url: JSON.stringify(row).split(",")[0].slice(9, -1) },
                    defaults: {
                        id: row.id,
                        title: row.title,
                        downloaded: downloaded,
                        available: available,
                        reference: row.reference,
                        list_order: row.list_order,
                    }
                    //createdAt: row.createdAt, // can't be set manually as far as I can tell
                    //updatedAt: row.updatedAt
                });
                if (!created) {
                    // The object was found and not created
                    //console.log("Found object: ", found);
                    if (found.id !== row.id ||
                        found.reference !== row.reference ||
                        found.title !== row.title ||
                        found.downloaded !== downloaded ||
                        found.available !== available ||
                        found.list_order !== row.list_order) {
                        // At least one property is different, update the object
                        found.id = row.id;
                        found.reference = row.reference;
                        found.title = row.title;
                        found.available = available;
                        found.downloaded = downloaded;
                        found.list_order = row.list_order;
                        //console.log("Found object updated: ", found);
                    }
                    await found.save();
                }
            } catch (error) {
                console.error(error);
            }
        })
        .on("end", () => {
            console.log("CSV file successfully processed");
        });
});


