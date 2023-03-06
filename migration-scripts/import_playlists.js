const fs = require("fs");
const csv = require("csv-parser");

const { Sequelize, DataTypes } = require("sequelize");
const db_host = process.env.db_host || "localhost";

const not_needed = ['', 'pornstar', 'model', 'videos'];

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
        autoIncrement: true,
    },
    watch: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
    },
    save_dir: {
        type: DataTypes.STRING,
        allowNull: false,
    }
});
// STRING is 255 chars
sequelize.sync().then(() => {
    console.log("vid_list and play_lists tables exist or are created successfully!");
}).catch((error) => {
    console.error("Unable to create table : ", error);
}).then(() => {
    fs.createReadStream("play_lists.csv")
        .pipe(csv())
        .on("data", async (row) => {
            try {
                const watch = row.watch === "t";
                const title = JSON.stringify(row).split(",")[0].slice(11, -1);
                const title_checked = await string_slicer(((title === row.url) ? await url_to_title(row.url) : title), 255);
                //console.log(title === row.url, title == row.url, title, row.url, title_checked);
                const [found, created] = await play_lists.findOrCreate({
                    where: { url: row.url },
                    defaults: {
                        title: title_checked,
                        watch: watch,
                        save_dir: title_checked
                    }
                    //createdAt: Date(row.createdAt), // can't be set manually as far as I can tell
                    //updatedAt: Date(row.updatedAt)
                });
                if (!created) {
                    // The object was found and not created
                    //console.log("Found object: ", found);
                    if (found.title !== title_checked
                        || found.watch !== watch
                        || found.save_dir !== title_checked) {
                        // At least one property is different, update the object
                        found.title = title_checked;
                        // need to bother with order_added as it's auto increment
                        found.watch = watch;
                        found.save_dir = title_checked;
                    }
                    await found.save();
                }
            } catch (error) {
                //console.error(error);
            }
        })
        .on("end", () => {
            console.log("CSV file successfully processed");
        });
});

async function string_slicer(str, len) {
    if (str.length > len) {
        const encoder = new TextEncoder();
        const decoder = new TextDecoder();
        return (decoder.decode(encoder.encode(str.slice(0, len))));
    }
    return (str);
}

async function url_to_title(body_url) {
    try {
        return new URL(body_url).pathname.split("/").filter(item => !not_needed.includes(item)).join("");
    } catch (error) {
        console.error(error);
        return body_url
    }
}
