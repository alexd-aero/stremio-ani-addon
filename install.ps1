# ===========================================================================
# Ani-CLI Local Streams — one-command Windows installer (for your friends).
#
# A friend just runs this in PowerShell:
#
#   irm https://raw.githubusercontent.com/alexd-aero/stremio-ani-addon/main/install.ps1 | iex
#
# It installs Node.js if missing, downloads the add-on, sets it to auto-start
# at login (hidden, self-restarting), and registers it in their Stremio.
# Everything runs on THEIR PC — their own connection does the scraping.
# ===========================================================================
$ErrorActionPreference = "Stop"
$repo = "alexd-aero/stremio-ani-addon"
$dest = Join-Path $env:LOCALAPPDATA "stremio-ani-addon"

function Have($n) { [bool](Get-Command $n -ErrorAction SilentlyContinue) }
Write-Host "== Ani-CLI Local Streams installer ==" -ForegroundColor Cyan

# --- 1) Node.js -------------------------------------------------------------
if (-not (Have node)) {
  Write-Host "Node.js not found - installing..." -ForegroundColor Yellow
  $ok = $false
  if (Have winget) {
    try {
      winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements --silent | Out-Null
      $env:Path = [Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [Environment]::GetEnvironmentVariable("Path","User")
      $ok = Have node
    } catch { $ok = $false }
  }
  if (-not $ok) {
    Write-Host "  installing portable Node (no admin needed)..." -ForegroundColor DarkGray
    $ver = "v22.17.0"; $nodeDir = Join-Path $dest "node"
    New-Item -ItemType Directory -Force $dest | Out-Null
    $z = Join-Path $env:TEMP "node.zip"
    Invoke-WebRequest "https://nodejs.org/dist/$ver/node-$ver-win-x64.zip" -OutFile $z -UseBasicParsing
    $t = Join-Path $env:TEMP "node-x"; Remove-Item $t -Recurse -Force -ErrorAction SilentlyContinue
    Expand-Archive $z $t -Force
    $inner = Get-ChildItem $t -Directory | Select-Object -First 1
    New-Item -ItemType Directory -Force $nodeDir | Out-Null
    Copy-Item (Join-Path $inner.FullName "*") $nodeDir -Recurse -Force
    $env:Path = "$nodeDir;$env:Path"
    $userPath = [Environment]::GetEnvironmentVariable("Path","User")
    if ($userPath -notlike "*$nodeDir*") { [Environment]::SetEnvironmentVariable("Path", "$nodeDir;$userPath", "User") }
  }
}
Write-Host ("Node: " + (node --version)) -ForegroundColor Green

# --- 2) Stremio (best-effort; it's the app you watch in) --------------------
$hasStremio = $false
try { $hasStremio = [bool](Get-ItemProperty "Registry::HKEY_CLASSES_ROOT\stremio\shell\open\command" -ErrorAction Stop) } catch {}
if (-not $hasStremio -and (Have winget)) {
  Write-Host "Installing Stremio..." -ForegroundColor Yellow
  try { winget install -e --id Stremio.Stremio --accept-source-agreements --accept-package-agreements --silent | Out-Null } catch {
    Write-Host "  (couldn't auto-install Stremio - grab it from https://www.stremio.com)" -ForegroundColor DarkYellow
  }
}

# --- 3) Download the add-on -------------------------------------------------
Write-Host "Downloading add-on..." -ForegroundColor Yellow
$z = Join-Path $env:TEMP "ani-addon.zip"
Invoke-WebRequest "https://codeload.github.com/$repo/zip/refs/heads/main" -OutFile $z -UseBasicParsing
$t = Join-Path $env:TEMP "ani-addon-x"; Remove-Item $t -Recurse -Force -ErrorAction SilentlyContinue
Expand-Archive $z $t -Force
$src = Get-ChildItem $t -Directory | Select-Object -First 1
New-Item -ItemType Directory -Force $dest | Out-Null
Copy-Item (Join-Path $src.FullName "*") $dest -Recurse -Force

# --- 4) Install deps + autostart (setup-autostart.ps1 does the rest) --------
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $dest "setup-autostart.ps1")

# --- 5) Register in Stremio -------------------------------------------------
Start-Sleep -Seconds 2
try { Start-Process "stremio://127.0.0.1:7000/manifest.json" } catch {}
Write-Host ""
Write-Host "Done! In Stremio, click Install on the add-on that pops up." -ForegroundColor Green
Write-Host "  (or paste this into Stremio's add-on search:  http://127.0.0.1:7000/manifest.json )"
Write-Host "Then open any anime, pick an episode, and choose an Ani-CLI stream."
