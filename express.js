#!/usr/bin/env node
"use strict";

// imports
const express = require("express");
const router = express.Router();
const path_fs = require("path");

// getting env data
const protocol = process.env.protocol || "http";
const host = process.env.host || "localhost";
const port = process.env.port || 8338;
const url_base = process.env.base_url || "/ytdiff";

const app = express();
app.use(express.json());
app.use(router);
app.use(express.static(path_fs.join(__dirname, "dist")));

// define a route that accepts GET requests
router.get("/api/users", (req, res) => {
  // retrieve users from database or some other data source
  const users = [
    { id: 1, name: "John" },
    { id: 2, name: "Jane" },
  ];

  res.json(users); // send response as JSON data
});

// define a route that accepts POST requests
router.post("/api/users", (req, res) => {
  const { name } = req.body;

  if (!name) {
    // if name is missing from request body, send a 400 Bad Request response
    return res.status(400).json({ error: "Name is required" });
  }

  // create a new user and save to database or some other data source
  const newUser = { id: 3, name };

  res.status(201).json(newUser); // send response as JSON data with status 201 Created
});

// error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack); // log the error to console

  // send a 500 Internal Server Error response
  res.status(500).json({ error: "Something went wrong" });
});

app.listen(port, () => {
  if (process.env.hide_ports || process.env.hide_ports == undefined)
    console.log(
      `Server listening on ${protocol}://${host}:${port}${url_base}\n`
    );
  else console.log(`Server listening on ${protocol}://${host}${url_base}\n`);
});
