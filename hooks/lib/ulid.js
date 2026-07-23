// hooks/lib/ulid.js
//
// Clean-room ULID (Universally Unique Lexicographically Sortable Identifier) generator.
//
// Spec: https://github.com/ulid/spec
// - 128 bits total: 48-bit timestamp (ms since Unix epoch) + 80-bit cryptographic randomness
// - 26 characters in Crockford Base32 (0123456789ABCDEFGHJKMNPQRSTVWXYZ)
// - Lexicographically sortable by timestamp
// - No ambiguous characters (I, L, O, U excluded)
//
// Dependency injection: pass { now, randomBytes } for deterministic testing.
// Production defaults use Date.now() and crypto.randomBytes().
//
// Part of Ola — agent-neutral cognitive memory.

"use strict";

const crypto = require("node:crypto");

const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford Base32
const ENCODING_LEN = 32;
const TIME_LEN = 10;
const RANDOM_LEN = 16;

/**
 * Encode a 48-bit timestamp into 10 Crockford Base32 characters.
 * @param {number} now - milliseconds since Unix epoch
 * @returns {string} 10-char encoded timestamp
 */
function encodeTime(now) {
  let str = "";
  let ts = now;
  for (let i = TIME_LEN - 1; i >= 0; i--) {
    const mod = ts % ENCODING_LEN;
    str = ENCODING[mod] + str;
    ts = (ts - mod) / ENCODING_LEN;
  }
  return str;
}

/**
 * Encode 80 bits of randomness into 16 Crockford Base32 characters.
 * @param {Buffer} randomBytes - exactly 10 bytes (80 bits)
 * @returns {string} 16-char encoded randomness
 */
function encodeRandom(randomBytes) {
  let str = "";
  // Process 5 bytes at a time → 8 Base32 chars each (two groups of 5 bytes = 10 bytes = 16 chars)
  // Actually ULID random is 16 chars from 10 bytes. Process byte-by-byte using 5-bit groups.
  // 10 bytes = 80 bits = 16 × 5-bit groups, but that's 80 bits exactly into 16 groups of 5.
  // The standard approach: iterate through 5-bit windows left to right.
  const bytes = Buffer.from(randomBytes);

  // Build a big bit sequence and extract 5-bit groups
  // 80 bits, we need 16 groups of 5 bits
  let bits = 0n;
  for (let i = 0; i < bytes.length; i++) {
    bits = (bits << 8n) | BigInt(bytes[i]);
  }

  // Pad to exactly 80 bits
  // Now extract 16 groups of 5 bits from left (most significant) to right
  for (let i = 0; i < RANDOM_LEN; i++) {
    const shift = BigInt((RANDOM_LEN - 1 - i) * 5);
    const idx = Number((bits >> shift) & 31n);
    str += ENCODING[idx];
  }

  return str;
}

/**
 * Generate a ULID.
 *
 * @param {Object} [options] - injection point for tests
 * @param {number} [options.now] - timestamp override (ms since epoch)
 * @param {Function} [options.randomBytes] - function(size) → Buffer override
 * @returns {string} 26-character ULID
 */
function generateUlid(options = {}) {
  const now = options.now !== undefined ? options.now : Date.now();
  const randomBytesFn = options.randomBytes || ((size) => crypto.randomBytes(size));

  if (typeof now !== "number" || now < 0 || !Number.isFinite(now)) {
    throw new Error("ULID timestamp must be a non-negative finite number: got " + now);
  }
  if (now > 281474976710655) {
    // 2^48 - 1
    throw new Error("ULID timestamp exceeds 48-bit range: " + now);
  }

  const randomBytes = randomBytesFn(10);
  if (!Buffer.isBuffer(randomBytes) || randomBytes.length !== 10) {
    throw new Error("ULID randomBytes must return a 10-byte Buffer");
  }

  return encodeTime(now) + encodeRandom(randomBytes);
}

/**
 * Validate that a string is a structurally valid ULID.
 * Checks: 26 chars, all Crockford Base32, correct alphabet.
 *
 * @param {string} id - the string to validate
 * @returns {boolean} true if valid
 */
function isValidUlid(id) {
  if (typeof id !== "string" || id.length !== TIME_LEN + RANDOM_LEN) {
    return false;
  }
  for (let i = 0; i < id.length; i++) {
    if (!ENCODING.includes(id[i].toUpperCase())) {
      return false;
    }
  }
  return true;
}

module.exports = {
  generateUlid,
  isValidUlid,
  // Exported for testing
  encodeTime,
  encodeRandom,
  ENCODING,
  TIME_LEN,
  RANDOM_LEN,
};
