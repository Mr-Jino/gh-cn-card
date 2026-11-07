@echo off
setlocal
set "SRC=%~dp0extension"
set "DST=%LocalAppData%\GhCnCardExt"
if not exist "%SRC%" (
  echo [X] "extension" folder not found next to this script.
  pause
  exit /b 1
)
robocopy "%SRC%" "%DST%" /MIR /NFL /NDL /NJH /NJS >nul
if errorlevel 8 (
  echo [X] copy failed.
  pause
  exit /b 1
)
set "EXTDIR=%DST%"
powershell -NoProfile -Command "Set-Clipboard -Value $env:EXTDIR"
start "" explorer "%DST%"
start "" "%~dp0install-help.html"
endlocal
