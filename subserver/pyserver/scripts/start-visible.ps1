# 弹出可见 PowerShell 窗口启动 pyserver
#   powershell -ExecutionPolicy Bypass -File subserver/pyserver/scripts/start-visible.ps1

$ErrorActionPreference = "Stop"
$pyserver = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
if (-not (Test-Path (Join-Path $pyserver "main.py"))) {
  Write-Error "pyserver not found: $pyserver"
}

if (Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue) {
  Write-Host "WARN: port 8000 busy" -ForegroundColor Yellow
}

$cmd = @"
`$Host.UI.RawUI.WindowTitle = 'XRK-AGT pyserver'
Set-Location '$pyserver'
`$env:PYTHONUTF8 = '1'
`$env:PYTHONIOENCODING = 'utf-8'
Write-Host "cwd: $pyserver" -ForegroundColor DarkGray
Write-Host 'start: uv run python main.py' -ForegroundColor Cyan
Write-Host 'health: http://127.0.0.1:8000/health' -ForegroundColor DarkGray
uv run python main.py
"@

Start-Process powershell -WorkingDirectory $pyserver -ArgumentList @(
  '-NoExit', '-ExecutionPolicy', 'Bypass', '-Command', $cmd
)
Write-Host "Opened XRK-AGT pyserver window" -ForegroundColor Green
