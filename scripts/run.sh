#!/usr/bin/env bash
set -e
cd "$(dirname "$0")/.."
echo "==> Запуск DUROV MSG (веб-сервер на http://localhost:9173)"
exec node server/index.js