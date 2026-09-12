export type MapPinOrientation = "vertical" | "horizontal";

export type MapPixelSize = Readonly<{
  w: number;
  h: number;
}>;

export type MapPinDisplayGeometryInput = Readonly<{
  naturalSize: MapPixelSize;
  displaySize: MapPixelSize;
  normalizedX: number;
  normalizedY: number;
  pinWidth: number;
  pinHeight: number;
  pinOffsetX: number;
  pinOffsetY: number;
  span: number;
  orientation: MapPinOrientation;
}>;

export type MapPinDisplayGeometry = Readonly<{
  scaleX: number;
  scaleY: number;
  width: number;
  height: number;
  centerX: number;
  centerY: number;
  left: number;
  top: number;
}>;

function normalizeSpaceNumberText(value: string): string {
  return value.replace(/[０-９]/g, (char) =>
    String.fromCharCode(char.charCodeAt(0) - 0xfee0),
  );
}

export function getMapPinSpaceSpan(
  space: string | null | undefined,
): number {
  if (!space) return 1;

  const normalized = normalizeSpaceNumberText(space);
  const target = normalized.includes("-")
    ? normalized.slice(normalized.indexOf("-") + 1)
    : normalized;
  const numbers = target.match(/\d+/g);

  if (!numbers || numbers.length <= 1) return 1;
  return Math.max(1, Math.min(4, numbers.length));
}

export function calculatePinDisplayGeometry(
  input: MapPinDisplayGeometryInput,
): MapPinDisplayGeometry | null {
  const {
    naturalSize,
    displaySize,
    normalizedX,
    normalizedY,
    pinWidth,
    pinHeight,
    pinOffsetX,
    pinOffsetY,
    span,
    orientation,
  } = input;

  const finiteValues = [
    naturalSize.w,
    naturalSize.h,
    displaySize.w,
    displaySize.h,
    normalizedX,
    normalizedY,
    pinWidth,
    pinHeight,
    pinOffsetX,
    pinOffsetY,
    span,
  ];

  if (!finiteValues.every(Number.isFinite)) return null;

  if (
    naturalSize.w <= 0 ||
    naturalSize.h <= 0 ||
    displaySize.w <= 0 ||
    displaySize.h <= 0 ||
    pinWidth <= 0 ||
    pinHeight <= 0
  ) {
    return null;
  }

  const boundedSpan = Math.max(1, Math.min(4, Math.trunc(span)));
  const scaleX = displaySize.w / naturalSize.w;
  const scaleY = displaySize.h / naturalSize.h;

  const width =
    pinWidth * scaleX * (orientation === "horizontal" ? boundedSpan : 1);

  const height =
    pinHeight * scaleY * (orientation === "vertical" ? boundedSpan : 1);

  const centerX = normalizedX * displaySize.w + pinOffsetX * scaleX;
  const centerY = normalizedY * displaySize.h + pinOffsetY * scaleY;

  return {
    scaleX,
    scaleY,
    width,
    height,
    centerX,
    centerY,
    left: centerX - width / 2,
    top: centerY - height / 2,
  };
}

export function isPointInsideMapPinTouchTarget(
  geometry: MapPinDisplayGeometry,
  pointX: number,
  pointY: number,
  minimumTouchSize: number,
): boolean {
  const values = [
    geometry.scaleX,
    geometry.scaleY,
    geometry.width,
    geometry.height,
    geometry.centerX,
    geometry.centerY,
    geometry.left,
    geometry.top,
    pointX,
    pointY,
    minimumTouchSize,
  ];
  if (!values.every(Number.isFinite)) return false;
  if (geometry.width < 0 || geometry.height < 0 || minimumTouchSize < 0) {
    return false;
  }

  const hitWidth = Math.max(geometry.width, minimumTouchSize);
  const hitHeight = Math.max(geometry.height, minimumTouchSize);
  const left = geometry.centerX - hitWidth / 2;
  const top = geometry.centerY - hitHeight / 2;
  const right = left + hitWidth;
  const bottom = top + hitHeight;
  return pointX >= left && pointX <= right && pointY >= top && pointY <= bottom;
}
