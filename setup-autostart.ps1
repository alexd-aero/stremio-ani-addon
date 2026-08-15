# ---------------------------------------------------------------------------
# setup-autostart.ps1  —  make the add-on start at every login (hidden) and
# restart itself if it ever crashes.  No admin required.
#
# Run once, from this folder:
#     powershell -ExecutionPolicy Bypass -File .\setup-autostart.ps1
# ---------------------------------------------------------------------------
$ErrorActionPreference = "Stop"

$dir  = $PSScriptRoot
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) {
  Write-Host "ERROR: Node.js was not found on PATH. Install it from https://nodejs.org and re-run." -ForegroundColor Red
  exit 1
}

# Make sure dependencies are installed.
if (-not (Test-Path "$dir\node_modules")) {
  Write-Host "Installing dependencies (npm install)..." -ForegroundColor Cyan
  Push-Location $dir; npm install --no-audit --no-fund; Pop-Location
}

# 1) Keep-alive loop: run node, restart it 3s after any exit/crash. Logs to server.log.
@"
@echo off
cd /d "$dir"
:loop
"$node" index.js >> "$dir\server.log" 2>&1
timeout /t 3 /nobreak >nul
goto loop
"@ | Set-Content -Path "$dir\run-forever.cmd" -Encoding ASCII

# 2) Hidden launcher (0 = no window), returns immediately.
@"
CreateObject("WScript.Shell").Run "cmd /c ""$dir\run-forever.cmd""", 0, False
"@ | Set-Content -Path "$dir\start-hidden.vbs" -Encoding ASCII

# 3) Register in the per-user Startup folder (runs at every login, no admin).
$startup = [Environment]::GetFolderPath('Startup')
Copy-Item "$dir\start-hidden.vbs" "$startup\StremioAniAddon.vbs" -Force

# 4) Start it right now (don't wait for a re-login).
Start-Process wscript.exe -ArgumentList ('"' + "$dir\start-hidden.vbs" + '"')
Start-Sleep -Seconds 6

# 5) Verify.
try {
  $m = Invoke-RestMethod "http://127.0.0.1:7000/manifest.json" -TimeoutSec 8
  Write-Host ""
  Write-Host ("OK - " + $m.name + " v" + $m.version + " is running and will auto-start at login.") -ForegroundColor Green
  Write-Host "Install it in Stremio by pasting this into the add-on search bar:" -ForegroundColor Green
  Write-Host "    http://127.0.0.1:7000/manifest.json"
} catch {
  Write-Host "Started, but the server did not answer yet. Check server.log in this folder." -ForegroundColor Yellow
}
