// KiCad の S 式ファイル（.kicad_pcb・.kicad_sch・.kicad_sym・.kicad_mod）を書くための小関数

/** 数値を小数 digits 桁までの文字列に（末尾の 0 と −0 を出さない） */
export const numFmt = (digits) => {
  const k = 10 ** digits;
  return (v) => { const r = Math.round(v * k) / k; return Object.is(r, -0) || r === 0 ? '0' : String(r); };
};

/** 文字列を S 式の引用符つきに */
export const q = (s) => `"${String(s ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;

/** 決まった UUID（同じ入力からは同じ値。KiCad は uuid・tstamp を区別にだけ使うので、書き出しが毎回同じになる） */
export function uuidFrom(str) {
  // FNV-1a を種を変えて 4 回 → 128bit
  const h = [0x811c9dc5, 0x01000193, 0x9e3779b9, 0x85ebca6b].map((seed) => {
    let x = seed >>> 0;
    for (let i = 0; i < str.length; i++) { x ^= str.charCodeAt(i); x = Math.imul(x, 0x01000193) >>> 0; }
    return x.toString(16).padStart(8, '0');
  }).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${'89ab'[parseInt(h[16], 16) & 3]}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
