@echo off
REM 启动子服可见窗口（在 pyserver/scripts 下）
REM 双击本文件，或: scripts\start-visible.bat
setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-visible.ps1"
if errorlevel 1 pause
endlocal
