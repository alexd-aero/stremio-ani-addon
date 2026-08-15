# ---------------------------------------------------------------------------
# uninstall-autostart.ps1  —  stop the add-on and remove the login autostart.
#     powershell -ExecutionPolicy Bypass -File .\uninstall-autostart.ps1
# ---------------------------------------------------------------------------
$startup = [Environment]::GetFolderPath('Startup')
Remove-Item "$startup\StremioAniAddon.vbs" -Force -ErrorAction SilentlyContinue

# Stop the keep-alive loop first, then the server (order matters — otherwise
# the loop just relaunches node).
Get-CimInstance Win32_Process -Filter "Name='cmd.exe'"  | Where-Object { $_.CommandLine -like '*run-forever.cmd*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*index.js*' }        | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

Write-Host "Autostart removed and add-on stopped." -ForegroundColor Green
