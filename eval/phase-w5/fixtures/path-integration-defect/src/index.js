// src/index.js — Configuration file manager
//
// Loads, merges, and validates configuration from multiple sources:
// 1. Built-in defaults
// 2. Global config file (~/.config/app/config.json)
// 3. Local project config file (./app.config.json)
// 4. Environment variables (APP_* prefix)
//
// Later sources override earlier ones. After merge, the result is validated
// against a schema and returned as a frozen object.

"use strict";

var fs = require("fs");
var path = require("path");

var DEFAULTS = {
  port: 3000,
  host: "localhost",
  logLevel: "info",
  dataDir: "./data",
  maxConnections: 100,
};

function loadConfig(opts) {
  opts = opts || {};
  var globalDir = opts.globalDir || getDefaultGlobalDir();
  var localDir = opts.localDir || process.cwd();

  var config = mergeDeep({}, DEFAULTS);

  // Layer 2: global config
  var globalPath = path.join(globalDir, "config.json");
  var globalConfig = readJsonSafe(globalPath);
  if (globalConfig) {
    config = mergeDeep(config, globalConfig);
  }

  // Layer 3: local config
  var localPath = path.join(localDir, "app.config.json");
  var localConfig = readJsonSafe(localPath);
  if (localConfig) {
    config = mergeDeep(config, localConfig);
  }

  // Layer 4: environment variables
  config = applyEnvOverrides(config);

  // Validate
  validateConfig(config);

  return Object.freeze(config);
}

function getDefaultGlobalDir() {
  var home = process.env.HOME || process.env.USERPROFILE || "";
  return path.join(home, ".config", "app");
}

function readJsonSafe(filePath) {
  try {
    var content = fs.readFileSync(filePath, "utf8");
    return JSON.parse(content);
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw new Error("Failed to read config file " + filePath + ": " + e.message);
  }
}

function mergeDeep(target, source) {
  for (var key in source) {
    if (!source.hasOwnProperty(key)) continue;
    if (typeof source[key] === "object" && source[key] !== null && !Array.isArray(source[key])) {
      if (typeof target[key] !== "object" || target[key] === null) {
        target[key] = {};
      }
      mergeDeep(target[key], source[key]);
    } else {
      target[key] = source[key];
    }
  }
  return target;
}

function applyEnvOverrides(config) {
  for (var key in config) {
    if (!config.hasOwnProperty(key)) continue;
    var envKey = "APP_" + key.toUpperCase();
    var envVal = process.env[envKey];
    if (envVal !== undefined) {
      // Try to parse as number
      var numVal = Number(envVal);
      config[key] = isNaN(numVal) ? envVal : numVal;
    }
  }
  return config;
}

function validateConfig(config) {
  if (typeof config.port !== "number" || config.port < 0 || config.port > 65535) {
    throw new Error("Invalid port: " + config.port);
  }
  if (typeof config.host !== "string" || config.host.length === 0) {
    throw new Error("Invalid host: " + config.host);
  }
  if (typeof config.logLevel !== "string") {
    throw new Error("Invalid logLevel: " + config.logLevel);
  }
  if (typeof config.dataDir !== "string") {
    throw new Error("Invalid dataDir: " + config.dataDir);
  }
  if (typeof config.maxConnections !== "number" || config.maxConnections < 0) {
    throw new Error("Invalid maxConnections: " + config.maxConnections);
  }
}

module.exports = {
  loadConfig: loadConfig,
  mergeDeep: mergeDeep,
  applyEnvOverrides: applyEnvOverrides,
  validateConfig: validateConfig,
  DEFAULTS: DEFAULTS,
};
