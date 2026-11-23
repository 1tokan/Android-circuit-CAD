# Pocket EDA 技術選定と開発ロードマップ

調査日: 2026-11-19

## 1. 外部サービス調査結果

### 1.1 LCSC 公式API

| 項目 | 結果 |
|---|---|
| 公式APIの有無 | **あり**（Category / Manufacturer / Item Details / Keyword Search / Order 系） |
| 利用条件 | LCSCアカウント作成後に申請し、審査・承認を経て key / secret が発行される。主にLCSCのパートナー企業向け |
| 認証 | key + nonce + timestamp + secret による SHA1 署名 |
| ブラウザから直接呼べるか | **不可と判断**。secret をPWA（静的ファイル）に埋め込むと誰でも抜き出せるため、署名には中継サーバーが必要。指示書の「サーバー契約不要」と両立しない |

**結論**: 公式APIは存在するが、サーバーレスの PWA からは安全に使えない。
将来オプションとして「ユーザー自身が取得した key/secret を自分のCloudflare Workers等に置く」コネクタを差し込める設計にとどめ、**標準機能は API に依存しない**。

### 1.2 代替データ源（第3段階で実装）

| 方式 | 内容 | 位置づけ |
|---|---|---|
| ① JSON/CSVインポート | ユーザーが用意した部品表を取り込む | **標準** |
| ② 公開ライブラリの取り込み | JLCPCB Basic/Preferred 部品 CSV（CDFER/jlcpcb-parts-database, MIT, 約3MB, 毎日更新。元データは yaqwsx/jlcparts） | **標準**（ユーザーがファイルを取得→インポート） |
| ③ LCSC商品ページへのリンク | `https://www.lcsc.com/product-detail/<LCSC品番>.html` を開く | **標準** |
| ④ 手動登録 | フォームから部品を登録 | **標準** |
| ⑤ jlcsearch（tscircuit のコミュニティAPI, 認証不要） | 非公式サービス。CORS・継続性は未検証 | **任意**。既定でOFF、使えなくても設計は継続できる |

スクレイピングや LCSC/JLCPCB の非公開APIには依存しない。

### 1.3 JLCPCB BOM / CPL 仕様（第7段階の準拠対象）

- **BOM**: CSV/XLS/XLSX。列 `Comment, Designator, Footprint, LCSC Part #`（同一部品は Designator をカンマ連結して1行）
- **CPL**: CSV。列 `Designator, Mid X, Mid Y, Layer, Rotation`。座標は mm、Layer は Top/Bottom
- Designator は BOM と CPL で完全一致させる
- 回転方向の基準がフットプリントごとにJLC側とずれることがある（KiCad系ツールも補正テーブルを持つ）→ 部品ごとに `jlcRotationOffset` を持たせる
- 第7段階着手時に JLCPCB 公式サンプルBOMを再取得して照合する

## 2. OSS比較（ライセンス・Android・保守性・製造データ精度）

| 候補 | ライセンス | ブラウザ/Android | 用途 | 判断 |
|---|---|---|---|---|
| **tracespace**（@tracespace/parser, plotter, renderer / gerber-to-svg） | MIT | 純JS、ブラウザで動作 | Gerber/Excellon の**独立検証・プレビュー** | **採用**（第6段階）。生成側と別実装なので「独立したGerberビューアでの検証」を満たす。v5系は pre-release のため v4 安定版も比較 |
| KiCad 本体 | GPL-3.0 | C++/デスクトップ | — | 不採用（組込み不可）。ただし**生成Gerberのクロスチェック**にPCで使う |
| KiCad 公式ライブラリ（シンボル/フットプリント） | CC-BY-SA 4.0（生成物への例外条項あり） | データのみ | フットプリント寸法の参照 | 変換して取り込む場合は表示義務を守る。初期部品は IPC-7351 準拠で自作 |
| tscircuit 系（circuit-json, gerber生成等） | MIT | TS/JS | 参考実装 | 依存はせず、データ構造・Gerber出力の比較対象にする |
| CDFER/jlcpcb-parts-database | MIT | CSV | 部品DB | **採用**（インポート元） |
| EasyEDA / LCEDA の部品データ | 利用規約依存 | — | — | 直接取り込みはしない |

### 採用方針

- **独自実装**: データモデル、回路図エディタ、ネットリスト、PCBエディタ、ERC/DRC、Gerber/Excellon生成、BOM/CPL生成
- **既存ライブラリ**: Gerber検証/プレビュー（tracespace）、部品DB（CSV取り込み）
- ビルド工程なし（ES Modules をそのまま配信）。依存ライブラリは `vendor/` に固定版を同梱し、オフラインで動かす

## 3. アーキテクチャ

```
index.html ── js/app.js（起動・UIシェル）
             ├ js/core/      イベントバス / プロジェクトモデル / IndexedDB / 自動保存
             ├ js/modules/   10モジュール（registry に登録、状態 planned/partial/ready を持つ）
             └ js/ui/        画面部品（プロジェクト一覧、キャンバス、ツールバー）
```

- モジュール同士は直接 import せず、**プロジェクトJSON + イベントバス**だけでつながる（疎結合）
- 各モジュールは `status` を持ち、未実装のものは画面上で「未実装」と表示する（完成したように見せない）
- 座標の内部単位: 回路図 = グリッド単位（1 = 0.05inch）、PCB = **nm整数**（浮動小数の丸め誤差を製造データに持ち込まない）
- プロジェクトJSONは `schemaVersion` を持ち、読み込み時にマイグレーション

## 4. ロードマップ

| 段階 | 内容 | 完了条件（検証方法） |
|---|---|---|
| **1** ✅ | PWA基本画面・プロジェクト保存 | IndexedDB保存/復元、自動保存、JSONエクスポート/インポート、オフライン起動、スマホ縦画面表示（Node単体テスト＋Chrome E2E） |
| **2** ✅ | 回路図エディタ | 配置/移動/回転/ミラー/削除/配線/分岐/ネットラベル/電源記号/自動採番/Undo-Redo/複数選択。交差と接続の区別（接続点ドット） |
| **3** ✅ | 部品ライブラリ・ネットリスト | 部品JSONスキーマ、ピン↔パッド対応、CSV/JSONインポート、ネットリスト生成（テストA〜Eの期待ネットと照合） |
| **4** ✅ | PCBエディタ | 外形、配置、配線（45°）、ビア、GNDポリゴン、ラッツネスト（配線済み除外） |
| **5** ✅ | ERC・DRC | ERC 14項目・DRC 18項目。結果に検査した項目・未検査の項目を表示。回路A〜の正常系でエラー0、意図的な誤りを検出（単体＋E2E） |
| **6** ✅ | Gerber・Excellon | RS-274X（X2属性）・Excellon・ZIP、ベタの塗りつぶし。tracespace（pcb-stackup）と pcb-tools（Python）で独立検証（KiCad GerbView は環境に無く未実施） |
| **7** ✅ | BOM・CPL | JLCPCB形式（列は JLCPCB ヘルプの指定どおり）。座標を Gerber と照合、回転は Fabrication Toolkit の補正表と規則に合わせ、部品ごとに手動補正可 |
| **8** 🔶 | Android実機テスト | エミュレータ（Android 11/14/15）で APK の自動試験とテストA〜Eの通しを実施済み。実機での操作性の確認は docs/DEVICE_TEST.md の手順で利用者が実施 |
| **9** ✅ | Claude で回路設計・多層・3D | 回路仕様の JSON 形式（構造化出力のスキーマ）→ 検証 → 自動作図、ERC 0 を単体＋E2E（API はモック）で確認。4・6層の Gerber（.G1〜）を pcb-stackup・pcb-tools で解析。製造仕様（JLCPCB の注文項目）、レジストのブリッジ検査。3D 表示を E2E で描画確認。フットプリント 44 種を KiCad 公式と照合 |
| **10** ✅ | 自動配線・長穴・サンプル | A* と引き直しの自動配線（単体テスト）。長穴（G85）。同梱サンプル「USB DAC アンプ」を全配線・DRC エラー 0 で収録し、単体テストと E2E（画面から開く）で確認 |
| **11** ✅ | 電流と配線幅・部品番号の配置 | IPC-2221 の近似式で必要な幅を求め、DRC（配線幅・ビア）と自動配線に反映（単体テストで式の値と、警告→自動配線で解消を確認）。部品番号の自動配置（単体）。サンプルを見直して全配線・DRC エラー 0・電流の警告なし（単体＋E2E の「電流」画面） |

## 5. 既知のリスク

- AI の回路は定数・ピン番号の誤りがありうる → ERC と利用者のデータシート確認が前提。API は利用者のキーで従量課金
- 照合に使った KiCad フットプリントは GitHub のミラー（2020年版）。その後の KiCad 側の修正は未反映
- 3D 表示の部品は簡易形状（STEP モデルなし）
- 配線幅の検査は IPC-2221 の近似（外層・内層の係数のみ）。ベタの電流容量、部品の定格・発熱は見ていない

- GNDポリゴン（ベタ）のクリアランス付き塗りつぶしは計算が重い → Web Worker で処理
- フットプリント回転基準のJLCとのずれ → 部品ごとの補正値と、CPLプレビューで確認
- iOSは対象外（Android Chrome優先）。ただし標準APIのみ使うので大きな障害はない見込み
