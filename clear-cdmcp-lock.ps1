# clear-cdmcp-lock.ps1
# Kills any chrome-devtools-mcp browser instance(s) holding the profile lock and
# verifies the lockfile is released. Safe: only touches chrome.exe processes whose
# command line references 'chrome-devtools-mcp' (the MCP-managed browser), never
# your regular Chrome. Leaves children to be torn down by their root automatically.
#
# Usage:  powershell -ExecutionPolicy Bypass -File C:\Next-Era\Ola\clear-cdmcp-lock.ps1
#         (or just:  powershell -File clear-cdmcp-lock.ps1  from this directory)

$ErrorActionPreference = "Stop"

$lockfile = "$env:USERPROFILE\.cache\chrome-devtools-mcp\chrome-profile\lockfile"

# Find root chrome-devtools-mcp browser process(es): chrome.exe whose cmdline
# references chrome-devtools-mcp and is NOT a child --type=* process.
$procs = Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" |
    Where-Object { $_.CommandLine -like '*chrome-devtools-mcp*' -and $_.CommandLine -notlike '*--type=*' }

if (-not $procs) {
    Write-Host "No chrome-devtools-mcp browser process running."
} else {
    foreach ($p in $procs) {
        Write-Host "Terminating chrome-devtools-mcp root PID $($p.ProcessId) (started $($p.CreationDate))..."
        Stop-Process -Id $p.ProcessId -Force
    }
    Start-Sleep -Seconds 2
}

# Verify
$remain = (Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" |
    Where-Object { $_.CommandLine -like '*chrome-devtools-mcp*' } | Measure-Object).Count
Write-Host ""
Write-Host "chrome-devtools-mcp processes remaining: $remain  (want 0)"
if (Test-Path $lockfile) {
    Remove-Item $lockfile -Force -ErrorAction SilentlyContinue
    if (Test-Path $lockfile) {
        Write-Host "lockfile: STILL PRESENT at $lockfile"
    } else {
        Write-Host "lockfile: gone"
    }
} else {
    Write-Host "lockfile: gone"
}
$reg = (Get-Process chrome -ErrorAction SilentlyContinue | Measure-Object).Count
Write-Host "regular Chrome processes (untouched): $reg"
if ($remain -eq 0) { Write-Host "OK - profile lock cleared" } else { Write-Host "WARNING - processes remain"; exit 1 }
