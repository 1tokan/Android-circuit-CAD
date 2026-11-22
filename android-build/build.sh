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
# 毎回同じ鍵で署名（上書きインストールできるように）。
# ~/.android/debug.keystore はビルド環境によって読まれないことがあったので、build.gradle で鍵を明示する
KS="$(pwd)/android-build/debug.keystore"
python3 - "$KS" <<'PY'
import re, sys
ks = sys.argv[1]
p = 'android/app/build.gradle'
s = open(p).read()
cfg = f'''
    signingConfigs {{
        pocketeda {{
            storeFile file("{ks}")
            storePassword "android"
            keyAlias "androiddebugkey"
            keyPassword "android"
        }}
    }}
'''
s, n = re.subn(r'^android \{\n', 'android {\n' + cfg, s, count=1, flags=re.M)
assert n == 1, 'build.gradle に android { が見つかりません'
# リリース版（デバッグ機能なし）を同じ鍵で署名する
s, n = re.subn(r'(buildTypes \{\s*\n\s*release \{\n)', r'\1            signingConfig signingConfigs.pocketeda\n', s, count=1)
assert n == 1, 'build.gradle に buildTypes { release { が見つかりません'
open(p, 'w').write(s)
PY

# 組み込みプラグインの確認（Filesystem と Share が無ければ失敗させる）
grep -q '"@capacitor/filesystem"' android/app/src/main/assets/capacitor.plugins.json
grep -q '"@capacitor/share"' android/app/src/main/assets/capacitor.plugins.json

# リリース版（debuggable=false）。デバッグ版は Play プロテクトの確認で警告されやすい
(cd android && ./gradlew assembleRelease --no-daemon -q)
cp android/app/build/outputs/apk/release/app-release.apk "dist/pocket-eda-${VERSION}.apk"

# 署名の確認: リポジトリの鍵で署名されていなければ失敗させる（別の鍵だとスマホで上書き更新できない）
EXPECTED=$(keytool -list -v -keystore "$KS" -storepass android -alias androiddebugkey 2>/dev/null | grep 'SHA256:' | head -1 | sed 's/.*SHA256: //' | tr -d ':' | tr 'A-F' 'a-f')
APKSIGNER=$(ls -d "$ANDROID_HOME"/build-tools/*/apksigner | sort -V | tail -1)
ACTUAL=$("$APKSIGNER" verify --print-certs "dist/pocket-eda-${VERSION}.apk" | grep 'SHA-256 digest' | head -1 | sed 's/.*: //')
echo "expected cert: $EXPECTED"
echo "actual cert:   $ACTUAL"
[ -n "$EXPECTED" ] && [ "$EXPECTED" = "$ACTUAL" ] || { echo '署名鍵が一致しません'; exit 1; }
# デバッグ版になっていないことの確認
AAPT=$(ls -d "$ANDROID_HOME"/build-tools/*/aapt2 | sort -V | tail -1)
if "$AAPT" dump xmltree --file AndroidManifest.xml "dist/pocket-eda-${VERSION}.apk" | grep -q 'debuggable.*=true'; then echo 'debuggable=true になっています'; exit 1; fi
ls -la dist
