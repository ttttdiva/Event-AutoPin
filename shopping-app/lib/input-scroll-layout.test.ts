import { inputScrollDelta } from './input-scroll-layout';
export function runInputScrollLayoutTests() {
  const equal = (actual: number, expected: number) => { if (actual !== expected) throw new Error(`入力スクロール: ${actual} != ${expected}`); };
  equal(inputScrollDelta(1015, 281, 1430, 600, 100), -427);
  equal(inputScrollDelta(1015, 281, 1430, 1027, 100), 0);
  equal(inputScrollDelta(450, 1600, 1430, 1800, 100), 482);
  equal(inputScrollDelta(450, 500, Infinity, 940, 100), 102);
  equal(inputScrollDelta(450, 500, 1430, 500, 100), 0);
  equal(inputScrollDelta(450, 200, 1430, 600, 300), 138);
  console.log('入力欄の上側への隠れ・IME重なり・モーダル境界を検証しました');
}
