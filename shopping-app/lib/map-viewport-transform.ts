export type MapViewportPoint = Readonly<{
  x: number;
  y: number;
}>;

export type MapViewportTransform = Readonly<{
  scale: number;
  translateX: number;
  translateY: number;
}>;

export type FocalPinchTransformInput = Readonly<{
  startScale: number;
  startTranslateX: number;
  startTranslateY: number;
  startFocalX: number;
  startFocalY: number;
  currentFocalX: number;
  currentFocalY: number;
  gestureScale: number;
  minScale: number;
  maxScale: number;
}>;

export function calculateFocalPinchTransform(
  input: FocalPinchTransformInput,
): MapViewportTransform {
  "worklet";
  const nextScale = Math.min(
    input.maxScale,
    Math.max(input.minScale, input.startScale * input.gestureScale),
  );
  const anchorMapX =
    (input.startFocalX - input.startTranslateX) / input.startScale;
  const anchorMapY =
    (input.startFocalY - input.startTranslateY) / input.startScale;
  return {
    scale: nextScale,
    translateX: input.currentFocalX - anchorMapX * nextScale,
    translateY: input.currentFocalY - anchorMapY * nextScale,
  };
}

export function viewportPointToMapPoint(
  point: MapViewportPoint,
  transform: MapViewportTransform,
): MapViewportPoint | null {
  "worklet";
  const { x, y } = point;
  const { scale, translateX, translateY } = transform;
  if (![x, y, scale, translateX, translateY].every(Number.isFinite)) {
    return null;
  }
  if (scale <= 0) return null;
  return {
    x: (x - translateX) / scale,
    y: (y - translateY) / scale,
  };
}
