# setup.ps1 — Ola one-command installer (PowerShell / native Windows)
#
# Prerequisites: Node.js >= 22
# This script:
#   1. Checks prerequisites
#   2. Runs contract tests
#   3. Wires Ola into ZCode config
#   4. Verifies MCP handshake
#   5. Prints next steps

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ScriptDir

Write-Host "═══════════════════════════════════════════════════════════════"
Write-Host "  Ola Setup — agent-neutral cognitive memory"
Write-Host "═══════════════════════════════════════════════════════════════"
Write-Host ""

# ── 1. Check prerequisites ──────────────────────────────────────

Write-Host "Checking prerequisites..."

# Node.js >= 22
$nodeVersion = $null
try { $nodeVersion = (node --version) -replace 'v(\d+)\..*', '$1' } catch {}
if (-not $nodeVersion) {
    Write-Host "✗ Node.js not found. Install Node.js >= 22 and re-run."
    exit 1
}
if ([int]$nodeVersion -lt 22) {
    Write-Host "✗ Node.js v$nodeVersion found, need >= 22 (for node:sqlite)."
    exit 1
}
Write-Host "  ✓ Node.js $(node --version)"

# ── 2. Run contract tests ────────────────────────────────────────

Write-Host ""
Write-Host "Running contract tests..."
$testResult = node bin/test-contracts.cjs 2>&1 | Select-Object -Last 1
if ($testResult -match "0 failed") {
    Write-Host "  ✓ All contract tests passed"
} else {
    Write-Host "  ✗ Contract tests failed."
    node bin/test-contracts.cjs
    exit 1
}

# ── 3. Wire Ola into ZCode ────────────────────────────────────

Write-Host ""
Write-Host "Wiring Ola into ZCode config..."
node bin/wire-ola.cjs --dry-run
$apply = Read-Host "`nApply these changes? [Y/n]"
if ($apply -ne "n" -and $apply -ne "N") {
    node bin/wire-ola.cjs
}

# ── 4. Verify MCP handshake ──────────────────────────────────────

Write-Host ""
Write-Host "Verifying MCP server handshake..."
$handshake = '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' | node mcp/server.js 2>$null
if ($handshake -match "ola") {
    Write-Host "  ✓ Ola MCP server responds correctly"
} else {
    Write-Host "  ✗ MCP handshake failed"
    exit 1
}

# ── 5. Print next steps ──────────────────────────────────────────

Write-Host ""
Write-Host "═══════════════════════════════════════════════════════════════"
Write-Host "  Setup complete!"
Write-Host "═══════════════════════════════════════════════════════════════"
Write-Host ""
Write-Host "Next steps:"
Write-Host "  1. Restart ZCode"
Write-Host "  2. In any project, the agent now has:"
Write-Host "     - Ola's hooks (session-start, prompt-submit, pre/post-tool-use)"
Write-Host "     - Ola's MCP tools: recall, recall_memory, remember, self_assess, status"
Write-Host "     - codebase-memory's 14 tools (L1 graph)"
Write-Host "  3. Run the 'status' tool to verify all layers"
Write-Host ""
Write-Host "To manage memory lifecycle: node bin/maintain.cjs --stats"
Write-Host "To run contract tests:      node bin/test-contracts.cjs"
Write-Host ""
