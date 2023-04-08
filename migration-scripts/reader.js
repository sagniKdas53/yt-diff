#!/home/sagnik/.nvm/versions/node/v18.12.0/bin/node
const fs = require("fs");
const csv = require("csv-parser");

fs.createReadStream("./vid_lists.csv")
  .pipe(csv())
  .on("data", async (row) => {
    try {
      console.log(row);
    } catch (error) {
      console.error(error);
    }
  })
  .on("end", () => {
    console.log("CSV file successfully processed");
  });
