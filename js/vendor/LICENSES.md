# 同梱しているサードパーティのコード

| ファイル | 元 | ライセンス |
|---|---|---|
| polygon-clipping.js | [polygon-clipping](https://github.com/mfogel/polygon-clipping) 0.15.7（Mike Fogel）に、依存する [splaytree](https://github.com/w8r/splay-tree) 3.2.4（Alexander Milevski）と [robust-predicates](https://github.com/mourner/robust-predicates)（Vladimir Agafonkin）を esbuild で1ファイルにまとめたもの。改変なし | MIT / MIT / Unlicense |
| hershey-simplex.js | [hersheytext](https://github.com/techninja/hersheytext) 2.0.0 の futural フォントデータを配列に変換したもの。元データは A. V. Hershey のフォント | MIT（Copyright (c) 2014 James T）／元フォントはパブリックドメイン |

MIT License の全文:

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## 参考にしたデータ（コードは同梱していません）

| 使用箇所 | 元 | ライセンス |
|---|---|---|
| js/output/assembly.js の JLC_ROTATION_DB（パッケージごとの CPL 回転補正の値） | [JLCPCB Fabrication Toolkit](https://github.com/bennymeg/Fabrication-Toolkit)（Benny Megidish）の transformations.csv | Apache License 2.0 |

## フットプリントの寸法データ

| ファイル | 元 | ライセンス |
|---|---|---|
| js/library/fp-kicad.js（パッド・外形枠・本体の寸法） | [KiCad 公式フットプリントライブラリ](https://github.com/KiCad/kicad-footprints)（GitHub ミラー）から tests/tools/kicad-import.mjs で抜き出したもの | CC-BY-SA 4.0（KiCad ライブラリの例外条項つき: このデータを使った設計・製造データには適用されない） |

## 3D 表示

| ファイル | 元 | ライセンス |
|---|---|---|
| three.js | [three.js](https://github.com/mrdoob/three.js) r187 の必要な部分と OrbitControls を esbuild で1ファイルにまとめたもの。改変なし | MIT（Copyright © 2010-2026 three.js authors） |
