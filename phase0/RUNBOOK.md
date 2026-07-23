# Phase 0 Runbook — the extraction-quality gate

**Goal:** prove that LLM extraction into the OpenViking-style `experiences` schema produces
low-false-positive memories on YOUR real transcripts, BEFORE building any storage code.
This is the gate that v0.1–0.3 failed. Do not skip it.

**Time budget:** one afternoon. If it passes, the rest of zcode-memory-v2 is engineering.
If it fails, you've saved a quarter of building on a broken premise.

---

## What's already built (in this repo)

| File | Purpose |
|---|---|
| `bin/probe-transcripts.cjs` | Survey sessions across projects (parts/tools/errors per session) |
| `bin/dump-session.cjs <sid> [out] [maxtool]` | Flatten one session's part stream to a readable transcript. `--inspect <sid>` prints raw tool-part JSON shape. |
| `bin/phase0-chunk.cjs <transcript.txt> [maxChars]` | Split a transcript into ~12k-char chunks on turn boundaries |
| `bin/phase0-extract.cjs <chunk.txt> [out]` | Emit the extraction prompt + chunk as a paste-ready bundle (no API key) OR call an OpenAI-compatible endpoint (with `PHASE0_MODEL`/`PHASE0_BASE_URL`/`PHASE0_API_KEY`) |
| `bin/phase0-score.cjs <extraction.md> [gold.md]` | Structural scoring + hand-judgment checklist |
| `phase0/gold-ampify.md` | Hand-distilled gold standard for the Ampify session |
| `phase0/samples/chunk08-lessonrich.txt` | Paste-ready bundle — a lesson-rich chunk (wave commits) |
| `phase0/samples/chunk02-noise.txt` | Paste-ready bundle — a near-noise chunk (exploration + summary) |

---

## The gate, step by step

### Step 1 — Run the two sample extractions (30 min)

Open `phase0/samples/chunk08-lessonrich.txt` and `phase0/samples/chunk02-noise.txt`.
Each is `system prompt + transcript chunk` concatenated. Paste into any chat model
(your main model, or GPT-4-class). Save each model response as:
- `phase0/samples/chunk08.extracted.md`
- `phase0/samples/chunk02.extracted.md`

### Step 2 — Score the lesson-rich chunk against gold (15 min)

```
node bin/phase0-score.cjs phase0/samples/chunk08.extracted.md phase0/gold-ampify.md
```

Work through the hand-judgment checklist it prints. For each gold experience: TP or MISS?
For each extracted experience not in gold: legitimate / duplicate / FABRICATION?

### Step 3 — The two judgments that decide the gate

**Judgment A (restraint on noise):** Look at chunk02's extraction.
The correct answer for a near-noise chunk is `NO_EXPERIENCES` or at most ONE weak lesson.
- If the model output 3+ experiences on chunk02 → **FAIL**. It will bloat your memory store
  with fabrications on every exploration session. The prompt's atomic-scope + generalization
  rules didn't hold. Needs prompt hardening before proceeding.
- If it output 0-1 → good restraint.

**Judgment B (quality on signal):** Look at chunk08's extraction against gold.
- Did it capture the wave-commit workflow / test-attribution / baseline-test lessons? (TP)
- Did it fabricate lessons the transcript doesn't support? (FP)
- Did it bloat (Approach > 8 bullets, or session-summary instead of discrete experiences)?

### Step 4 — Pass/fail

**PASS** if:
- chunk08: most gold lessons captured (≥3 of 5), fabrication ≤ ~20% of extracted, no bloat.
- chunk02: NO_EXPERIENCES or ≤1 weak experience.

Then proceed to Phase 1 (schema + merge_ops). The extraction approach is viable.

**FAIL** if:
- The model fabricates freely on noise chunks, OR
- It produces session-summaries instead of atomic reusable experiences, OR
- Bloat is the norm (>8 bullets, multi-intent blocks).

Then the prompt needs hardening BEFORE any storage work. Iterate the prompt
(tighter negative examples, harder atomic-scope enforcement, maybe few-shot
NO_EXPERIENCES examples) and re-run. If it still fails after 2-3 prompt iterations,
the premise is in question — and you've spent a day, not a quarter.

---

## Going beyond the two samples — fully automated gate

The two chunks are the minimum gate. For full confidence, automate the whole session:

### Automated path (one command each)

```bash
# 1. Set up an OpenAI-compatible endpoint (your provider, or LM Studio if it serves chat)
export PHASE0_MODEL=<chat-model>
export PHASE0_BASE_URL=<https://...>
export PHASE0_API_KEY=<key>

# 2. Dump + chunk the session (if not already done)
node bin/dump-session.cjs <session_id> "$TEMP/ampify-transcript.txt"
node bin/phase0-chunk.cjs "$TEMP/ampify-transcript.txt"

# 3. Run extraction across ALL chunks (~47 calls for Ampify)
node bin/phase0-run.cjs "$TEMP/ampify-transcript.txt"
#   -> writes run-NN.extracted.md per chunk + prints a structural summary
#      (experiences per chunk, NO_EXPERIENCES count, bloat flags)

# 4. Judge the extractions against gold (semantic TP/FP/MISS)
#    RECURSIVE-TRUST RULE: use a DIFFERENT/STRONGER judge model than the extractor
export PHASE0_JUDGE_MODEL=<stronger-or-different-chat-model>
node bin/phase0-judge.cjs ampify-transcript.phase0 phase0/gold-ampify.md
#   -> prints per-chunk TP/DUP/FABRICATION + a final tally with PASS/FAIL guidance
```

### What's automated vs what you still must do

| Step | Automated? |
|---|---|
| Dump + chunk | Yes |
| Run extraction on all chunks | Yes (`phase0-run.cjs`) |
| Structural scoring (bloat, format, restraint) | Yes (in `phase0-run` summary) |
| Semantic TP/FP/MISS | Yes, via LLM-judge (`phase0-judge.cjs`) |
| **Spot-checking the judge's disagreements** | **No — and must not be.** See below. |

### The recursive-trust rule (do not violate)

You cannot fully automate the decision of whether to trust automation. If the same model extracts AND judges, the judge inherits the extractor's blind spots — you've moved trust, not earned it.

- Use a **stronger or different model** as judge (`PHASE0_JUDGE_MODEL` ≠ `PHASE0_MODEL`). The judge script warns if they're the same.
- Even then, **spot-check 3-5 of the judge's FABRICATION and MISSING calls by hand.** If the judge is wrong about those, its tally is wrong.
- A judge that agrees with a bad extractor 100% is not validation — it's correlated failure.

The judge gets you from "read 47 extractions" to "read 5 flagged disagreements." That's the honest ceiling of gate automation. The final 5 are yours.

---

## What "pass" unlocks

If the gate passes, you have empirical proof that schema-constrained LLM extraction
clears the false-positive bar that killed v0.1–0.3. Phase 1 (schema + merge_ops in JS)
and Phase 2 (the `remember` tool) are then pure engineering — the riskiest part is behind you.

## What "fail" means

It does NOT mean memory is impossible. It means the *fully-automatic* extraction path
(Phase 4) is unreliable, and you should lean on **agent-invoked `remember`** (Phase 2)
where the main agent — which has full context — does the distillation, not a separate
blind extraction call. That path is lower-volume but higher-precision, and it needs no
extraction-quality gate because the agent is already reasoning about the task.
