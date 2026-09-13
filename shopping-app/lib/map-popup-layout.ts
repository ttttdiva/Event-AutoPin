export interface PopupRect { left: number; top: number; width: number; height: number }

/** 地図と同じ変換を画面座標へ適用し、マスと重ならない候補を優先する。 */
export function placeMapPopup(
  pin: PopupRect, scale: number, translateX: number, translateY: number,
  viewport: { width: number; height: number }, popup: { width: number; height: number },
): { left: number; top: number; visible: boolean } {
  'worklet';
  const margin = 8;
  const gap = 12;
  const left = pin.left * scale + translateX;
  const top = pin.top * scale + translateY;
  const right = left + pin.width * scale;
  const bottom = top + pin.height * scale;
  const visible = right > 0 && bottom > 0 && left < viewport.width && top < viewport.height;
  const centerX = (left + right) / 2;
  const centerY = (top + bottom) / 2;
  const candidates = [
    { left: centerX - popup.width / 2, top: top - gap - popup.height },
    { left: centerX - popup.width / 2, top: bottom + gap },
    { left: right + gap, top: centerY - popup.height / 2 },
    { left: left - gap - popup.width, top: centerY - popup.height / 2 },
  ];
  let best = { left: margin, top: margin };
  let bestScore = Infinity;
  for (const candidate of candidates) {
    const x = Math.max(margin, Math.min(Math.max(margin, viewport.width - popup.width - margin), candidate.left));
    const y = Math.max(margin, Math.min(Math.max(margin, viewport.height - popup.height - margin), candidate.top));
    const overlap = Math.max(0, Math.min(x + popup.width, right) - Math.max(x, left)) *
      Math.max(0, Math.min(y + popup.height, bottom) - Math.max(y, top));
    const score = overlap * 10000 + Math.abs(x - candidate.left) + Math.abs(y - candidate.top);
    if (score < bestScore) { bestScore = score; best = { left: x, top: y }; }
  }
  return { ...best, visible };
}
