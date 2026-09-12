import {
  calculateFocalPinchTransform,
  viewportPointToMapPoint,
} from "./map-viewport-transform";

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

export function runMapViewportTransformTests(): void {
  const identityScaleUp = calculateFocalPinchTransform({
    startScale: 1,
    startTranslateX: 0,
    startTranslateY: 0,
    startFocalX: 100,
    startFocalY: 200,
    currentFocalX: 100,
    currentFocalY: 200,
    gestureScale: 2,
    minScale: 0.5,
    maxScale: 5,
  });
  assertClose(identityScaleUp.scale, 2, "scale 1->2");
  assertClose(identityScaleUp.translateX, -100, "fixed focal translateX");
  assertClose(identityScaleUp.translateY, -200, "fixed focal translateY");
  const anchoredIdentity = viewportPointToMapPoint(
    { x: 100, y: 200 },
    identityScaleUp,
  );
  assert(anchoredIdentity !== null, "identity inverse should be valid");
  assertClose(anchoredIdentity.x, 100, "scale 1->2 keeps map X under focal");
  assertClose(anchoredIdentity.y, 200, "scale 1->2 keeps map Y under focal");

  const prePanned = calculateFocalPinchTransform({
    startScale: 2,
    startTranslateX: -50,
    startTranslateY: 30,
    startFocalX: 80,
    startFocalY: 90,
    currentFocalX: 100,
    currentFocalY: 110,
    gestureScale: 1.5,
    minScale: 0.5,
    maxScale: 5,
  });
  assertClose(prePanned.scale, 3, "pre-panned next scale");
  assertClose(prePanned.translateX, -95, "pre-panned translateX");
  assertClose(prePanned.translateY, 20, "pre-panned translateY");
  const prePannedAnchor = viewportPointToMapPoint(
    { x: 100, y: 110 },
    prePanned,
  );
  assert(prePannedAnchor !== null, "pre-panned inverse should be valid");
  assertClose(prePannedAnchor.x, 65, "focal shift keeps start map X");
  assertClose(prePannedAnchor.y, 30, "focal shift keeps start map Y");

  const maxClamped = calculateFocalPinchTransform({
    startScale: 4,
    startTranslateX: -20,
    startTranslateY: 10,
    startFocalX: 40,
    startFocalY: 50,
    currentFocalX: 40,
    currentFocalY: 50,
    gestureScale: 2,
    minScale: 0.5,
    maxScale: 5,
  });
  assertClose(maxClamped.scale, 5, "max scale clamp");
  const maxAnchor = viewportPointToMapPoint({ x: 40, y: 50 }, maxClamped);
  assert(maxAnchor !== null, "max clamp inverse should be valid");
  assertClose(maxAnchor.x, 15, "max clamp preserves anchor X");
  assertClose(maxAnchor.y, 10, "max clamp preserves anchor Y");

  const minClamped = calculateFocalPinchTransform({
    startScale: 0.6,
    startTranslateX: 12,
    startTranslateY: -8,
    startFocalX: 30,
    startFocalY: 16,
    currentFocalX: 30,
    currentFocalY: 16,
    gestureScale: 0.5,
    minScale: 0.5,
    maxScale: 5,
  });
  assertClose(minClamped.scale, 0.5, "min scale clamp");
  const minAnchor = viewportPointToMapPoint({ x: 30, y: 16 }, minClamped);
  assert(minAnchor !== null, "min clamp inverse should be valid");
  assertClose(minAnchor.x, 30, "min clamp preserves anchor X");
  assertClose(minAnchor.y, 40, "min clamp preserves anchor Y");

  const roundTripPoint = { x: 123.4, y: -56.7 };
  const roundTripTransform = {
    scale: 1.75,
    translateX: 18,
    translateY: -9,
  };
  const mapped = viewportPointToMapPoint(roundTripPoint, roundTripTransform);
  assert(mapped !== null, "roundtrip inverse should be valid");
  assertClose(
    mapped.x * roundTripTransform.scale + roundTripTransform.translateX,
    roundTripPoint.x,
    "viewport X roundtrip",
  );
  assertClose(
    mapped.y * roundTripTransform.scale + roundTripTransform.translateY,
    roundTripPoint.y,
    "viewport Y roundtrip",
  );

  assert(
    viewportPointToMapPoint(
      { x: Number.NaN, y: 0 },
      { scale: 1, translateX: 0, translateY: 0 },
    ) === null,
    "nonfinite point should return null",
  );
  assert(
    viewportPointToMapPoint(
      { x: 0, y: 0 },
      { scale: Number.POSITIVE_INFINITY, translateX: 0, translateY: 0 },
    ) === null,
    "nonfinite transform should return null",
  );
  assert(
    viewportPointToMapPoint(
      { x: 0, y: 0 },
      { scale: 0, translateX: 0, translateY: 0 },
    ) === null,
    "nonpositive scale should return null",
  );
  assert(
    viewportPointToMapPoint(
      { x: 0, y: 0 },
      { scale: -1, translateX: 0, translateY: 0 },
    ) === null,
    "negative scale should return null",
  );

  console.log("map-viewport-transform.test passed");
}
