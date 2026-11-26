# Pocket EDA — 作業の決まり（Claude Code 用）

返答は日本語。引継ぎの詳細は利用者の引継書（Claude Doc）と README.md・docs/。守るべきこと: 未実装を完成扱いしない（js/modules/registry.js の status・note を事実どおりに）、形式・座標・接続は検証する、LCSC/EasyEDA をスクレイピングしない、LCSC に無い部品・値は使わない、変更のたびに版を上げて APK を届ける（版は js/app.js・package.json・sw.js の CACHE・tests/e2e-check.mjs の 4 か所）。

## 使うトークンを減らす進め方（品質は落とさない）

1. **大きなファイルを読まない**: samples/usb-dac-amp.json（数 MB）・fp-kicad.js・テストの全出力を文脈に入れない。調べるのは道具で:
   - `node tests/tools/pcb-inspect.mjs drc|near|spoke|png <json> …`（DRC の行・パッドの近く・スポーク・絵）
   - 絵（png）は最後の手段。範囲を切り出して 1 枚だけ見る
2. **試行は一括で、1 行ずつ**: サンプルの配置・配線の値は `node tests/tools/sample-sweep.mjs '{"seed":[…],"H":[…]}'`（値は samples/build/usb-dac-amp.mjs の DEFAULTS。並列・結果は /tmp/sample-sweep）。1 回ずつ手で回さない。良い値が出たら DEFAULTS に入れて `node samples/build/usb-dac-amp.mjs` → `--check`
3. **確かめるのは安い順に 1 回ずつ**: 触ったモジュールの単体テスト（`node --test tests/xxx.test.mjs`）→ `node samples/build/usb-dac-amp.mjs --check` → `npm test`（約 100 秒）→ E2E（`SERVE=route node tests/e2e-xxx.mjs`。ポートを開けない環境は SERVE=route）→ KiCad 照合・ngspice 照合（最後に 1 回）。出力は `| grep -E "^not ok|^# (pass|fail)|^NG|passed"` で絞る
4. **段階でモデルを使い分ける**（サブエージェントは .claude/agents/）:
   - 設計の判断・コードの変更・難しい原因調べ … メイン（Opus）
   - 値の試行・テスト・照合を回して結果を短く返す … `runner`（Haiku）
   - 書いた変更を別の目で確かめる（大きな変更・出荷前）… `reviewer`（Sonnet）
   - 広い検索 … Explore
5. 道具は JavaScript（Node）のまま: アプリと同じコードを動かせば移し替えの誤りが出ない。重いのは自動配線の CPU 時間で、トークンではない

## よく使う

- clone 直後: `npm test` が通ること。kicad-cli・ngspice は `apt-get install -y kicad ngspice`
- KiCad 照合: `LANG=C.UTF-8 LC_ALL=C.UTF-8 node tests/tools/kicad-verify.mjs samples/usb-dac-amp.json /tmp/kv`
- シミュレータの照合: `node tests/tools/sim-ngspice.mjs`
- push 後: CI「Android APK」が apk ブランチに pocket-eda.apk。「Android device test」も確かめる（CDP 切れは `gh run rerun <id> --failed`）
