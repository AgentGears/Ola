// eval/harness/ids.js
//
// ID normalization across surfaces. Keeps metric/report code surface-agnostic.
//
//   l3:<memory_id>            e.g. l3:lesson/auth_token_refresh.md
//   l2:<session>/<chunk>      e.g. l2:sess_abc/part-004
//   lme:<doc_id>              e.g. lme:longmemeval-0042
//
// The prefix is the surface; the suffix is the surface-local id. Gold entries
// in query datasets use the *unprefixed* form (e.g. "lesson/auth_token_refresh.md")
// so the same gold set works whether you evaluate on l3-synth or l3-real.
// normalizeForComparison() strips prefixes and normalizes case/separator style
// so "L3:Lesson/Auth_Token_Refresh.md" matches "lesson/auth_token_refresh.md".

"use strict";

function prefixFor(surface) {
  if (surface === "l3-synth" || surface === "l3-real") return "l3";
  if (surface === "l2") return "l2";
  if (surface === "lme") return "lme";
  return "id";
}

function makeId(surface, localId) {
  return prefixFor(surface) + ":" + localId;
}

// Strip the surface prefix and normalize for gold-matching.
// "l3:lesson/foo.md" → "lesson/foo.md"
// "lesson/Foo.md"    → "lesson/foo.md"
// "L2:sess_x/part-1" → "sess_x/part-1"
function normalizeForComparison(id) {
  if (!id) return "";
  let s = String(id);
  // Strip known surface prefix if present
  s = s.replace(/^(l3|l2|lme):/i, "");
  // Lowercase, normalize separators
  return s.toLowerCase();
}

// True if two ids refer to the same record, ignoring surface prefix and case.
function idsMatch(a, b) {
  return normalizeForComparison(a) === normalizeForComparison(b);
}

module.exports = { prefixFor, makeId, normalizeForComparison, idsMatch };
