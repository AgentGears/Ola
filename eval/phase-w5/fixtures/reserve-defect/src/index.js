// src/index.js — Duration parser
//
// Parses human-readable duration strings into milliseconds.
// Supports: "30s", "5m", "2h", "1d", "500ms", "1h30m", "2d4h"
// Compound durations add up: "1h30m" = 5400000ms.

"use strict";

var UNITS = {
  ms: 1,
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
};

function parseDuration(input) {
  if (typeof input !== "string" || input.length === 0) {
    throw new Error("input must be a non-empty string");
  }

  var totalMs = 0;
  // Match pairs of (number)(unit), allowing optional whitespace
  var regex = /(\d+)\s*(ms|s|m|h|d)/g;
  var match;
  var lastEnd = 0;
  var foundAny = false;

  while ((match = regex.exec(input)) !== null) {
    var value = parseInt(match[1], 10);
    var unit = match[2];
    var multiplier = UNITS[unit];

    if (multiplier === undefined) {
      throw new Error("Unknown unit: " + unit);
    }

    totalMs += value * multiplier;
    lastEnd = regex.lastIndex;
    foundAny = true;
  }

  if (!foundAny) {
    throw new Error("No valid duration found in: " + input);
  }

  // Check for trailing unparsed content
  if (lastEnd < input.length) {
    var remainder = input.slice(lastEnd).trim();
    if (remainder.length > 0) {
      throw new Error("Unparsed remainder: " + remainder);
    }
  }

  return totalMs;
}

function formatDuration(ms) {
  if (typeof ms !== "number" || ms < 0) {
    throw new Error("ms must be a non-negative number");
  }

  var parts = [];
  var remaining = ms;

  var days = Math.floor(remaining / UNITS.d);
  if (days > 0) { parts.push(days + "d"); remaining -= days * UNITS.d; }

  var hours = Math.floor(remaining / UNITS.h);
  if (hours > 0) { parts.push(hours + "h"); remaining -= hours * UNITS.h; }

  var minutes = Math.floor(remaining / UNITS.m);
  if (minutes > 0) { parts.push(minutes + "m"); remaining -= minutes * UNITS.m; }

  var seconds = Math.floor(remaining / UNITS.s);
  if (seconds > 0) { parts.push(seconds + "s"); remaining -= seconds * UNITS.s; }

  if (remaining > 0) { parts.push(remaining + "ms"); }

  return parts.length > 0 ? parts.join("") : "0ms";
}

module.exports = {
  parseDuration: parseDuration,
  formatDuration: formatDuration,
  UNITS: UNITS,
};
