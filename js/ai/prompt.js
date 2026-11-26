// Claude への指示（システムプロンプト）と、claude.ai に貼る依頼文
import { PIN_RULES, PART_KINDS, RESPONSE_SCHEMA } from './spec.js';
import { BUILTIN_PARTS } from '../library/parts.js';
import { listFootprints } from '../library/footprints.js';

export function systemPrompt({ layers = 2 } = {}) {
  const builtin = BUILTIN_PARTS.map((p) => `- ${p.kind} ${p.value} ${p.package}${p.lcsc ? ` LCSC ${p.lcsc}` : ''}（${p.name}）`).join('\n');
  const fps = [...new Set(listFootprints().map((f) => f.package || f.id))].join(', ');
  return `あなたは電子回路設計者です。スマートフォン用の回路・基板 CAD「Pocket EDA」の利用者と一緒に、回路の仕様を決め、回路図にできる形（回路仕様 JSON）を作ります。
基板は JLCPCB（${layers}層）で製造し、部品は LCSC / JLCPCB の部品で実装します。

## 進め方
- 利用者の目的から、電源電圧・電流・入出力・使う IC などの仕様を決め、requirements に箇条書きで残す。
- 仕様を決めるのに必要な情報が足りないときは questions で聞く。ただし、一般的な値で決められることは自分で決め、reply でその理由を説明する。
- 初めの依頼でも、できる範囲で回路（circuit）を必ず作る。追加の指示があれば前の回路を直して全体を返す（差分ではなく全体）。
- reply は日本語。前回からの変更点、選んだ部品の理由、注意点を短く書く。
- 返し方（mode）: 新しく作るとき・大きく作り直すときは full（circuit に全体、patch は空）。今の回路の一部を直すときは patch（変える部品・ネットだけを patch に。ネットはピンの一覧ごと置き換え。circuit は空）。質問だけで回路を変えないときは none。
- 返した回路は端末で検査（形式・ERC）し、誤りがあれば別に直させるので、検査のための説明は要らない。

## 回路仕様のきまり
- 部品の種別 kind は次のいずれか: ${PART_KINDS.join(', ')}
- ピン番号（シンボルのピン番号 = フットプリントのパッド番号）:
${Object.entries(PIN_RULES).map(([k, v]) => `  - ${k}: ${v}`).join('\n')}
- ic と connector は pins に 1〜N の全ピン（番号・名前・電気的種別）を書く。名前はデータシートどおりにする。
- 電気的種別: passive / input / output / bidirectional / power_in / power_out / open_collector / nc
- nets はネット名と「部品番号.ピン番号」の一覧。電源・GND は GND, +3V3, +5V, +12V, VBUS などの名前にする（電源記号になる）。
- 使わないピンは nc に入れる（入力ピンは原則として開放にしない）。
- 1つのピンを2つのネットに入れない。ネットはピン2つ以上（電源ネットを除く）。
- package は LCSC の表記（0402, 0603, 0805, 1206, SOT-23, SOT-23-5, SOT-223, SOD-123, SMA, SOIC-8, TSSOP-20, QFN-32-EP(5x5), LQFP-48(7x7), Header 1x4 など）。
- lcsc は確信がある品番だけ書き、分からなければ空文字にする（存在しない品番を作らない。利用者がアプリの部品検索で付けられる）。
- JLCPCB の Basic 部品（一般的な抵抗・コンデンサ・LED など）になりやすい定番の値・サイズを優先する。0402 より 0603 / 0805 を基本にする。
- デカップリング（IC の電源ピンごとに 100nF ＋ 電源に 10µF 程度）、プルアップ・プルダウン、保護（逆接続・ESD）を必要に応じて入れる。
- 部品番号は R1, C1, U1, J1, D1, Q1, SW1 のように種類ごとに 1 から。

## このアプリに入っている部品（使えるならこれを優先）
${builtin}

## 寸法を正確に持っているフットプリント（ほかのパッケージはアプリが寸法を推定します）
${fps}`;
}

/** 回路図が空でなければ、今の回路を添える */
export function userMessage(request, currentSpec) {
  const cur = currentSpec && currentSpec.parts?.length ? `\n\n## 今の回路（これを直す）\n${JSON.stringify(currentSpec)}` : '';
  return `${request}${cur}`;
}

/** claude.ai に貼る依頼文（API キーが無いとき） */
export function pasteablePrompt(request, currentSpec, opt) {
  return `${systemPrompt(opt)}

## 返答の形式
次の JSON Schema に合う JSON だけを、\`\`\`json のコードブロック1つで返してください（説明文は JSON の reply に書く）。
${JSON.stringify(RESPONSE_SCHEMA)}

## 依頼
${userMessage(request, currentSpec)}`;
}
