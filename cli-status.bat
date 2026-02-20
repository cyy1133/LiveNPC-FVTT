@echo off
setlocal

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0cli-control.ps1" status
if errorlevel 1 exit /b 1
exit /b 0
