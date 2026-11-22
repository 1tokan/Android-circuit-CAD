// Claude が返しそうな回答（USB 5V → 3.3V LDO → LED）
export const SAMPLE = {
  reply: 'USB の 5V を AMS1117-3.3 で 3.3V にし、電源表示の LED を付けました。',
  questions: ['3.3V 側で使う最大電流はどのくらいですか？'],
  circuit: {
    title: 'USB 3.3V 電源', summary: 'USB 5V から 3.3V/最大800mA',
    requirements: ['入力: USB 5V', '出力: 3.3V'],
    parts: [
      { ref: 'J1', kind: 'connector', value: 'USB_PWR', package: 'Header 1x4', lcsc: '', mpn: '', description: 'USB 電源入力', pins: [{ num: '1', name: 'VBUS', type: 'power_out' }, { num: '2', name: 'CC1', type: 'passive' }, { num: '3', name: 'CC2', type: 'passive' }, { num: '4', name: 'GND', type: 'power_out' }] },
      { ref: 'U1', kind: 'ic', value: 'AMS1117-3.3', package: 'SOT-223', lcsc: 'C6186', mpn: 'AMS1117-3.3', description: 'LDO', pins: [{ num: '1', name: 'GND', type: 'power_in' }, { num: '2', name: 'VOUT', type: 'power_out' }, { num: '3', name: 'VIN', type: 'power_in' }] },
      { ref: 'C1', kind: 'capacitor', value: '10u', package: '0805', lcsc: '', mpn: '', description: '', pins: [] },
      { ref: 'C2', kind: 'capacitor', value: '10u', package: '0805', lcsc: '', mpn: '', description: '', pins: [] },
      { ref: 'C3', kind: 'capacitor', value: '100n', package: '0603', lcsc: '', mpn: '', description: '', pins: [] },
      { ref: 'R1', kind: 'resistor', value: '1k', package: '0603', lcsc: '', mpn: '', description: '', pins: [] },
      { ref: 'R2', kind: 'resistor', value: '5.1k', package: '0603', lcsc: '', mpn: '', description: 'CC プルダウン', pins: [] },
      { ref: 'R3', kind: 'resistor', value: '5.1k', package: '0603', lcsc: '', mpn: '', description: 'CC プルダウン', pins: [] },
      { ref: 'D1', kind: 'led', value: 'Green', package: '0603', lcsc: '', mpn: '', description: '', pins: [] },
    ],
    nets: [
      { name: 'VBUS', pins: ['J1.1', 'U1.3', 'C1.1'] },
      { name: 'GND', pins: ['J1.4', 'U1.1', 'C1.2', 'C2.2', 'C3.2', 'D1.1', 'R2.2', 'R3.2'] },
      { name: '+3V3', pins: ['U1.2', 'C2.1', 'C3.1', 'R1.1'] },
      { name: 'LED_A', pins: ['R1.2', 'D1.2'] },
      { name: 'CC1', pins: ['J1.2', 'R2.1'] },
      { name: 'CC2', pins: ['J1.3', 'R3.1'] },
    ],
    nc: [], notes: ['LDO の入出力に 10µF を置く'],
  },
};
