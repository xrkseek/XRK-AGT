@echo off
chcp 65001 >nul 2>&1
REM XRK-AGT Windows 启动（先确保本机 Redis 可连，再经 app.js 引导）
set "ENSURE=%~dp0scripts\ensure-redis.mjs"
if not exist "%ENSURE%" (
  echo [XRK-AGT] missing scripts\ensure-redis.mjs
  pause
  exit /b 1
)
where node >nul 2>&1
if errorlevel 1 (
  echo [XRK-AGT] node not found in PATH
  pause
  exit /b 1
)
node "%ENSURE%"
if errorlevel 1 (
  echo [XRK-AGT] Redis 未就绪，已中止启动
  pause
  exit /b 1
)
node --experimental-strip-types app.js %*
if errorlevel 1 pause
