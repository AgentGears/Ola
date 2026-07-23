// tests/offload-secrets.test.cjs
//
// Phase V secrets scanner tests.
//
// Verifies:
//   - Tier 1 patterns detected (AWS, GitHub, Slack, PEM, credential URL)
//   - Tier 2 patterns detected (.env, bearer, AWS secret key)
//   - False positive controls (UUID, ULID, SHA, base64, email NOT flagged)
//   - Findings contain NO raw match
//   - Multi-field scanning
//
// Each test exits 0 on pass, 1 on fail.

"use strict";

const { scanForSecrets, scanFields, maskValue, isValidJwt } = require("../hooks/lib/secrets");

let allPass = true;
const results = [];

function test(name, fn) {
  return Promise.resolve().then(fn).then(
    () => { results.push({ name, ok: true }); console.log("  PASS: " + name); },
    (e) => { results.push({ name, ok: false, err: e.message }); allPass = false; console.log("  FAIL: " + name + " - " + e.message); }
  );
}

function assert(cond, msg) { if (!cond) throw new Error(msg || "assertion failed"); }

// ── Helper: verify no finding contains the raw secret ────────

function assertNoRawSecret(findings, secret) {
  for (const f of findings) {
    // Check masked_preview doesn't contain enough of the secret
    // masked_preview should be like "AKIA...4QXJ" not the full value
    if (f.masked_preview && f.masked_preview.length > secret.length - 4) {
      throw new Error("masked_preview too revealing: " + f.masked_preview + " for secret of length " + secret.length);
    }
    // No match field should exist
    if (f.match !== undefined) {
      throw new Error("finding contains match field: " + JSON.stringify(f));
    }
    // No match_digest field should exist
    if (f.match_digest !== undefined) {
      throw new Error("finding contains match_digest field: " + JSON.stringify(f));
    }
  }
}

// ── Tests ───────────────────────────────────────────────────────

async function main() {
  console.log("");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("offload-secrets: scanner, false-positive controls, no-raw-leak");
  console.log("═══════════════════════════════════════════════════════════════");

  // ── Tier 1 detection ─────────────────────────────────────────

  await test("Tier 1: AWS access key ID detected", () => {
    const text = "export AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE";
    const { findings, hasHighConfidence } = scanForSecrets(text, { field: "stdout" });
    const awsFindings = findings.filter((f) => f.class === "aws");
    assert(awsFindings.length > 0, "should detect AWS key");
    assert(hasHighConfidence === true, "should be high confidence");
    assertNoRawSecret(awsFindings, "AKIAIOSFODNN7EXAMPLE");
  });

  await test("Tier 1: GitHub token detected", () => {
    const text = "GITHUB_TOKEN=ghp_1234567890abcdefghijklmnopqrstuvwxyz";
    const { findings, hasHighConfidence } = scanForSecrets(text, { field: "stdout" });
    const ghFindings = findings.filter((f) => f.class === "github");
    assert(ghFindings.length > 0, "should detect GitHub token");
    assert(hasHighConfidence === true, "should be high confidence");
  });

  await test("Tier 1: PEM private key detected", () => {
    const text = "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----";
    const { findings, hasHighConfidence } = scanForSecrets(text, { field: "stdout" });
    const keyFindings = findings.filter((f) => f.class === "private_key");
    assert(keyFindings.length > 0, "should detect PEM private key");
    assert(hasHighConfidence === true, "should be high confidence");
  });

  await test("Tier 1: credential URL detected", () => {
    const text = "mongodb://admin:secretpass@cluster.example.com:27017";
    const { findings, hasHighConfidence } = scanForSecrets(text, { field: "command" });
    const urlFindings = findings.filter((f) => f.class === "credential_url");
    assert(urlFindings.length > 0, "should detect credential URL");
    assert(hasHighConfidence === true, "should be high confidence");
  });

  await test("Tier 1: Slack token detected", () => {
    const text = "SLACK_BOT_TOKEN=xoxb-1234567890-abcdefghij";
    const { findings, hasHighConfidence } = scanForSecrets(text, { field: "stdout" });
    const slackFindings = findings.filter((f) => f.class === "slack");
    assert(slackFindings.length > 0, "should detect Slack token");
    assert(hasHighConfidence === true, "should be high confidence");
  });

  // ── Tier 2 detection ─────────────────────────────────────────

  await test("Tier 2: .env secret assignment detected", () => {
    const text = 'DATABASE_PASSWORD=supersecretpass123';
    const { findings } = scanForSecrets(text, { field: "stdout" });
    const envFindings = findings.filter((f) => f.class === "env_secret");
    assert(envFindings.length > 0, "should detect .env assignment");
    assertNoRawSecret(envFindings, "supersecretpass123");
  });

  await test("Tier 2: bearer authorization header detected", () => {
    const text = "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const { findings } = scanForSecrets(text, { field: "stdout" });
    const authFindings = findings.filter((f) => f.class === "auth_header");
    assert(authFindings.length > 0, "should detect bearer header");
  });

  await test("Tier 2: AWS secret access key detected", () => {
    const text = "aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
    const { findings } = scanForSecrets(text, { field: "stdout" });
    const awsFindings = findings.filter((f) => f.pattern_id === "aws_secret_access_key");
    assert(awsFindings.length > 0, "should detect AWS secret key");
  });

  // ── False positive controls ──────────────────────────────────

  await test("FP control: UUID not flagged", () => {
    const text = "id: 550e8400-e29b-41d4-a716-446655440000";
    const { findings, hasHighConfidence } = scanForSecrets(text, { field: "stdout" });
    assert(findings.length === 0, "UUID should not be flagged, got " + findings.length + " findings");
    assert(hasHighConfidence === false, "should not be high confidence");
  });

  await test("FP control: ULID not flagged", () => {
    const text = "observation_id: obs_01KXCC8KHMSA94576P5BN5KNR7";
    const { findings } = scanForSecrets(text, { field: "stdout" });
    assert(findings.length === 0, "ULID should not be flagged, got " + findings.length + " findings");
  });

  await test("FP control: git commit SHA not flagged", () => {
    const text = "commit abc123def456789012345678901234567890abcd";
    const { findings } = scanForSecrets(text, { field: "stdout" });
    // No bare hex pattern should match
    assert(findings.length === 0, "commit SHA should not be flagged, got " + findings.length + " findings");
  });

  await test("FP control: SHA-256 digest not flagged", () => {
    const text = "sha256:5c9f6f85f1e7a3b2c8d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6";
    const { findings } = scanForSecrets(text, { field: "stdout" });
    assert(findings.length === 0, "SHA-256 digest should not be flagged, got " + findings.length + " findings");
  });

  await test("FP control: base64 data not flagged", () => {
    const text = "data:application/octet-stream;base64,SGVsbG8gV29ybGQhIFRoaXMgaXMgYSB0ZXN0IG9mIGJhc2U2NCBlbmNvZGluZy4=";
    const { findings } = scanForSecrets(text, { field: "stdout" });
    // Base64 data alone (without secret keyword anchor) should not match
    assert(findings.length === 0, "base64 data should not be flagged, got " + findings.length + " findings");
  });

  await test("FP control: email address not flagged as credential URL", () => {
    const text = "Contact: admin@example.com for details";
    const { findings } = scanForSecrets(text, { field: "stdout" });
    const urlFindings = findings.filter((f) => f.class === "credential_url");
    assert(urlFindings.length === 0, "email should not be flagged as credential URL");
  });

  // ── No raw match in findings ─────────────────────────────────

  await test("Findings never contain raw match field", () => {
    const text = "AKIAIOSFODNN7EXAMPLE and ghp_1234567890abcdefghijklmnopqrstuvwxyz";
    const { findings } = scanForSecrets(text, { field: "stdout" });
    for (const f of findings) {
      assert(f.match === undefined, "finding should not have match field");
      assert(f.match_digest === undefined, "finding should not have match_digest field");
    }
  });

  await test("Masked preview is sufficiently masked", () => {
    const secret = "AKIAIOSFODNN7EXAMPLE";
    const masked = maskValue(secret);
    assert(masked.length < secret.length, "masked should be shorter than original");
    assert(masked.includes("..."), "masked should contain ellipsis");
    // Should not reveal more than 8 chars of the original
    const revealedChars = masked.replace(/\./g, "").length;
    assert(revealedChars <= 8, "masked reveals too many chars: " + revealedChars);
  });

  // ── Multi-field scanning ─────────────────────────────────────

  await test("scanFields: detects secrets across multiple fields", () => {
    const result = scanFields({
      command: "export TOKEN=ghp_1234567890abcdefghijklmnopqrstuvwxyz",
      stdout: "AKIAIOSFODNN7EXAMPLE in output",
      stderr: "no secrets here",
    });
    assert(result.findings.length >= 2, "should find secrets in command and stdout");
    assert(result.hasHighConfidence === true, "should be high confidence");

    // Verify field labels are correct
    const cmdFindings = result.findings.filter((f) => f.field === "command");
    const stdoutFindings = result.findings.filter((f) => f.field === "stdout");
    assert(cmdFindings.length > 0, "should have command field findings");
    assert(stdoutFindings.length > 0, "should have stdout field findings");
  });

  await test("scanFields: empty/null fields handled safely", () => {
    const result = scanFields({ command: null, stdout: undefined, stderr: "" });
    assert(result.findings.length === 0, "should return no findings");
    assert(result.hasHighConfidence === false, "should not be high confidence");
  });

  // ── JWT validation ───────────────────────────────────────────

  await test("isValidJwt: valid JWT header accepted", () => {
    // eyJhbGciOiJIUzI1NiJ9 = base64url of {"alg":"HS256"}
    const text = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    assert(isValidJwt(text, 0), "valid JWT should be accepted");
  });

  await test("isValidJwt: non-JWT base64url rejected", () => {
    // Three base64url segments but not a JWT
    const text = "SGVsbG8gV29ybGQ.his.is.a.test.of.base64";
    assert(!isValidJwt(text, 0), "non-JWT should be rejected");
  });

  // ── Summary ──────────────────────────────────────────────────

  // ── Adversarial regex regression tests ───────────────────────
  //
  // Lock the catastrophic-backtracking fix for credential_url.
  // A future pattern edit must not silently reintroduce superlinear behavior.

  await test("Adversarial: long repetitive non-URL string scans in <50ms", () => {
    const text = "x".repeat(40 * 1024);
    const start = process.hrtime.bigint();
    const { findings } = scanForSecrets(text, { field: "stdout" });
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
    assert(findings.length === 0, "should find no secrets");
    assert(elapsedMs < 50, "scan <50ms, got " + elapsedMs.toFixed(1) + "ms");
  });

  await test("Adversarial: long URL-like near-miss scans in <50ms", () => {
    const text = "https://" + "a".repeat(40 * 1024);
    const start = process.hrtime.bigint();
    scanForSecrets(text, { field: "stdout" });
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
    assert(elapsedMs < 50, "scan <50ms, got " + elapsedMs.toFixed(1) + "ms");
  });

  await test("Adversarial: scheme-like prefix without :// scans fast", () => {
    const text = "abcdef" + "-.0".repeat(13 * 1024);
    const start = process.hrtime.bigint();
    scanForSecrets(text, { field: "stdout" });
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
    assert(elapsedMs < 50, "scan <50ms, got " + elapsedMs.toFixed(1) + "ms");
  });

  await test("Adversarial: real credential still detected despite bounded scheme", () => {
    const text = "mongodb://admin:secretpass@cluster.example.com:27017";
    const { findings, hasHighConfidence } = scanForSecrets(text, { field: "command" });
    const urlFindings = findings.filter((f) => f.class === "credential_url");
    assert(urlFindings.length > 0, "should detect credential URL");
    assert(hasHighConfidence === true);
  });

  console.log("");
  console.log("═══════════════════════════════════════════════════════════════");
  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;
  console.log("offload-secrets: " + passed + " passed, " + failed + " failed (" + results.length + " total)");
  console.log("═══════════════════════════════════════════════════════════════");
  process.exit(allPass ? 0 : 1);
}

main();
