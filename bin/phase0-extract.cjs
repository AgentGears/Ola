// bin/phase0-extract.cjs
// Phase 0 gate: run LLM extraction against a transcript chunk and capture output.
// Ports OpenViking's `experiences` extraction prompt (Situation/Approach/Reflect,
// atomic scope, imperative voice) into a single-shot call.
//
// Usage:
//   node bin/phase0-extract.cjs <chunk.txt> [out.json]
//   node bin/phase0-extract.cjs --prompt   (just print the system prompt)
//
// Reads the model + endpoint from env (falls back to ZCode's GLM endpoint if set):
//   PHASE0_MODEL        (default: gpt-4o-mini via OpenAI, or set BASE_URL for compat)
//   PHASE0_BASE_URL     (OpenAI-compatible chat completions base)
//   PHASE0_API_KEY
// If none set, prints the prompt + chunk for manual paste into a chat UI.
"use strict";
const path = require("node:path");
const fs = require("node:fs");

// ---- The extraction system prompt (ported from OpenViking experiences.yaml) ----
const SYSTEM_PROMPT = `You are a memory-extraction engine for an AI coding agent. Your job: read a transcript chunk from a past coding session and extract DURABLE, REUSABLE lessons — not a process record.

Output ZERO OR MORE "experiences". An experience is a generalizable pattern the agent could reuse in future sessions: what situation triggers it, what approach works, and what to avoid.

Each experience MUST follow EXACTLY this format:

## <experience_name>
- lowercase_snake_case, max 5 words, names the PATTERN not the instance

### Situation
- <markdown bullets: the generalized context/trigger that makes this whole rule relevant>

### Approach
- <markdown bullets: active execution steps (imperative voice: "Do X", "Call tool Y"). IF/THEN/ELSE for conditionals. The efficient optimized path ONLY — strip conversational noise, retries, false starts.>

### Reflect
- <markdown bullets: hard guardrails / "DON'Ts" / failure-prevention heuristics derived from mistakes in the transcript>

SELECTION RULES (critical — this is where extraction goes wrong):
- ATOMIC SCOPE: each experience covers exactly ONE user intent + its tool sequence. Multiple distinct intents -> separate experiences. If Approach would exceed 8 bullets, split.
- GENERALIZE: strip specific file paths, IDs, counts, names, error strings. The lesson must apply universally. "audit_repository() scoring failed on empty repo" -> "validate input is non-empty before scoring".
- ONLY extract if the lesson is genuinely reusable across sessions. Skip: one-off bug fixes with no pattern, chitchat, pure exploration with no conclusion, tool-output paraphrasing.
- FAILURE INTEGRATION: when the transcript shows a mistake/retry/failure, capture the NEGATIVE rule in Reflect, not as a positive Approach step.
- Do NOT invent lessons not supported by the transcript. If a chunk is pure exploration or chitchat, output NOTHING (an empty response is correct and preferred over fabrication).
- Do NOT produce a "summary of the session". Produce discrete, reusable experiences or nothing.

Output ONLY the experience blocks (## headings), nothing else. If nothing reusable, output exactly: NO_EXPERIENCES`;

function printPrompt() {
  process.stdout.write(SYSTEM_PROMPT + "\n");
  process.exit(0);
}

async function main() {
  if (process.argv[2] === "--prompt") printPrompt();
  const chunkPath = process.argv[2];
  if (!chunkPath) { console.error("usage: node bin/phase0-extract.cjs <chunk.txt> [out.json] | --prompt"); process.exit(1); }
  const chunk = fs.readFileSync(chunkPath, "utf8");
  const outPath = process.argv[3] || chunkPath.replace(/\.txt$/i, ".extracted.md");

  const model = process.env.PHASE0_MODEL;
  const baseUrl = process.env.PHASE0_BASE_URL;
  const apiKey = process.env.PHASE0_API_KEY;

  if (!model || !baseUrl || !apiKey) {
    // Manual mode: emit the full prompt + chunk for paste into a chat UI.
    const manual = SYSTEM_PROMPT + "\n\n--- TRANSCRIPT CHUNK ---\n\n" + chunk;
    fs.writeFileSync(outPath, manual, "utf8");
    console.log("No PHASE0_MODEL/BASE_URL/API_KEY set. Wrote manual-extraction bundle: " + outPath);
    console.log("Paste its contents into a chat UI (system+user) to get the extraction.");
    process.exit(0);
  }

  // Automated mode: call an OpenAI-compatible /chat/completions endpoint.
  const url = baseUrl.replace(/\/$/, "") + "/chat/completions";
  const body = {
    model,
    temperature: 0.2,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: "Extract reusable experiences from this transcript chunk. Output only experience blocks or NO_EXPERIENCES.\n\n--- TRANSCRIPT CHUNK ---\n\n" + chunk },
    ],
  };
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiKey },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    console.error("HTTP " + res.status + ": " + (await res.text()).slice(0, 500));
    process.exit(1);
  }
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content || "";
  fs.writeFileSync(outPath, text, "utf8");
  console.log("Wrote extraction (" + text.length + " chars) -> " + outPath);
}

main().catch((e) => { console.error(e); process.exit(1); });
