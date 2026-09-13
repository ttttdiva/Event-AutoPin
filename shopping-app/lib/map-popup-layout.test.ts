import { placeMapPopup } from './map-popup-layout';
import { calculateFocalPinchTransform } from './map-viewport-transform';

function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }

export function runMapPopupLayoutTests() {
  const pin = { left: 180, top: 240, width: 20, height: 36 };
  let checks = 0;
  for (const width of [240, 393, 768]) for (const height of [240, 640, 852]) {
    for (const scale of [0.5, 1, 2, 3.5, 5]) for (const x of [0, width / 2, width - 10]) for (const y of [0, height / 2, height - 10]) {
      const viewport = { width, height };
      const popup = { width: 220, height: height > 240 ? 145 : 60 };
      const tx = x - pin.left * scale, ty = y - pin.top * scale;
      const position = placeMapPopup(pin, scale, tx, ty, viewport, popup);
      assert(position.visible, '画面端でも選択ピンが見えていれば表示すること');
      assert(position.left >= 8 && position.left + popup.width <= width - 8, 'ポップアップが左右にはみ出さないこと');
      assert(position.top >= 8 && position.top + popup.height <= height - 8, 'ポップアップが上下にはみ出さないこと');
      const covered = position.left <= Math.max(0, x) && position.top <= Math.max(0, y) &&
        position.left + popup.width >= Math.min(width, x + pin.width * scale) &&
        position.top + popup.height >= Math.min(height, y + pin.height * scale);
      assert(!covered, '選択マスの可視部分を完全に覆わないこと');
      checks++;
    }
  }
  const viewport = { width: 393, height: 640 }, popup = { width: 220, height: 70 };
  const before = placeMapPopup(pin, 1, 0, 0, viewport, popup);
  const panned = placeMapPopup(pin, 1, 20, 40, viewport, popup);
  assert(panned.top === before.top + 40 && panned.left === before.left + 20, 'パンに同じフレームの移動量で追従すること');
  const zoom = calculateFocalPinchTransform({ startScale: 1, startTranslateX: 0, startTranslateY: 0,
    startFocalX: 190, startFocalY: 258, currentFocalX: 190, currentFocalY: 258, gestureScale: 2, minScale: 0.5, maxScale: 5 });
  const zoomed = placeMapPopup(pin, zoom.scale, zoom.translateX, zoom.translateY, viewport, popup);
  assert(zoomed.left === before.left && zoomed.top === before.top - 18, 'ピン中心のズームでは拡大したマス端から同じ距離を保つこと');
  assert(!placeMapPopup(pin, 2, -2000, 0, viewport, popup).visible, '選択ピンが画面外なら古いポップアップを残さないこと');
  console.log(`ポップアップ配置 ${checks}条件とズーム・パンを検証しました`);
}
