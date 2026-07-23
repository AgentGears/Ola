<#
.SYNOPSIS
    R1.5 Workspace Relocation: C:\Next-Era\Moneta -> C:\Next-Era\Ola
.DESCRIPTION
    Performs the external workspace relocation per docs/r1.5-relocation-checklist.md.
    Must be run from OUTSIDE the workspace being renamed (e.g., from C:\Next-Era\).

    Default mode is -DryRun (shows what would happen, changes nothing).
    Use -Execute to perform the actual relocation.
    Use -Verify to run the test suite from the new path with temporary data roots.

    MUST be copied outside the Moneta directory before running:
      Copy-Item "C:\Next-Era\Moneta\relocate-to-ola.ps1" "C:\Next-Era\relocate-to-ola.ps1"
      cd C:\Next-Era
      powershell -ExecutionPolicy Bypass -File relocate-to-ola.ps1 -DryRun
#>

[CmdletBinding(DefaultParameterSetName="DryRun")]
param(
    [Parameter(ParameterSetName="DryRun")]
    [switch]$DryRun,

    [Parameter(ParameterSetName="Execute")]
    [switch]$Execute,

    [Parameter(ParameterSetName="Verify")]
    [switch]$Verify,

    [string]$OldPath = "C:\Next-Era\Moneta",

    [string]$NewPath = "C:\Next-Era\Ola",

    [string]$ZCodeConfig
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 3.0

if (-not $ZCodeConfig) {
    $ZCodeConfig = Join-Path $env:USERPROFILE ".zcode\cli\config.json"
}

# Helpers
function Write-Step($msg) { Write-Host ""; Write-Host "=== $msg ===" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "  [OK] $msg" -ForegroundColor Green }
function Write-Warn2($msg) { Write-Host "  [WARN] $msg" -ForegroundColor Yellow }
function Write-Err2($msg)  { Write-Host "  [FAIL] $msg" -ForegroundColor Red }
function Write-Info2($msg) { Write-Host "  $msg" }
function Get-Ts { return Get-Date -Format "yyyyMMdd-HHmmss" }

# ── DRY RUN ────────────────────────────────────────────────────────

if ($DryRun -or (-not $Execute -and -not $Verify)) {
    Write-Host ""
    Write-Host "********************************************************" -ForegroundColor Yellow
    Write-Host "* R1.5 WORKSPACE RELOCATION - DRY RUN" -ForegroundColor Yellow
    Write-Host "* No changes will be made." -ForegroundColor Yellow
    Write-Host "********************************************************" -ForegroundColor Yellow

    Write-Step "Pre-flight Checks"

    if (Test-Path $OldPath) {
        $itemCount = (Get-ChildItem $OldPath -Recurse -File -ErrorAction SilentlyContinue).Count
        Write-Ok "Old workspace exists: $OldPath ($itemCount files)"
    } else {
        Write-Err2 "Old workspace NOT FOUND: $OldPath"
        exit 1
    }

    if (Test-Path $NewPath) {
        Write-Warn2 "New path ALREADY EXISTS: $NewPath"
        Write-Info2 "Rename would fail. Remove or rename the existing directory first."
    } else {
        Write-Ok "New path available: $NewPath"
    }

    if (Test-Path $ZCodeConfig) {
        Write-Ok "ZCode config found: $ZCodeConfig"
    } else {
        Write-Warn2 "ZCode config NOT FOUND: $ZCodeConfig"
    }

    Write-Step "Process Check"
    $nodeProcs = @()
    try {
        $nodeProcs = @(Get-Process node -ErrorAction SilentlyContinue | Where-Object {
            try { $_.CommandLine -and ($_.CommandLine -like "*$OldPath*") } catch { $false }
        })
    } catch { }

    if ($nodeProcs.Count -gt 0) {
        Write-Warn2 "Found $($nodeProcs.Count) Node process(es) referencing old workspace"
        foreach ($p in $nodeProcs) {
            $cmd = if ($p.CommandLine) { $p.CommandLine.Substring(0, [Math]::Min(100, $p.CommandLine.Length)) } else { "(no cmdline)" }
            Write-Info2 "  PID $($p.Id): $cmd..."
        }
        Write-Info2 "These must be stopped before -Execute."
    } else {
        Write-Ok "No Node processes reference the old workspace path"
    }

    $zcodeProcs = @()
    try { $zcodeProcs = @(Get-Process -Name "zcode" -ErrorAction SilentlyContinue) } catch { }
    if ($zcodeProcs.Count -gt 0) {
        Write-Warn2 "ZCode is RUNNING (PID: $($zcodeProcs.Id -join ', '))"
        Write-Info2 "ZCode must be closed before -Execute."
    } else {
        Write-Ok "ZCode is not running"
    }

    Write-Step "Planned Actions (dry run - nothing executed)"
    $backupPath = "$OldPath.r1-backup-$(Get-Ts)"
    Write-Info2 "1. Backup:    Copy $OldPath -> $backupPath"
    Write-Info2 "2. Rename:    $OldPath -> $NewPath"
    Write-Info2 "3. Config:    Update $ZCodeConfig"
    Write-Info2 "              - plugins.dirs: '$OldPath' -> '$NewPath'"
    Write-Info2 "              - enabledPlugins: 'moneta@inline' -> 'ola@inline'"

    Write-Host ""
    Write-Host "To execute: .\relocate-to-ola.ps1 -Execute" -ForegroundColor Yellow
    Write-Host "To verify after: .\relocate-to-ola.ps1 -Verify" -ForegroundColor Yellow
    Write-Host ""
    exit 0
}

# ── EXECUTE ────────────────────────────────────────────────────────

if ($Execute) {
    Write-Host ""
    Write-Host "********************************************************" -ForegroundColor Yellow
    Write-Host "* R1.5 WORKSPACE RELOCATION - EXECUTE" -ForegroundColor Yellow
    Write-Host "********************************************************" -ForegroundColor Yellow
    Write-Host ""

    Write-Step "Step 0: Pre-flight Validation"

    if (-not (Test-Path $OldPath)) {
        Write-Err2 "Old workspace not found: $OldPath"
        exit 1
    }
    if (Test-Path $NewPath) {
        Write-Err2 "New path already exists: $NewPath - cannot rename over it"
        Write-Info2 "Remove or rename the existing directory, then re-run."
        exit 1
    }
    if (-not (Test-Path $ZCodeConfig)) {
        Write-Err2 "ZCode config not found: $ZCodeConfig"
        exit 1
    }
    Write-Ok "Paths validated"

    Write-Step "Step 1: Process Quiescence Check"

    $zcodeProcs = @()
    try { $zcodeProcs = @(Get-Process -Name "zcode" -ErrorAction SilentlyContinue) } catch { }
    if ($zcodeProcs.Count -gt 0) {
        Write-Err2 "ZCode is still running (PID: $($zcodeProcs.Id -join ', '))"
        Write-Info2 "Close ZCode completely before running -Execute."
        exit 1
    }
    Write-Ok "ZCode is not running"

    $conflictProcs = @()
    try {
        $conflictProcs = @(Get-Process node -ErrorAction SilentlyContinue | Where-Object {
            try { $_.CommandLine -and ($_.CommandLine -like "*$OldPath*") } catch { $false }
        })
    } catch { }
    if ($conflictProcs.Count -gt 0) {
        Write-Err2 "$($conflictProcs.Count) Node process(es) still reference old workspace:"
        foreach ($p in $conflictProcs) { Write-Info2 "  PID $($p.Id)" }
        Write-Info2 "Stop these processes first."
        exit 1
    }
    Write-Ok "No Node processes reference the old workspace"

    Write-Step "Step 2: Backup ZCode Config"
    $configBackup = "$ZCodeConfig.bak.r15-$(Get-Ts)"
    Copy-Item $ZCodeConfig $configBackup
    Write-Ok "Config backed up: $configBackup"

    Write-Step "Step 3: Create Workspace Backup"
    $backupPath = "$OldPath.r1-backup-$(Get-Ts)"
    Write-Info2 "Copying $OldPath -> $backupPath (this may take a moment)..."
    Copy-Item -Path $OldPath -Destination $backupPath -Recurse -Force
    Write-Ok "Backup created: $backupPath"

    $origCount = (Get-ChildItem $OldPath -Recurse -File -ErrorAction SilentlyContinue).Count
    $backupCount = (Get-ChildItem $backupPath -Recurse -File -ErrorAction SilentlyContinue).Count
    if ($origCount -ne $backupCount) {
        Write-Err2 "Backup verification FAILED: $origCount files in source, $backupCount in backup"
        Write-Info2 "Do NOT proceed. Investigate the backup discrepancy."
        exit 1
    }
    Write-Ok "Backup verified: $backupCount files match"

    Write-Step "Step 4: Rename Workspace"
    Write-Info2 "Renaming $OldPath -> $NewPath ..."
    Rename-Item -Path $OldPath -NewName $NewPath

    if (-not (Test-Path $NewPath)) {
        Write-Err2 "Rename FAILED - new path does not exist: $NewPath"
        Write-Info2 "Backup is at: $backupPath"
        exit 1
    }
    if (Test-Path $OldPath) {
        Write-Err2 "Rename PARTIAL - both old and new paths exist"
        exit 1
    }
    Write-Ok "Workspace renamed: $NewPath"

    Write-Step "Step 5: Update ZCode Config"
    $configText = Get-Content $ZCodeConfig -Raw

    # Update plugins.dirs: replace old path with new path (handle escaped backslashes in JSON)
    $oldPathJson = $OldPath -replace "\\", "\\\\"
    $newPathJson = $NewPath -replace "\\", "\\\\"
    $configText = $configText.Replace($oldPathJson, $newPathJson)

    # Also handle forward-slash variant
    $oldPathFwd = $OldPath -replace "\\", "/"
    $newPathFwd = $NewPath -replace "\\", "/"
    $configText = $configText.Replace($oldPathFwd, $newPathFwd)

    # Update enabledPlugins: moneta@inline -> ola@inline
    if ($configText.Contains('"moneta@inline"')) {
        if (-not $configText.Contains('"ola@inline"')) {
            $configText = $configText.Replace('"moneta@inline": true', '"ola@inline": true, "moneta@inline": false')
        } else {
            $configText = $configText.Replace('"moneta@inline": true', '"moneta@inline": false')
            $configText = $configText.Replace('"ola@inline": false', '"ola@inline": true')
        }
        Write-Info2 "Plugin IDs updated: moneta@inline -> ola@inline"
    }

    Set-Content -Path $ZCodeConfig -Value $configText -NoNewline

    $verifyConfig = Get-Content $ZCodeConfig -Raw
    if ($verifyConfig -ne $configText) {
        Write-Err2 "Config write verification FAILED"
        Copy-Item $configBackup $ZCodeConfig -Force
        exit 1
    }

    if ($verifyConfig.Contains($newPathJson)) {
        Write-Ok "Config updated: plugins.dirs contains $NewPath"
    } else {
        Write-Warn2 "Config may not contain new path - verify manually"
        Write-Info2 "Config backup at: $configBackup"
    }

    if ($verifyConfig.Contains($oldPathJson)) {
        Write-Warn2 "Old path still present in config - manual cleanup may be needed"
    } else {
        Write-Ok "No old workspace path in config"
    }

    try {
        $null = $verifyConfig | ConvertFrom-Json
        Write-Ok "Config is valid JSON"
    } catch {
        Write-Err2 "Config is INVALID JSON after mutation!"
        Write-Info2 "Restoring from backup: $configBackup"
        Copy-Item $configBackup $ZCodeConfig -Force
        exit 1
    }

    Write-Step "Relocation Complete"
    Write-Ok "Workspace: $NewPath"
    Write-Ok "Backup:    $backupPath"
    Write-Ok "Config:    $ZCodeConfig (backup: $configBackup)"
    Write-Host ""
    Write-Info2 "Next steps:"
    Write-Info2 "  1. Start ZCode from $NewPath"
    Write-Info2 "  2. Run verification: .\relocate-to-ola.ps1 -Verify"
    Write-Info2 "  3. Do NOT resume production use against ~/.ola/ before R2"
    Write-Host ""
    Write-Info2 "Rollback (if needed):"
    Write-Info2 "  1. Close ZCode"
    Write-Info2 "  2. Rename $NewPath back to $OldPath"
    Write-Info2 "  3. Restore config: Copy-Item '$configBackup' '$ZCodeConfig' -Force"
    Write-Host ""
    exit 0
}

# ── VERIFY ─────────────────────────────────────────────────────────

if ($Verify) {
    Write-Host ""
    Write-Host "********************************************************" -ForegroundColor Yellow
    Write-Host "* R1.5 VERIFICATION - from new workspace" -ForegroundColor Yellow
    Write-Host "********************************************************" -ForegroundColor Yellow
    Write-Host ""

    if (-not (Test-Path $NewPath)) {
        Write-Err2 "New workspace not found: $NewPath"
        Write-Info2 "Run -Execute first."
        exit 1
    }

    $tempData = Join-Path $env:TEMP "ola-r15-verify-data-$(Get-Ts)"
    $tempOffload = Join-Path $env:TEMP "ola-r15-verify-offload-$(Get-Ts)"
    New-Item -ItemType Directory -Path $tempData -Force | Out-Null
    New-Item -ItemType Directory -Path $tempOffload -Force | Out-Null

    Write-Info2 "Using temporary data roots (does not touch ~/.ola/):"
    Write-Info2 "  OLA_DATA_DIR=$tempData"
    Write-Info2 "  OLA_OFFLOAD_DIR=$tempOffload"

    $env:OLA_DATA_DIR = $tempData
    $env:OLA_OFFLOAD_DIR = $tempOffload

    Write-Step "Test Suite (20/20 expected)"
    Push-Location $NewPath
    try {
        $testResult = Start-Process -FilePath "node" -ArgumentList "tests/run-all.cjs" -NoNewWindow -Wait -PassThru -RedirectStandardOutput "verify-test-output.txt" -RedirectStandardError "verify-test-stderr.txt"
        $output = Get-Content "verify-test-output.txt" -Raw -ErrorAction SilentlyContinue

        if ($testResult.ExitCode -eq 0) {
            Write-Ok "Test suite PASSED (exit 0)"
            $passes = ([regex]::Matches($output, ">>> .+? PASSED")).Count
            $fails = ([regex]::Matches($output, ">>> .+? FAILED")).Count
            Write-Info2 "  Suites: $passes passed, $fails failed"
            Remove-Item "verify-test-output.txt", "verify-test-stderr.txt" -ErrorAction SilentlyContinue
        } else {
            Write-Err2 "Test suite FAILED (exit $($testResult.ExitCode))"
            Write-Info2 "Output saved to: verify-test-output.txt (in $NewPath)"
            Write-Info2 "Stderr saved to:  verify-test-stderr.txt (in $NewPath)"
            Write-Info2 "Inspect with: Get-Content '$NewPath\verify-test-output.txt'"
        }
    } finally {
        Pop-Location
    }

    Write-Step "MCP Server Identity"
    $pluginJsonPath = Join-Path $NewPath ".zcode-plugin\plugin.json"
    if (Test-Path $pluginJsonPath) {
        try {
            $plugin = Get-Content $pluginJsonPath -Raw | ConvertFrom-Json
            if ($plugin.name -eq "ola") { Write-Ok "Plugin name: ola" }
            else { Write-Err2 "Plugin name is '$($plugin.name)' - expected 'ola'" }
            if ($plugin.mcpServers.PSObject.Properties.Name -contains "ola") { Write-Ok "MCP server key: ola" }
            else { Write-Err2 "MCP server key not 'ola'" }
        } catch {
            Write-Err2 "plugin.json parse error: $_"
        }
    } else {
        Write-Err2 "plugin.json not found: $pluginJsonPath"
    }

    Write-Step "Old-Root Reference Scan"
    $oldRoot = "C:\Next-Era\Moneta"
    $codeFiles = Get-ChildItem $NewPath -Recurse -Include "*.js","*.cjs","*.json","*.sh","*.ps1" -ErrorAction SilentlyContinue | Where-Object { $_.FullName -notmatch "\\.git\\|\\node_modules\\|\\.ouroboros\\|\\.zcode\\" }
    $refs = @()
    foreach ($f in $codeFiles) {
        $content = Get-Content $f.FullName -Raw -ErrorAction SilentlyContinue
        if ($content -and $content.Contains($oldRoot)) { $refs += $f.FullName }
    }
    if ($refs.Count -eq 0) {
        Write-Ok "No old-root references in active code files"
    } else {
        Write-Warn2 "$($refs.Count) file(s) still reference old root:"
        foreach ($r in $refs) { Write-Info2 "  $r" }
    }

    Write-Step "Hook Path Resolution"
    $hooksJson = Join-Path $NewPath "hooks\hooks.json"
    if (Test-Path $hooksJson) {
        Write-Ok "hooks.json exists at new path"
        $hooksContent = Get-Content $hooksJson -Raw
        if ($hooksContent.Contains("ZCODE_PLUGIN_ROOT")) {
            Write-Ok "hooks.json uses ZCODE_PLUGIN_ROOT (resolves to new path automatically)"
        }
    } else {
        Write-Err2 "hooks.json not found at: $hooksJson"
    }

    Write-Step "Hook Failure Check"
    $todayLog = Join-Path $env:USERPROFILE ".zcode\cli\log\zcode-$(Get-Date -Format 'yyyy-MM-dd').jsonl"
    if (Test-Path $todayLog) {
        $logContent = Get-Content $todayLog -Raw -ErrorAction SilentlyContinue
        $failCount = ([regex]::Matches($logContent, '"hook.run.failed"')).Count
        if ($failCount -eq 0) {
            Write-Ok "No hook.run.failed events in today's log"
        } else {
            Write-Warn2 "$failCount hook.run.failed events in today's log (some may be from before relocation)"
        }
    } else {
        Write-Info2 "No log file for today yet - start a ZCode session and re-check"
    }

    Write-Step "Cleanup"
    Write-Info2 "Temporary data roots (safe to delete):"
    Write-Info2 "  $tempData"
    Write-Info2 "  $tempOffload"
    Write-Info2 "These contain only verification test data, not production data."

    Write-Host ""
    Write-Info2 "Remember: Do NOT resume production use against ~/.ola/ before R2."
    Write-Host ""
    exit 0
}
