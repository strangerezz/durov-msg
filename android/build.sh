#!/usr/bin/env bash
# Сборка Android APK (WebView-клиент DUROV MSG).
# Требует: JDK 17+, Android SDK (aapt2, d8, zipalign, apksigner).
set -euo pipefail

ANDROID_HOME="${ANDROID_HOME:-/opt/android-sdk}"
BT="$ANDROID_HOME/build-tools/36.0.0"
PLATFORM="$ANDROID_HOME/platforms/android-34"
A_DIR="$(cd "$(dirname "$0")" && pwd)"
JAVA_HOME="${JAVA_HOME:-$(dirname "$(dirname "$(readlink -f "$(command -v java)")")")}"

rm -rf "$A_DIR/build"
mkdir -p "$A_DIR/build/obj" "$A_DIR/build/gen" "$A_DIR/build/dex" "$A_DIR/build/apk"

"$BT/aapt2" compile --dir "$A_DIR/res" -o "$A_DIR/build/res.zip"
"$BT/aapt2" link \
    -o "$A_DIR/build/apk/base.apk" \
    -I "$PLATFORM/android.jar" \
    --manifest "$A_DIR/AndroidManifest.xml" \
    -R "$A_DIR/build/res.zip" \
    --java "$A_DIR/build/gen" \
    --auto-add-overlay "$A_DIR/build/res.zip"

"$JAVA_HOME/bin/javac" -source 8 -target 8 \
    -bootclasspath "$PLATFORM/android.jar" \
    -classpath "$PLATFORM/android.jar:$A_DIR/build/gen" \
    -d "$A_DIR/build/obj" \
    "$A_DIR/src/com/durovmsg/MainActivity.java"

jar cf "$A_DIR/build/classes.jar" -C "$A_DIR/build/obj" .
"$BT/d8" --release --lib "$PLATFORM/android.jar" --min-api 21 \
    --output "$A_DIR/build/dex" "$A_DIR/build/classes.jar"

cp "$A_DIR/build/apk/base.apk" "$A_DIR/build/apk/unsigned.apk"
python3 - "$A_DIR" <<'PY'
import sys, zipfile, shutil
root = sys.argv[1]
src = f"{root}/build/apk/unsigned.apk"
tmp = f"{root}/build/apk/tmp.apk"
with zipfile.ZipFile(src) as zin, zipfile.ZipFile(tmp, "w") as zout:
    for i in zin.infolist():
        zout.writestr(i, zin.read(i.filename))
    zout.write(f"{root}/build/dex/classes.dex", "classes.dex")
shutil.move(tmp, src)
PY

"$BT/zipalign" -f 4 "$A_DIR/build/apk/unsigned.apk" "$A_DIR/build/apk/aligned.apk"

KS="$A_DIR/durov-release.keystore"
if [ ! -f "$KS" ]; then
    "$JAVA_HOME/bin/keytool" -genkeypair -v -keystore "$KS" -alias durov \
        -keyalg RSA -keysize 2048 -validity 10000 \
        -storepass durov123 -keypass durov123 \
        -dname "CN=DurovMSG, OU=Dev, O=Durov, L=SPb, S=SPb, C=RU"
fi

"$BT/apksigner" sign --ks "$KS" --ks-key-alias durov \
    --ks-pass pass:durov123 --key-pass pass:durov123 \
    --out "$A_DIR/build/apk/durov-msg-0.4.0.apk" "$A_DIR/build/apk/aligned.apk"

"$BT/apksigner" verify "$A_DIR/build/apk/durov-msg-0.4.0.apk"
cp "$A_DIR/build/apk/durov-msg-0.4.0.apk" "$A_DIR/../dist/"
echo "OK: dist/durov-msg-0.4.0.apk"