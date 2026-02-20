@echo off
setlocal
cd /d "%~dp0"

echo [1/2] Preparing dependencies...
if not exist node_modules (
  call npm install
  if errorlevel 1 goto :fail
) else (
  echo node_modules already exists. Skipping npm install.
)

echo [2/2] Building installer (npm run dist)...
call npm run dist
if errorlevel 1 goto :fail

echo.
echo Build completed successfully.
echo Output folder: %cd%\dist
exit /b 0

:fail
echo.
echo Build failed.
exit /b 1
