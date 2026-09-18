@echo off
cd /d "%~dp0\.."

echo ==> Устанавливаю зависимости (electron, electron-builder)...
call npm install --include=dev

echo ==> Генерирую иконки...
node desktop\gen-icon.js

echo ==> Собираю portable .exe для Windows...
call npx electron-builder --win portable

echo.
echo ==> Готово! В папке dist: DUROV MSG portable
dir dist\*.exe