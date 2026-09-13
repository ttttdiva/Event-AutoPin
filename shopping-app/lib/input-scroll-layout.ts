/** 測定済みの画面座標から必要な移動量だけを返す。上へ隠れた入力も戻す。 */
export function inputScrollDelta(viewTop: number, viewHeight: number, keyboardTop: number, inputTop: number, inputHeight: number): number {
  const margin = 12;
  const top = viewTop + margin;
  const bottom = Math.min(viewTop + viewHeight, keyboardTop) - margin;
  if (bottom <= top) return 0;
  if (inputTop < top || inputHeight > bottom - top) return inputTop - top;
  if (inputTop + inputHeight > bottom) return inputTop + inputHeight - bottom;
  return 0;
}
