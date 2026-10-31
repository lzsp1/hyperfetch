@echo off
rem ====================================================================
rem  HyperFetch build helper
rem    build.cmd         -> installer + portable exe (release\)
rem    build.cmd pack    -> portable exe only
rem    build.cmd dist    -> installer + portable exe
rem
rem  Uses the portable Node.js bundled in .tools (no system Node needed).
rem ====================================================================
setlocal
set "PATH=%~dp0.tools\node-v22.20.0-win-x64;%PATH%"
set "NODE=%~dp0.tools\node-v22.20.0-win-x64\node.exe"
set "NPM=%~dp0.tools\node-v22.20.0-win-x64\npm.cmd"
set ELECTRON_RUN_AS_NODE=
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
set ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
set ELECTRON_BUILDER_CACHE=%~dp0.tools\eb-cache

cd /d "%~dp0"
set "TARGET=%1"
if "%TARGET%"=="" set "TARGET=dist"
if /i "%TARGET%"=="pack" (set "NPM_TARGET=pack") else (set "NPM_TARGET=dist")

rem Work around electron-builder's macOS-symlink unpack on limited accounts.
"%NODE%" tools\patch-app-builder.js

echo [HyperFetch] 正在打包（%NPM_TARGET%）…
call "%NPM%" run %NPM_TARGET%
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" (
  echo.
  echo [HyperFetch] 打包失败，退出码 %RC%
  pause
  exit /b %RC%
)
echo.
echo [HyperFetch] 完成！输出目录：%~dp0release
if exist "%~dp0release" explorer "%~dp0release"
endlocal
