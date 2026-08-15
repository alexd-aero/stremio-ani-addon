Get-CimInstance Win32_Process -Filter "Name='cmd.exe'"  | Where-Object { $_.CommandLine -like '*run-forever.cmd*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*index.js*' }        | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Write-Host "Ani-CLI addon stopped."
