@echo off
setlocal
cd /d "%~dp0"

if not exist "node_modules" (
  echo 初回起動のため依存パッケージをインストールします...
  call npm install
)

echo Dice Showdown サーバーを起動しています...
start "Dice Showdown Server" cmd /k "npm start"
timeout /t 2 /nobreak >nul
start "" http://localhost:3000
