#!/usr/bin/env bash
# setup.sh — Ola one-command installer (Bash / Git Bash / Linux / macOS)
#
# Prerequisites: Node.js >= 22
# This script:
#   1. Checks prerequisites
#   2. Runs contract tests
#   3. Wires Ola into ZCode config
#   4. Verifies MCP handshake
#   5. Prints next steps

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "═══════════════════════════════════════════════════════════════"
echo "  Ola Setup — agent-neutral cognitive memory"
echo "═══════════════════════════════════════════════════════════════"
echo ""

# ── 1. Check prerequisites ──────────────────────────────────────

echo "Checking prerequisites..."

# Node.js >= 22
if ! command -v node &>/dev/null; then
  echo "✗ Node.js not found. Install Node.js >= 22 and re-run."
  exit 1
fi
NODE_VERSION=$(node -e "process.stdout.write(process.versions.node.split('.')[0])")
if [ "$NODE_VERSION" -lt 22 ]; then
  echo "✗ Node.js $NODE_VERSION found, need >= 22 (for node:sqlite)."
  exit 1
fi
echo "  ✓ Node.js $(node --version)"

# ── 2. Run contract tests ────────────────────────────────────────

echo ""
echo "Running contract tests..."
if node bin/test-contracts.cjs 2>&1 | tail -1 | grep -q "0 failed"; then
  echo "  ✓ All contract tests passed"
else
  echo "  ✗ Contract tests failed. Fix before proceeding."
  node bin/test-contracts.cjs
  exit 1
fi

# ── 3. Wire Ola into ZCode ────────────────────────────────────

echo ""
echo "Wiring Ola into ZCode config..."
node bin/wire-ola.cjs --dry-run
echo ""
read -p "Apply these changes? [Y/n] " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Nn]$ ]]; then
  node bin/wire-ola.cjs
fi

# ── 4. Verify MCP handshake ──────────────────────────────────────

echo ""
echo "Verifying MCP server handshake..."
HANDSHAKE=$(echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' | node mcp/server.js 2>/dev/null)
if echo "$HANDSHAKE" | grep -q "ola"; then
  echo "  ✓ Ola MCP server responds correctly"
else
  echo "  ✗ MCP handshake failed"
  exit 1
fi

# ── 5. Print next steps ──────────────────────────────────────────

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "  Setup complete!"
echo "═══════════════════════════════════════════════════════════════"
echo ""
echo "Next steps:"
echo "  1. Restart ZCode"
echo "  2. In any project, the agent now has:"
echo "     - Ola's hooks (session-start, prompt-submit, pre/post-tool-use)"
echo "     - Ola's MCP tools: recall, recall_memory, remember, self_assess, status"
echo "     - codebase-memory's 14 tools (L1 graph)"
echo "  3. Run the 'status' tool to verify all layers"
echo ""
echo "To manage memory lifecycle: node bin/maintain.cjs --stats"
echo "To run contract tests:      node bin/test-contracts.cjs"
echo ""
