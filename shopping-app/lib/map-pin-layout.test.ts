import {
  calculatePinDisplayGeometry,
  getMapPinSpaceSpan,
  isPointInsideMapPinTouchTarget,
} from "./map-pin-layout";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertClose(
  actual: number,
  expected: number,
  message: string,
): void {
  const epsilon = 1e-9;
  if (Math.abs(actual - expected) > epsilon) {
    throw new Error(
      `${message}: expected=${expected}, actual=${actual}`,
    );
  }
}

export function runMapPinLayoutTests(): void {
  assert(
    getMapPinSpaceSpan("A-11") === 1,
    "single space should use span 1",
  );
  assert(
    getMapPinSpaceSpan("A-11,12") === 2,
    "two spaces should use span 2",
  );
  assert(
    getMapPinSpaceSpan("A-１１,１２,１３") === 3,
    "full-width numbers should be normalized",
  );

  const base = calculatePinDisplayGeometry({
    naturalSize: { w: 2400, h: 3400 },
    displaySize: { w: 600, h: 850 },
    normalizedX: 0.5,
    normalizedY: 0.4,
    pinWidth: 77,
    pinHeight: 24,
    pinOffsetX: 8,
    pinOffsetY: -4,
    span: 1,
    orientation: "vertical",
  });

  assert(base !== null, "base geometry should be valid");

  assertClose(base.scaleX, 0.25, "scaleX");
  assertClose(base.scaleY, 0.25, "scaleY");
  assertClose(base.width, 19.25, "scaled pin width");
  assertClose(base.height, 6, "scaled pin height");
  assertClose(base.centerX, 302, "scaled centerX with offset");
  assertClose(base.centerY, 339, "scaled centerY with offset");
  assertClose(base.left, 292.375, "scaled left");
  assertClose(base.top, 336, "scaled top");

  const verticalSpan = calculatePinDisplayGeometry({
    naturalSize: { w: 2400, h: 3400 },
    displaySize: { w: 600, h: 850 },
    normalizedX: 0.5,
    normalizedY: 0.4,
    pinWidth: 77,
    pinHeight: 24,
    pinOffsetX: 0,
    pinOffsetY: 0,
    span: 2,
    orientation: "vertical",
  });

  assert(verticalSpan !== null, "vertical span geometry should be valid");
  assertClose(verticalSpan.width, 19.25, "vertical span width");
  assertClose(verticalSpan.height, 12, "vertical span height");

  const horizontalSpan = calculatePinDisplayGeometry({
    naturalSize: { w: 2400, h: 3400 },
    displaySize: { w: 600, h: 850 },
    normalizedX: 0.5,
    normalizedY: 0.4,
    pinWidth: 77,
    pinHeight: 24,
    pinOffsetX: 0,
    pinOffsetY: 0,
    span: 3,
    orientation: "horizontal",
  });

  assert(horizontalSpan !== null, "horizontal span geometry should be valid");
  assertClose(horizontalSpan.width, 57.75, "horizontal span width");
  assertClose(horizontalSpan.height, 6, "horizontal span height");

  const doubledViewport = calculatePinDisplayGeometry({
    naturalSize: { w: 2400, h: 3400 },
    displaySize: { w: 1200, h: 1700 },
    normalizedX: 0.5,
    normalizedY: 0.4,
    pinWidth: 77,
    pinHeight: 24,
    pinOffsetX: 8,
    pinOffsetY: -4,
    span: 1,
    orientation: "vertical",
  });

  assert(
    doubledViewport !== null,
    "doubled viewport geometry should be valid",
  );

  assertClose(
    doubledViewport.width,
    base.width * 2,
    "pin width should scale with rendered map",
  );
  assertClose(
    doubledViewport.height,
    base.height * 2,
    "pin height should scale with rendered map",
  );
  assertClose(
    doubledViewport.centerX,
    base.centerX * 2,
    "pin centerX should remain locked to rendered map",
  );
  assertClose(
    doubledViewport.centerY,
    base.centerY * 2,
    "pin centerY should remain locked to rendered map",
  );

  const invalid = calculatePinDisplayGeometry({
    naturalSize: { w: 0, h: 3400 },
    displaySize: { w: 600, h: 850 },
    normalizedX: 0.5,
    normalizedY: 0.5,
    pinWidth: 77,
    pinHeight: 24,
    pinOffsetX: 0,
    pinOffsetY: 0,
    span: 1,
    orientation: "vertical",
  });

  assert(invalid === null, "invalid natural size should not render a pin");

  assert(
    isPointInsideMapPinTouchTarget(base, base.centerX, base.centerY, 28),
    "visual center should be inside the touch target",
  );
  assert(
    isPointInsideMapPinTouchTarget(
      base,
      base.centerX,
      base.centerY + 10,
      28,
    ),
    "point outside visual pin but inside 28px minimum target should hit",
  );
  assert(
    !isPointInsideMapPinTouchTarget(
      base,
      base.centerX,
      base.centerY + 15,
      28,
    ),
    "point just outside the 28px minimum target should miss",
  );

  const wideRect = calculatePinDisplayGeometry({
    naturalSize: { w: 100, h: 100 },
    displaySize: { w: 100, h: 100 },
    normalizedX: 0.5,
    normalizedY: 0.5,
    pinWidth: 40,
    pinHeight: 10,
    pinOffsetX: 0,
    pinOffsetY: 0,
    span: 1,
    orientation: "horizontal",
  });
  assert(wideRect !== null, "rectangular geometry should be valid");
  assert(
    isPointInsideMapPinTouchTarget(
      wideRect,
      wideRect.centerX + 18,
      wideRect.centerY,
      8,
    ),
    "wide rectangle should hit along its longer axis",
  );
  assert(
    !isPointInsideMapPinTouchTarget(
      wideRect,
      wideRect.centerX,
      wideRect.centerY + 8,
      8,
    ),
    "wide rectangle should miss along its shorter axis",
  );

  const mapSpaceMinimum = 28 / 2;
  assert(
    isPointInsideMapPinTouchTarget(
      base,
      base.centerX,
      base.centerY + 6,
      mapSpaceMinimum,
    ),
    "map-space minimum of 28/scale should still hit near the pin",
  );
  assert(
    !isPointInsideMapPinTouchTarget(
      base,
      base.centerX,
      base.centerY + 10,
      mapSpaceMinimum,
    ),
    "map-space minimum of 28/scale should miss a point that 28px would still hit",
  );

  console.log("map-pin-layout.test passed");
}
