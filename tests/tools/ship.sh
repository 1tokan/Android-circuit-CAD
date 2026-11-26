#!/usr/bin/env bash
# push のあと: CI（Android APK・Android device test）を待ち、実機テストが落ちたら 1 回だけ再実行し、
# APK を /home/claude/pocket-eda-<版>.apk に取ってくる。出力は数行だけ（トークンを使わないため）
# 使い方: bash tests/tools/ship.sh   （push したあと、リポジトリの中で。gh が使えること）
# 終了コード: 0 = 両方通った、1 = APK が無い・push していない・待ちきれない、2 = 実機テストが再実行でも落ちた
set -u
cd "$(git rev-parse --show-toplevel)"
SHA=$(git rev-parse HEAD)
VER=$(node -p "require('./package.json').version")
git fetch -q origin 2>/dev/null
if ! git branch -r --contains "$SHA" 2>/dev/null | grep -q "origin/"; then echo "HEAD（${SHA:0:7}）がまだ push されていません"; exit 1; fi
NAMES='["Android APK","Android device test"]'
runs() {
  gh run list --limit 20 --json name,status,conclusion,databaseId,headSha,attempt \
    --jq "[.[]|select(.headSha==\"$SHA\")|select(.name as \$n|$NAMES|index(\$n))]"
}
# 2 つとも登録され、どちらも終わるまで待つ（最大 30 分）
wait_runs() {
  for _ in $(seq 1 90); do
    J=$(runs)
    N=$(echo "$J" | jq 'map(.name)|unique|length')
    BUSY=$(echo "$J" | jq '[.[]|select(.status!="completed")]|length')
    if [ "$N" = 2 ] && [ "$BUSY" = 0 ]; then return 0; fi
    sleep 20
  done
  return 1
}
show() { echo "$J" | jq -r 'map("\(.name)=\(.conclusion) (#\(.databaseId) 試行\(.attempt))")|join("  ")'; }
wait_runs || { echo "CI を待ちきれませんでした: $(show)"; exit 1; }
DEV=$(echo "$J" | jq -r '.[]|select(.name=="Android device test")|"\(.databaseId) \(.conclusion) \(.attempt)"' | head -1)
read -r ID CONC ATT <<<"$DEV"
if [ "$CONC" != "success" ]; then
  echo "実機テスト: $CONC → 失敗したジョブだけ 1 回再実行 (#$ID)"
  gh run view "$ID" --log-failed 2>/dev/null | grep -E "Z NG |[0-9]+/[0-9]+ passed" | sed "s/.*Z //" | cut -c1-160 | head -4
  gh run rerun "$ID" --failed >/dev/null
  # 再実行が登録される（試行の番号が上がる）まで待ってから、終わるのを待つ
  for _ in $(seq 1 30); do
    A=$(gh run view "$ID" --json attempt --jq .attempt 2>/dev/null)
    [ "${A:-0}" -gt "$ATT" ] && break
    sleep 10
  done
  wait_runs || { echo "再実行を待ちきれませんでした: $(show)"; exit 1; }
fi
echo "CI: $(show)"
echo "$J" | jq -e '.[]|select(.name=="Android APK" and .conclusion=="success")' >/dev/null || { echo "APK のビルドが通っていません"; exit 1; }
TMP=$(mktemp -d)
git clone -q --depth 1 -b apk "$(git remote get-url origin)" "$TMP/apk"
grep -E "version|build|commit" "$TMP/apk/README.md" | tr '\n' ' '; echo
grep -q "$SHA" "$TMP/apk/README.md" || echo "注意: apk ブランチの APK は HEAD の版ではありません"
cp "$TMP/apk/pocket-eda.apk" "/home/claude/pocket-eda-$VER.apk" && echo "APK: /home/claude/pocket-eda-$VER.apk"
echo "$J" | jq -e '.[]|select(.name=="Android device test" and .conclusion=="success")' >/dev/null || { echo "実機テストが再実行でも通っていません"; exit 2; }
