// src/index.js — Atomic counter store
//
// A simple key-value store with atomic increment operations.
// Uses an exclusive file lock (wx flag) to serialize writes.
// The lock ensures that concurrent increments to the same key
// cannot lose updates (lost-update problem).
//
// The store writes to a JSON file. Each increment:
//   1. Acquire lock
//   2. Read current value
//   3. Compute new value
//   4. Write new value
//   5. Release lock
//
// Concurrent increments should be serialized by the lock.

"use strict";

var fs = require("fs");
var path = require("path");

function createStore(storePath) {
  // Initialize the store file if it doesn't exist
  if (!fs.existsSync(storePath)) {
    fs.writeFileSync(storePath, JSON.stringify({}), "utf8");
  }

  var lockPath = storePath + ".lock";

  function acquireLock() {
    try {
      fs.writeFileSync(lockPath, String(process.pid), { flag: "wx" });
      return true;
    } catch (e) {
      if (e.code === "EEXIST") return false;
      throw e;
    }
  }

  function releaseLock() {
    try {
      var lockPid = fs.readFileSync(lockPath, "utf8");
      if (lockPid === String(process.pid)) {
        fs.unlinkSync(lockPath);
      }
    } catch (e) {
      // Lock already removed
    }
  }

  function read() {
    var content = fs.readFileSync(storePath, "utf8");
    return JSON.parse(content);
  }

  function write(data) {
    var tmp = storePath + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(data), "utf8");
    fs.renameSync(tmp, storePath);
  }

  function increment(key, amount) {
    amount = amount || 1;

    // Spin-wait for lock
    var attempts = 0;
    while (!acquireLock() && attempts < 100) {
      // Brief spin
      var start = Date.now();
      while (Date.now() - start < 1) {}
      attempts++;
    }
    if (attempts >= 100) {
      throw new Error("Could not acquire lock after 100 attempts");
    }

    try {
      var data = read();
      if (typeof data[key] !== "number") {
        data[key] = 0;
      }
      data[key] += amount;
      write(data);
      return data[key];
    } finally {
      releaseLock();
    }
  }

  function get(key) {
    var data = read();
    return data[key] || 0;
  }

  function close() {
    // Remove lock if we hold it
    releaseLock();
  }

  return {
    increment: increment,
    get: get,
    read: read,
    close: close,
  };
}

module.exports = { createStore: createStore };
