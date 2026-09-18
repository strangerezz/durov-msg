#!/usr/bin/env bash
set -e
cd "$(dirname "$0")/.."

echo "==> Установка зависимостей (electron, electron-builder)..."
npm install --include=dev

echo "==> Генерация иконок..."
node desktop/gen-icon.js

echo "==> Сборка AppImage для Linux..."
npx electron-builder --linux AppImage

echo ""
echo "✅ Готово! AppImage в каталоге ./dist"
ls -lh dist/*.AppImage 2>/dev/null || true