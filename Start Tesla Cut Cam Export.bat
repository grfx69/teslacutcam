@echo off
title Tesla Cut Cam Export (close this window to stop)
cd /d "%~dp0"
rem Find Python: the py launcher, python on PATH, or a common install folder.
set PY=
where py >nul 2>nul && set PY=py -3
if not defined PY where python >nul 2>nul && set PY=python
if not defined PY for %%P in ("C:\Python314\python.exe" "C:\Python313\python.exe" "C:\Python312\python.exe" "%LocalAppData%\Programs\Python\Python313\python.exe" "%LocalAppData%\Programs\Python\Python312\python.exe") do if not defined PY if exist %%P set PY=%%P
if not defined PY (
  echo.
  echo  Tesla Cut Cam Export needs Python 3 to run its small local web server.
  echo  Install it from https://www.python.org/downloads/  ^(tick "Add python.exe to PATH"^),
  echo  then double-click this file again.
  echo.
  echo  Alternatively open index.html from the "site" folder in Chrome/Edge via any web server.
  echo.
  pause
  exit /b 1
)
set TCC_OPEN=1
rem The helper runs inside this window and only listens on 127.0.0.1.
rem It picks port 8123, or the next free one, and opens your browser. Closing this window stops it.
%PY% "%~dp0teslacutcam-server.py"
if errorlevel 1 pause
