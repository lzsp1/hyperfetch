@echo off
rem ====================================================================
rem  HyperFetch launcher
rem  Starts the app; uses the portable Node/Electron inside .tools when
rem  a system-wide Electron installation is not available.
rem ====================================================================
setlocal
cd /d "%~dp0"

rem Some toolchains set this; it makes electron.exe behave like plain node.
set ELECTRON_RUN_AS_NODE=

set "ELECTRON_EXE=node_modules\electron\dist\electron.exe"
if exist "%ELECTRON_EXE%" goto run

echo [HyperFetch] Electron 未安装，正在安装依赖...
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
if exist ".tools\node-v22.20.0-win-x64\npm.cmd" (
  call ".tools\node-v22.20.0-win-x64\npm.cmd" install --no-audit --no-fund
) else (
  call npm install --no-audit --no-fund
)
if not exist "%ELECTRON_EXE%" (
  echo [HyperFetch] 安装失败，请检查网络后重试。
  pause
  exit /b 1
)

:run
start "" "%ELECTRON_EXE%" "%~dp0."
endlocal
