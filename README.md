# Pocket EDA

Androidで動く電子回路・PCB設計CAD（PWA）。最終目標は、LCSCの部品で回路図とPCBを設計し、JLCPCBに発注できるGerber・BOM・CPLを生成することです。

**現在: 第1段階（PWAの基本画面とプロジェクト保存）**。回路図・PCBなどの編集機能はまだ実装しておらず、画面上でも「未実装」と表示します。

## 第1段階でできること

- プロジェクトの新規作成・名前変更・複製・削除
- IndexedDBへの保存（自動保存: 操作が止まって1.5秒後、連続操作中でも10秒ごと、アプリ切替時は即時）
- 世代バックアップ（直近10回分）と、そこからの復元
- JSONでの書き出し・読み込み（同じIDなら「上書き」か「コピーとして追加」を選べる。壊れたファイルや新しいバージョンのファイルは読み込まずにエラー表示）
- オフライン起動（Service Worker）、ホーム画面への追加
- スマホ縦画面: 上=主要操作、中央=キャンバス、下=編集ツール／タブレット横画面: 左レール＋右パネル
- キャンバスのパン（1本指）とピンチズーム（2本指）。2本目の指が触れた時点で1本指の操作は破棄する

## 公開（GitHub Pages）

ビルドは不要です。リポジトリにこのフォルダの中身を置き、Settings → Pages で公開するブランチ（ルート）を選びます。
`.nojekyll` も同梱しています。

**更新時は `sw.js` の `CACHE` を書き換えてください**（キャッシュ優先なので、変えないと古い版が表示され続けます）。

## テスト

```bash
node --test tests/unit.test.mjs        # データモデル・自動保存・表示変換（14件）
python3 -m http.server 8765 &          # 別ターミナルでも可
node tests/e2e.mjs                     # Chromeでの実ブラウザテスト（16件）
```

E2EはPlaywrightを使います（`npm i -D playwright`。スクリプト冒頭の import パスと `executablePath` は環境に合わせて変更してください）。

## 構成

```
index.html / manifest.webmanifest / sw.js
css/app.css
js/app.js                 起動・UIシェル。プロジェクト変更は mutateProject() だけを通す
js/core/project.js        データモデル（純粋関数）: 作成・検証・補完・移行・シリアライズ
js/core/storage.js        IndexedDB（projects / backups / kv）
js/core/autosave.js       自動保存
js/core/events.js         モジュール間イベントバス
js/modules/registry.js    10モジュールの登録簿と実装状態（planned / partial / ready）
js/ui/viewport.js         パン・ズーム・ジェスチャー判定
docs/ROADMAP.md           技術選定と開発ロードマップ
```

## データ保存についての注意

データはその端末のブラウザ内に保存されます。Chromeのサイトデータを消すと消えるため、大事なプロジェクトはJSONで書き出してください（起動時に `navigator.storage.persist()` で自動削除されにくくするよう依頼しています）。
