#!/usr/bin/env bash
# Android アプリ（APK）のビルド。GitHub Actions（ubuntu、Android SDK 入り）で実行する。
# PWA のファイルをそのまま www/ に入れ、Capacitor の WebView で動かす（オフライン動作・サーバー不要）。
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION=$(node -p "require('./package.json').version")
CODE=${BUILD_NUMBER:-1}

rm -rf www android dist && mkdir -p www dist
cp -r index.html manifest.webmanifest sw.js css js icons www/

# Capacitor は package.json の dependencies に書かれたプラグインだけを組み込むので、--save で入れる（CI上のみの変更）
npm i --no-package-lock --no-audit --no-fund \
  @capacitor/core@7 @capacitor/cli@7 @capacitor/android@7 @capacitor/filesystem@7 @capacitor/share@7
npx cap add android
npx cap sync android

# アイコンと背景色
cp -r android-build/res/* android/app/src/main/res/
# バージョン
sed -i -E "s/versionCode [0-9]+/versionCode ${CODE}/; s/versionName \"[^\"]*\"/versionName \"${VERSION}\"/" android/app/build.gradle
# 毎回同じ鍵で署名（上書きインストールできるように）
mkdir -p "$HOME/.android" && cp android-build/debug.keystore "$HOME/.android/debug.keystore"

# 組み込みプラグインの確認（Filesystem と Share が無ければ失敗させる）
grep -q '"@capacitor/filesystem"' android/app/src/main/assets/capacitor.plugins.json
grep -q '"@capacitor/share"' android/app/src/main/assets/capacitor.plugins.json

(cd android && ./gradlew assembleDebug --no-daemon -q)
cp android/app/build/outputs/apk/debug/app-debug.apk "dist/pocket-eda-${VERSION}.apk"
ls -la dist
