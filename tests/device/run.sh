#!/usr/bin/env bash
# Android エミュレータ（または USB 接続の実機）で APK を動かして試験する。
# 使い方: bash tests/device/run.sh dist/pocket-eda-X.Y.Z-devtest.apk
#   （WebView のデバッグ接続を許可した試験用 APK が必要: WEBVIEW_DEBUG=1 bash android-build/build.sh）
set -uo pipefail
APK=${1:?APK を指定してください}
OUT=tests/device/out
PKG=jp.tokan.pocketeda
mkdir -p "$OUT"
adb wait-for-device
adb shell getprop ro.build.version.release > "$OUT/android-version.txt"
adb shell dumpsys package com.google.android.webview | grep -m1 versionName > "$OUT/webview-version.txt" || true
adb uninstall "$PKG" >/dev/null 2>&1 || true
adb install -r "$APK" || exit 1
adb logcat -c
adb shell am start -W -n "$PKG/.MainActivity" | tee "$OUT/start.txt"
# WebView のデバッグ用ソケットを探して転送
for i in $(seq 1 60); do
  SOCK=$(adb shell cat /proc/net/unix | grep -o 'webview_devtools_remote_[0-9]*' | head -1)
  [ -n "$SOCK" ] && break
  sleep 1
done
[ -n "$SOCK" ] || { echo 'WebView のデバッグ用ソケットが見つかりません'; adb logcat -d > "$OUT/logcat.txt"; exit 1; }
adb forward tcp:9222 "localabstract:$SOCK"
node tests/device/cdp-test.mjs
STATUS=$?
adb exec-out screencap -p > "$OUT/final-screen.png" || true
adb logcat -d > "$OUT/logcat.txt"
grep -E 'Capacitor/Console|chromium' "$OUT/logcat.txt" | grep -iE 'error|uncaught' > "$OUT/logcat-errors.txt" || true
exit $STATUS
