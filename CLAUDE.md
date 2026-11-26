# Pocket EDA — 作業の決まり（Claude Code 用）

返答は日本語。引継ぎの詳細は利用者の引継書（Claude Doc）と README.md・docs/。守るべきこと: 未実装を完成扱いしない（js/modules/registry.js の status・note を事実どおりに）、形式・座標・接続は検証する、LCSC/EasyEDA をスクレイピングしない、LCSC に無い部品・値は使わない、変更のたびに版を上げて APK を届ける。

## 段階ごとのモデルと言語（品質は落とさず、トークンを減らす）

| 段階 | 担当 | 言語・道具 |
| --- | --- | --- |
| 1. 要望の整理・設計の判断 | メイン（Opus） | 日本語で短く。長い計画書は書かない |
| 2. どこに何があるか調べる | 自分で `grep -n`。広いときだけ Explore | 指示は英語 |
| 3a. 核の実装（計算・配線・形式・状態の扱い・難しい不具合） | メイン（Opus） | JavaScript（ES モジュール、ビルドなし） |
| 3b. 決まった手作業（CSS・文言・設計済みの変更に合わせたテストや docs・同じ置き換えの繰り返し） | `implementer`（Sonnet） | 指示は英語で、ファイル・変える所・確かめ方を具体的に |
| 4. 試験・照合 | `runner`（Haiku）。短い 1 本ならメインで直接 | Node の道具。結果は 1 行ずつ |
| 5. 見直し（大きな変更・出荷前だけ） | `reviewer`（Sonnet） | 英語で 10 件まで |
| 6. 出荷 | メイン | `node tests/tools/bump-version.mjs` → commit・push → `bash tests/tools/ship.sh` |
| 7. 引継書・利用者への報告 | メイン | 日本語。変えた所だけ |

- サブエージェントは起動のたびに文脈を読み直す。**数分で終わる小さな作業はメインで直接やる方が安い**。任せるのは、出力が多い（テスト・ログ・試行）か、長くて機械的な作業だけ
- 内部のやりとり（サブエージェントへの指示・報告・.claude/agents）は英語（同じ内容で日本語より短い）。利用者への返答・UI の文言・docs・コミットの見出しは日本語
- アプリは JavaScript（WebView でそのまま動き、ビルドの待ちと出力が無い）・CSS・HTML。Android 固有は capacitor.config.json と android-build/（build.sh・アイコン）だけで、Kotlin・Java のコードは持たない。CI は YAML とシェル。道具も Node（アプリと同じコードを動かせば移し替えの誤りが出ない）。Rust/WASM は CPU が足りないとき（自動配線）だけ検討し、トークンの節約には効かない

## トークンを減らす作業のしかた

1. **大きなファイルを読まない**: samples/usb-dac-amp.json（数 MB）・fp-kicad.js・テストの全出力を文脈に入れない。調べるのは道具で:
   - `node tests/tools/pcb-inspect.mjs drc|near|spoke|png <json> …`（DRC の行・パッドの近く・スポーク・絵）
   - 絵（png）は最後の手段。範囲を切り出して 1 枚だけ見る。画面の確かめは E2E の screenshot を縮小して 1〜2 枚
2. **試行は一括で、1 行ずつ**: サンプルの配置・配線の値は `node tests/tools/sample-sweep.mjs '{"seed":[…],"H":[…]}'`（値は samples/build/usb-dac-amp.mjs の DEFAULTS。並列・結果は /tmp/sample-sweep）。良い値が出たら DEFAULTS に入れて `node samples/build/usb-dac-amp.mjs` → `--check`
3. **確かめるのは安い順に 1 回ずつ**: 触ったモジュールの単体テスト（`node --test tests/xxx.test.mjs`）→ `node samples/build/usb-dac-amp.mjs --check` → `npm test`（約 100 秒）→ 触った画面の E2E（`SERVE=route node tests/e2e-xxx.mjs`）→ 出荷前に E2E 全部・KiCad 照合・ngspice 照合を 1 回。出力は `| grep -E "^not ok|^# (pass|fail)|^NG|passed"` で絞る
4. 版は `bump-version.mjs` で 4 か所（js/app.js・package.json・sw.js の CACHE・tests/e2e-check.mjs）を 1 度に。ファイルを足したら sw.js の ASSETS も
5. 出荷は `ship.sh` が CI を待ち、実機テストが落ちたら（多くはエミュレータの CDP 切れ）失敗したジョブだけ 1 回再実行し、APK を /home/claude/pocket-eda-<版>.apk に取る（出力は数行）

## よく使う

- clone 直後: `npm test` が通ること。kicad-cli・ngspice は `apt-get install -y kicad ngspice`
- KiCad 照合: `LANG=C.UTF-8 LC_ALL=C.UTF-8 node tests/tools/kicad-verify.mjs samples/usb-dac-amp.json /tmp/kv`
- シミュレータの照合: `node tests/tools/sim-ngspice.mjs`
