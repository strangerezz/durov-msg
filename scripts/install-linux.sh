#!/usr/bin/env bash
# Установка DUROV MSG на Linux (AppImage) + иконка + пункт в меню приложений.
# Запуск:  ./install-linux.sh [/путь/к/DUROV.MSG-*.AppImage]
set -euo pipefail

APPID="durov-msg"
APPNAME="DUROV MSG"
PREFIX="${XDG_DATA_HOME:-$HOME/.local}"
BIN_DIR="$PREFIX/bin"
APP_DIR="$PREFIX/share/$APPID"
ICON_DIR="$PREFIX/share/icons/hicolor"
APPS_DIR="$PREFIX/share/applications"

SRC="${1:-}"
if [ -z "$SRC" ]; then
  SRC="$(ls ./dist/DUROV.MSG-*.AppImage 2>/dev/null | head -1 || true)"
fi
if [ -z "$SRC" ] || [ ! -f "$SRC" ]; then
  echo "Ошибка: не найден AppImage."
  echo "Пример:  ./install-linux.sh 'dist/DUROV.MSG-0.6.0.AppImage'"
  exit 1
fi

chmod +x "$SRC"
mkdir -p "$BIN_DIR" "$APP_DIR" \
  "$ICON_DIR/512x512/apps" "$ICON_DIR/256x256/apps" "$ICON_DIR/128x128/apps" \
  "$APPS_DIR"

cp -f "$SRC" "$APP_DIR/durov-msg.AppImage"
ln -sf "$APP_DIR/durov-msg.AppImage" "$BIN_DIR/durov-msg"

# Иконки: берём из репозитория (desktop/) или извлекаем прямо из AppImage
ICON_512="desktop/icon-512.png"
ICON_256="desktop/icon-256.png"
ICON_128="desktop/icon-128.png"
if [ ! -f "$ICON_512" ]; then
  TMP="$(mktemp -d)"
  "$APP_DIR/durov-msg.AppImage" --appimage-extract "desktop/icon-512.png" \
    "desktop/icon-256.png" "desktop/icon-128.png" >/dev/null 2>&1 || true
  ICON_512="$TMP/squashfs-root/desktop/icon-512.png"
  ICON_256="$TMP/squashfs-root/desktop/icon-256.png"
  ICON_128="$TMP/squashfs-root/desktop/icon-128.png"
fi
[ -f "$ICON_512" ] && cp -f "$ICON_512" "$ICON_DIR/512x512/apps/$APPID.png"
[ -f "$ICON_256" ] && cp -f "$ICON_256" "$ICON_DIR/256x256/apps/$APPID.png"
[ -f "$ICON_128" ] && cp -f "$ICON_128" "$ICON_DIR/128x128/apps/$APPID.png"

cat > "$APPS_DIR/$APPID.desktop" <<EOF
[Desktop Entry]
Type=Application
Version=1.0
Name=$APPNAME
GenericName=Messenger
Comment=Анонимный мессенджер с E2E-шифрованием
Exec=$APP_DIR/durov-msg.AppImage
Icon=$APPID
Terminal=false
Categories=Network;InstantMessaging;Chat;
StartupNotify=true
StartupWMClass=DUROV MSG
EOF

chmod +x "$APPS_DIR/$APPID.desktop"

echo ""
echo "Готово. DUROV MSG установлен:"
echo "  Приложение: $APP_DIR/durov-msg.AppImage"
echo "  Ярлык:      $BIN_DIR/durov-msg  (или в меню приложений → DUROV MSG; "
echo "                                   запуск из меню возможен после перезахода в систему)"
echo ""
echo "Запуск:  $BIN_DIR/durov-msg"