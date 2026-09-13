import MapCirclePopup from "./MapCirclePopup";
import {
  useState,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useImperativeHandle,
  forwardRef,
  type Dispatch,
  type SetStateAction,
} from "react";
import {
  StyleSheet,
  View,
  Text,
  Pressable,
  Alert,
  useWindowDimensions,
  type LayoutChangeEvent,
} from "react-native";
import { Image } from "expo-image";
import {
  GestureDetector,
  Gesture,
  GestureHandlerRootView,
} from "react-native-gesture-handler";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  runOnJS,
} from "react-native-reanimated";
import { getColors } from "@/constants/Colors";
import { useTheme } from "@/lib/theme-context";
import { usePriorityColors } from "@/lib/priority-color-context";
import type { Circle, EventMap as EventMapType } from "@/lib/types";
import {
  recordUiMetric,
  recordUiMetricAfterPaint,
  startUiMetric,
} from "@/lib/performance";
import { buildMapPinIndex, selectMapPins } from "@/lib/map-pin-index";
import {
  calculatePinDisplayGeometry,
  getMapPinSpaceSpan,
  isPointInsideMapPinTouchTarget,
  type MapPinOrientation,
} from "@/lib/map-pin-layout";
import {
  calculateFocalPinchTransform,
  viewportPointToMapPoint,
} from "@/lib/map-viewport-transform";

const DEFAULT_PIN_MAP_WIDTH = 77;
const DEFAULT_PIN_MAP_HEIGHT = 24;
const DEFAULT_PIN_MAP_OFFSET_X = 0;
const DEFAULT_PIN_MAP_OFFSET_Y = 0;
const MIN_PIN_MAP_DIMENSION = 10;
const MAX_PIN_MAP_DIMENSION = 160;
const MIN_PIN_MAP_OFFSET = -160;
const MAX_PIN_MAP_OFFSET = 160;
const MIN_PIN_TOUCH_SIZE = 28;
const MIN_MAP_SCALE = 0.5;
const MAX_MAP_SCALE = 5;
const PIN_MAP_DIMENSION_STEP = 2;
const PIN_MAP_OFFSET_STEP = 2;
const PIN_FILL_ALPHA = 0.36;
const PIN_OUTLINE_ALPHA = 0.76;

export interface MapViewHandle {
  /** 指定サークルのピン位置にマップをアニメーション移動 */
  focusOnCircle: (circleId: number) => void;
}

interface MapViewProps {
  /** Route identity used to reset per-map performance metrics on navigation. */
  eventId?: number | null;
  /** Monotonic start captured by the parent when map display was requested. */
  mapFmpStartedAt?: number | null;
  /** Non-personal request identity used to reject stale paint callbacks. */
  mapFmpRequestKey?: string | null;
  circles: Circle[];
  maps: EventMapType[];
  onCirclePress?: (circle: Circle) => void;
  onMapLongPress?: (
    normalizedX: number,
    normalizedY: number,
    mapNumber: number,
  ) => void;
  onPinRemove?: (circle: Circle) => void;
  onPinMove?: (circle: Circle, newNormX: number, newNormY: number) => void;
  highlightCircleId?: number | null;
  showFilters?: boolean;
  // 親のフィルター状態（M2: リストと同じフィルターをマップにも適用）
  parentStatusFilter?: ReadonlySet<number> | number | null;
  onPriorityFilterChange?: (value: Set<number>) => void;
  parentPriorityFilter?: Set<number>;
  parentHallFilter?: string | null;
  parentSearchQuery?: string;
  parentGlobalSearchEnabled?: boolean;
  parentSearchTextMap?: Map<number, string[]>;
  parentCatalogPostOnly?: boolean;
  parentHideSkipped?: boolean;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function withAlpha(hex: string, alpha: number): string {
  const normalized = hex.trim().replace(/^#/, "");
  if (!/^[0-9a-f]{6}$/i.test(normalized)) return hex;
  const r = parseInt(normalized.slice(0, 2), 16);
  const g = parseInt(normalized.slice(2, 4), 16);
  const b = parseInt(normalized.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** ドラッグ移動可能なピンコンポーネント */
function DraggablePin({
  width,
  height,
  left,
  top,
  fillColor,
  outlineColor,
  bw,
  minTouchSize,
  isHighlighted,
  onPress,
  onLongPress,
  onDragEnd,
}: {
  width: number;
  height: number;
  left: number;
  top: number;
  fillColor: string;
  outlineColor: string;
  bw: number;
  minTouchSize: number;
  isHighlighted: boolean;
  onPress: () => void;
  onLongPress: () => void;
  onDragEnd?: (translationX: number, translationY: number) => void;
}) {
  const hitWidth = Math.max(width, minTouchSize);
  const hitHeight = Math.max(height, minTouchSize);
  const insetX = (hitWidth - width) / 2;
  const insetY = (hitHeight - height) / 2;
  const offsetX = useSharedValue(0);
  const offsetY = useSharedValue(0);
  const isDragging = useSharedValue(false);

  const panGesture = Gesture.Pan()
    .activateAfterLongPress(250)
    .onStart(() => {
      isDragging.value = true;
    })
    .onUpdate((e) => {
      offsetX.value = e.translationX;
      offsetY.value = e.translationY;
    })
    .onEnd((e) => {
      if (onDragEnd && isDragging.value) {
        runOnJS(onDragEnd)(e.translationX, e.translationY);
      }
      offsetX.value = 0;
      offsetY.value = 0;
      isDragging.value = false;
    });

  const tapGesture = Gesture.Tap().onEnd(() => {
    runOnJS(onPress)();
  });

  const longPressGesture = Gesture.LongPress()
    .minDuration(600)
    .onEnd((_, success) => {
      if (success) runOnJS(onLongPress)();
    });

  const composed = Gesture.Exclusive(panGesture, longPressGesture, tapGesture);

  const animStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: offsetX.value }, { translateY: offsetY.value }],
  }));

  return (
    <GestureDetector gesture={composed}>
      <Animated.View
        style={[
          styles.pinTouchTarget,
          {
            left: left - insetX,
            top: top - insetY,
            width: hitWidth,
            height: hitHeight,
            zIndex: isHighlighted ? 100 : 1,
          },
          animStyle,
        ]}
      >
        <View
          pointerEvents="none"
          style={[
            styles.pin,
            {
              left: insetX,
              top: insetY,
              width,
              height,
              backgroundColor: fillColor,
              borderColor: outlineColor,
              borderWidth: bw,
            },
            isHighlighted && styles.pinHighlighted,
          ]}
        />
      </Animated.View>
    </GestureDetector>
  );
}

/** 通常表示用の軽量ピン。ジェスチャー worklet は選択中のピンだけ生成する。 */
const StaticPin = ({
  width,
  height,
  left,
  top,
  fillColor,
  outlineColor,
  bw,
  minTouchSize,
  isHighlighted,
  onPress,
  onLongPress,
}: {
  width: number;
  height: number;
  left: number;
  top: number;
  fillColor: string;
  outlineColor: string;
  bw: number;
  minTouchSize: number;
  isHighlighted: boolean;
  onPress: () => void;
  onLongPress: () => void;
}) => {
  const hitWidth = Math.max(width, minTouchSize);
  const hitHeight = Math.max(height, minTouchSize);
  const insetX = (hitWidth - width) / 2;
  const insetY = (hitHeight - height) / 2;
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      style={[
        styles.pinTouchTarget,
        {
          left: left - insetX,
          top: top - insetY,
          width: hitWidth,
          height: hitHeight,
          zIndex: isHighlighted ? 100 : 1,
        },
      ]}
    >
      <View
        pointerEvents="none"
        style={[
          styles.pin,
          {
            left: insetX,
            top: insetY,
            width,
            height,
            backgroundColor: fillColor,
            borderColor: outlineColor,
            borderWidth: bw,
          },
          isHighlighted && styles.pinHighlighted,
        ]}
      />
    </Pressable>
  );
};

const MapViewComponent = forwardRef<MapViewHandle, MapViewProps>(
  function MapViewComponent(
    {
      eventId,
      mapFmpStartedAt,
      mapFmpRequestKey,
      circles,
      maps,
      onCirclePress,
      onMapLongPress,
      onPinRemove,
      onPinMove,
      highlightCircleId: externalHighlight,
      showFilters = true,
      parentStatusFilter,
      parentPriorityFilter,
      onPriorityFilterChange,
      parentHallFilter,
      parentSearchQuery,
      parentGlobalSearchEnabled,
      parentSearchTextMap,
      parentCatalogPostOnly,
      parentHideSkipped,
    },
    ref,
  ) {
    const { effectiveScheme } = useTheme();
    const colors = getColors(effectiveScheme);
    const { options: priorityOptions, getColor } = usePriorityColors();
    const [currentMap, setCurrentMap] = useState<EventMapType | null>(
      maps.length > 0 ? maps[0] : null,
    );
    // 画像の実サイズ（naturalWidth/Height相当）
    const [naturalSize, setNaturalSize] = useState<{
      w: number;
      h: number;
    } | null>(null);
    const [containerSize, setContainerSize] = useState({ width: 1, height: 1 });
    const { width: screenWidth } = useWindowDimensions();

    const [localColorFilter, setLocalColorFilter] = useState<Set<number>>(new Set());
    const colorFilter = parentPriorityFilter ?? localColorFilter;
    const [highlightedCircleId, setHighlightedCircleId] = useState<
      number | null
    >(null);
    const [currentScale, setCurrentScale] = useState(1);
    const [pinMapWidth, setPinMapWidth] = useState(DEFAULT_PIN_MAP_WIDTH);
    const [pinMapHeight, setPinMapHeight] = useState(DEFAULT_PIN_MAP_HEIGHT);
    const [pinMapOffsetX, setPinMapOffsetX] = useState(DEFAULT_PIN_MAP_OFFSET_X);
    const [pinMapOffsetY, setPinMapOffsetY] = useState(DEFAULT_PIN_MAP_OFFSET_Y);
    const [pinOrientation, setPinOrientation] =
      useState<MapPinOrientation>("vertical");
    const [pendingFocusCircleId, setPendingFocusCircleId] = useState<
      number | null
    >(null);
    const mapReadyRecorded = useRef(false);
    const mapDataReadyStartedAt = useRef<number | null>(null);
    const mapMetricKeyRef = useRef<string | null>(null);
    const mapReadyCancelRef = useRef<() => void>(() => undefined);
    const mapFmpCancelRef = useRef<() => void>(() => undefined);
    const mapFmpRecordedRequestRef = useRef<string | null>(null);
    const activeEventIdRef = useRef(eventId);
    const activeMapFmpRequestKeyRef = useRef(mapFmpRequestKey);
    activeEventIdRef.current = eventId;
    activeMapFmpRequestKeyRef.current = mapFmpRequestKey;
    // Include the full map list identity so navigating between events with the
    // same map count still starts a fresh FMP→image-load measurement. The
    // selected map identity covers tab changes within one event.
    const mapsMetricIdentity = useMemo(
      () =>
        maps
          .map((map) => `${map.id}:${map.eventId}:${map.mapNumber}:${map.filename}`)
          .join("|"),
      [maps],
    );
    const mapMetricKey = `${eventId ?? "none"}|${mapsMetricIdentity}|${currentMap?.id ?? "none"}:${currentMap?.mapNumber ?? "none"}:${currentMap?.filename ?? ""}`;

    useLayoutEffect(() => {
      if (mapMetricKeyRef.current === mapMetricKey) return;
      mapReadyCancelRef.current();
      mapFmpCancelRef.current();
      mapMetricKeyRef.current = mapMetricKey;
      mapReadyRecorded.current = false;
      mapDataReadyStartedAt.current = maps.length > 0 && currentMap ? startUiMetric() : null;
    }, [mapMetricKey, maps.length, currentMap]);

    useEffect(
      () => () => {
        mapFmpCancelRef.current();
      },
      [mapFmpRequestKey],
    );

    useEffect(
      () => () => {
        mapReadyCancelRef.current();
        mapFmpCancelRef.current();
      },
      [],
    );

    const activeHighlight = externalHighlight ?? highlightedCircleId;

    const scale = useSharedValue(1);
    const savedScale = useSharedValue(1);
    const translateX = useSharedValue(0);
    const translateY = useSharedValue(0);
    const savedTranslateX = useSharedValue(0);
    const savedTranslateY = useSharedValue(0);
    const pinchStartScale = useSharedValue(1);
    const pinchStartTranslateX = useSharedValue(0);
    const pinchStartTranslateY = useSharedValue(0);
    const pinchStartFocalX = useSharedValue(0);
    const pinchStartFocalY = useSharedValue(0);
    const transformRevision = useSharedValue(0);
    const tapStartRevision = useSharedValue(0);

    // 画像の表示サイズ（コンテナにフィット）
    const displaySize = useMemo(() => {
      const containerW =
        containerSize.width > 1 ? containerSize.width : screenWidth;
      if (!naturalSize) return { w: containerW, h: containerW };
      // 画像のアスペクト比を維持してコンテナ幅にフィット
      const displayW = containerW;
      const displayH = (containerW / naturalSize.w) * naturalSize.h;
      return { w: displayW, h: displayH };
    }, [naturalSize, screenWidth, containerSize.width]);

    const selectMap = useCallback((map: EventMapType) => {
      setNaturalSize(null);
      setCurrentMap(map);
    }, []);

    useEffect(() => {
      if (maps.length === 0) {
        setCurrentMap(null);
        setNaturalSize(null);
        return;
      }
      const matchingMap = currentMap
        ? maps.find((map) => map.id === currentMap.id)
        : null;
      if (!matchingMap) {
        selectMap(maps[0]);
      } else if (
        matchingMap.eventId !== currentMap?.eventId ||
        matchingMap.mapNumber !== currentMap?.mapNumber ||
        matchingMap.filename !== currentMap?.filename
      ) {
        // The same map row can be re-imported with a new image/number. Keep
        // current-tab selection while refreshing its metric identity.
        selectMap(matchingMap);
      }
    }, [maps, currentMap, selectMap]);

    const focusCircleNow = useCallback(
      (circleId: number) => {
        const circle = circles.find((c) => c.id === circleId);
        if (!circle || circle.pinX == null || circle.pinY == null) {
          return false;
        }

        const targetMap =
          circle.mapNumber != null && circle.mapNumber !== 0
            ? maps.find((m) => m.mapNumber === circle.mapNumber)
            : null;
        if (targetMap && currentMap?.id !== targetMap.id) {
          selectMap(targetMap);
          return false;
        }
        if (!currentMap && maps.length > 0) {
          selectMap(maps[0]);
          return false;
        }
        if (
          !naturalSize ||
          containerSize.width <= 1 ||
          containerSize.height <= 1
        ) {
          return false;
        }

        const geometry = calculatePinDisplayGeometry({
          naturalSize,
          displaySize,
          normalizedX: circle.pinX,
          normalizedY: circle.pinY,
          pinWidth: pinMapWidth,
          pinHeight: pinMapHeight,
          pinOffsetX: pinMapOffsetX,
          pinOffsetY: pinMapOffsetY,
          span: getMapPinSpaceSpan(circle.space),
          orientation: pinOrientation,
        });
        if (!geometry) return false;

        setHighlightedCircleId(circleId);
        const targetScale = 2;
        const pinScreenX = geometry.centerX;
        const pinScreenY = geometry.centerY;
        const centerOffsetX =
          containerSize.width / 2 - pinScreenX * targetScale;
        const centerOffsetY =
          containerSize.height / 2 - pinScreenY * targetScale;
        scale.value = withTiming(targetScale, { duration: 300 });
        savedScale.value = targetScale;
        translateX.value = withTiming(centerOffsetX, { duration: 300 });
        translateY.value = withTiming(centerOffsetY, { duration: 300 });
        savedTranslateX.value = centerOffsetX;
        savedTranslateY.value = centerOffsetY;
        setCurrentScale(targetScale);
        return true;
      },
      [
        circles,
        maps,
        currentMap,
        naturalSize,
        containerSize,
        displaySize,
        selectMap,
        scale,
        savedScale,
        translateX,
        translateY,
        savedTranslateX,
        savedTranslateY,
        pinMapWidth,
        pinMapHeight,
        pinMapOffsetX,
        pinMapOffsetY,
        pinOrientation,
      ],
    );

    useEffect(() => {
      if (pendingFocusCircleId == null) return;
      if (focusCircleNow(pendingFocusCircleId)) {
        setPendingFocusCircleId(null);
      }
    }, [pendingFocusCircleId, focusCircleNow]);

    // 外部からピン位置にフォーカスするAPI
    useImperativeHandle(
      ref,
      () => ({
        focusOnCircle(circleId: number) {
          if (!focusCircleNow(circleId)) {
            setPendingFocusCircleId(circleId);
          }
        },
      }),
      [focusCircleNow],
    );

    const mapPinIndex = useMemo(() => buildMapPinIndex(circles), [circles]);

    // The helper applies all map filters in one predicate pass, avoiding up to
    // eight intermediate arrays when the map has hundreds of pins.
    const pinsForMap = useMemo(
      () =>
        selectMapPins(mapPinIndex, {
          mapNumber: currentMap?.mapNumber ?? null,
          colors: colorFilter,
          status: parentStatusFilter,
          priorities: parentPriorityFilter,
          hall: parentHallFilter,
          searchQuery: parentSearchQuery,
          globalSearchEnabled: parentGlobalSearchEnabled,
          itemSearchText: parentSearchTextMap,
          catalogPostOnly: parentCatalogPostOnly,
          hideSkipped: parentHideSkipped,
        }),
      [
        mapPinIndex,
        currentMap?.mapNumber,
        colorFilter,
        parentStatusFilter,
        parentPriorityFilter,
        parentHallFilter,
        parentSearchQuery,
        parentGlobalSearchEnabled,
        parentSearchTextMap,
        parentCatalogPostOnly,
        parentHideSkipped,
      ],
    );

    const updateScaleJS = useCallback((s: number) => setCurrentScale(s), []);

    const getPinDisplayGeometry = useCallback(
      (circle: Circle) => {
        if (!naturalSize || circle.pinX == null || circle.pinY == null) {
          return null;
        }
        return calculatePinDisplayGeometry({
          naturalSize,
          displaySize,
          normalizedX: circle.pinX,
          normalizedY: circle.pinY,
          pinWidth: pinMapWidth,
          pinHeight: pinMapHeight,
          pinOffsetX: pinMapOffsetX,
          pinOffsetY: pinMapOffsetY,
          span: getMapPinSpaceSpan(circle.space),
          orientation: pinOrientation,
        });
      },
      [
        naturalSize,
        displaySize,
        pinMapWidth,
        pinMapHeight,
        pinMapOffsetX,
        pinMapOffsetY,
        pinOrientation,
      ],
    );

    const pinchGesture = Gesture.Pinch()
      .onStart((e) => {
        pinchStartScale.value = scale.value;
        pinchStartTranslateX.value = translateX.value;
        pinchStartTranslateY.value = translateY.value;
        pinchStartFocalX.value = e.focalX;
        pinchStartFocalY.value = e.focalY;
      })
      .onUpdate((e) => {
        transformRevision.value += 1;
        const next = calculateFocalPinchTransform({
          startScale: pinchStartScale.value,
          startTranslateX: pinchStartTranslateX.value,
          startTranslateY: pinchStartTranslateY.value,
          startFocalX: pinchStartFocalX.value,
          startFocalY: pinchStartFocalY.value,
          currentFocalX: e.focalX,
          currentFocalY: e.focalY,
          gestureScale: e.scale,
          minScale: MIN_MAP_SCALE,
          maxScale: MAX_MAP_SCALE,
        });
        scale.value = next.scale;
        translateX.value = next.translateX;
        translateY.value = next.translateY;
      })
      .onEnd(() => {
        savedScale.value = scale.value;
        savedTranslateX.value = translateX.value;
        savedTranslateY.value = translateY.value;
        runOnJS(updateScaleJS)(scale.value);
      });

    const panGesture = Gesture.Pan()
      .minPointers(1)
      .maxPointers(1)
      .onTouchesDown((e, manager) => {
        if (e.numberOfTouches > 1) {
          savedTranslateX.value = translateX.value;
          savedTranslateY.value = translateY.value;
          manager.fail();
        }
      })
      .onUpdate((e) => {
        transformRevision.value += 1;
        translateX.value = savedTranslateX.value + e.translationX;
        translateY.value = savedTranslateY.value + e.translationY;
      })
      .onEnd(() => {
        savedTranslateX.value = translateX.value;
        savedTranslateY.value = translateY.value;
      });

    const doubleTapGesture = Gesture.Tap()
      .numberOfTaps(2)
      .onEnd(() => {
        if (scale.value > 1.5) {
          scale.value = withTiming(1);
          savedScale.value = 1;
          translateX.value = withTiming(0);
          translateY.value = withTiming(0);
          savedTranslateX.value = 0;
          savedTranslateY.value = 0;
          runOnJS(updateScaleJS)(1);
        } else {
          scale.value = withTiming(3);
          savedScale.value = 3;
          runOnJS(updateScaleJS)(3);
        }
      });

    const handleLongPressJS = useCallback(
      (x: number, y: number) => {
        if (!onMapLongPress || !currentMap || !naturalSize) return;
        const mapX = (x - translateX.value) / scale.value;
        const mapY = (y - translateY.value) / scale.value;
        const normX = mapX / displaySize.w;
        const normY = mapY / displaySize.h;
        if (normX >= 0 && normX <= 1 && normY >= 0 && normY <= 1) {
          onMapLongPress(normX, normY, currentMap.mapNumber);
        }
      },
      [onMapLongPress, currentMap, naturalSize, displaySize],
    );

    const longPressGesture = Gesture.LongPress()
      .minDuration(600)
      .onEnd((e, success) => {
        if (!success) return;
        runOnJS(handleLongPressJS)(e.x, e.y);
      });

    // M13: 空白タップでフォーカス解除
    const clearHighlightJS = useCallback(() => {
      setHighlightedCircleId(null);
    }, []);

    const clearHighlightIfBlankJS = useCallback(
      (
        viewportX: number,
        viewportY: number,
        currentScale: number,
        currentTranslateX: number,
        currentTranslateY: number,
        gestureRevision: number,
      ) => {
        // パン・ピンチで変形した後に届く古いタップで選択を消さない。
        if (transformRevision.value !== gestureRevision) return;
        if (!naturalSize) {
          clearHighlightJS();
          return;
        }
        const mapPoint = viewportPointToMapPoint(
          { x: viewportX, y: viewportY },
          {
            scale: currentScale,
            translateX: currentTranslateX,
            translateY: currentTranslateY,
          },
        );
        if (!mapPoint) {
          clearHighlightJS();
          return;
        }
        const minimumTouchSizeInMapSpace = MIN_PIN_TOUCH_SIZE / currentScale;
        for (const circle of pinsForMap) {
          const geometry = getPinDisplayGeometry(circle);
          if (!geometry) continue;
          if (
            isPointInsideMapPinTouchTarget(
              geometry,
              mapPoint.x,
              mapPoint.y,
              minimumTouchSizeInMapSpace,
            )
          ) {
            return;
          }
        }
        clearHighlightJS();
      },
      [naturalSize, pinsForMap, getPinDisplayGeometry, clearHighlightJS, transformRevision],
    );

    const singleTapGesture = Gesture.Tap()
      .numberOfTaps(1)
      .maxDistance(8)
      .maxDuration(250)
      .onBegin(() => { tapStartRevision.value = transformRevision.value; })
      .onEnd((e, success) => {
        if (success && tapStartRevision.value === transformRevision.value) {
          runOnJS(clearHighlightIfBlankJS)(
            e.x,
            e.y,
            scale.value,
            translateX.value,
            translateY.value,
            transformRevision.value,
          );
        }
      });

    const composedGesture = Gesture.Race(
      longPressGesture,
      Gesture.Simultaneous(
        pinchGesture,
        panGesture,
        Gesture.Exclusive(doubleTapGesture, singleTapGesture),
      ),
    );

    const mapAnimatedStyle = useAnimatedStyle(() => ({
      transform: [
        { translateX: translateX.value },
        { translateY: translateY.value },
        { scale: scale.value },
      ],
    }));

    function toggleColorFilter(value: number) {
      const next = new Set(colorFilter);
      if (next.has(value)) next.delete(value); else next.add(value);
      if (onPriorityFilterChange) onPriorityFilterChange(next);
      else setLocalColorFilter(next);
    }

    function adjustPinDimension(
      setter: Dispatch<SetStateAction<number>>,
      delta: number,
    ) {
      setter((value) =>
        clamp(value + delta, MIN_PIN_MAP_DIMENSION, MAX_PIN_MAP_DIMENSION),
      );
    }

    function adjustPinOffset(
      setter: Dispatch<SetStateAction<number>>,
      delta: number,
    ) {
      setter((value) => clamp(value + delta, MIN_PIN_MAP_OFFSET, MAX_PIN_MAP_OFFSET));
    }

    function handlePinPress(circle: Circle) {
      setHighlightedCircleId(circle.id);
      if (onCirclePress) onCirclePress(circle);
    }

    function handleContainerLayout(e: LayoutChangeEvent) {
      const { width, height } = e.nativeEvent.layout;
      setContainerSize({ width, height });
    }

    if (maps.length === 0) {
      return (
        <View style={[styles.center, { backgroundColor: colors.background }]}>
          <Text style={{ color: colors.textSecondary, textAlign: "center" }}>
            マップデータがありません
          </Text>
        </View>
      );
    }

    return (
      <GestureHandlerRootView
        style={[styles.container, { backgroundColor: "#1a1a2e" }]}
      >
        {/* マップタブ切り替え */}
        {maps.length > 1 && (
          <View style={styles.mapTabs}>
            {maps.map((m) => (
              <Pressable
                key={m.id}
                style={[
                  styles.mapTab,
                  { backgroundColor: colors.border },
                  currentMap?.id === m.id && { backgroundColor: colors.tint },
                ]}
                onPress={() => selectMap(m)}
              >
                <Text
                  style={[
                    styles.mapTabText,
                    { color: colors.textSecondary },
                    currentMap?.id === m.id && {
                      color: "#fff",
                      fontWeight: "600",
                    },
                  ]}
                >
                  マップ {m.mapNumber}
                </Text>
              </Pressable>
            ))}
          </View>
        )}

        {/* フィルターチップ */}
        {showFilters && (
          <View style={styles.filterRow}>
            {priorityOptions.map((opt) => {
              const isActive = colorFilter.has(opt.value);
              return (
                <Pressable
                  key={opt.value}
                  style={[
                    styles.filterChip,
                    { borderColor: opt.color },
                    isActive && { backgroundColor: opt.bgColor },
                    !isActive && colorFilter.size > 0 && { opacity: 0.35 },
                  ]}
                  onPress={() => toggleColorFilter(opt.value)}
                >
                  <View
                    style={[styles.filterDot, { backgroundColor: opt.color }]}
                  />
                  <Text style={[styles.filterChipText, { color: opt.color }]}>
                    {opt.label}
                  </Text>
                </Pressable>
              );
            })}
            <View style={styles.filterDivider} />
            <View style={styles.pinControlGroup}>
              <Text
                style={[
                  styles.pinControlLabel,
                  { color: colors.textSecondary },
                ]}
              >
                幅{pinMapWidth}
              </Text>
              <Pressable
                onPress={() =>
                  adjustPinDimension(
                    setPinMapWidth,
                    -PIN_MAP_DIMENSION_STEP,
                  )
                }
                style={[
                  styles.filterChip,
                  { borderColor: colors.textSecondary, paddingHorizontal: 8 },
                ]}
              >
                <Text
                  style={[
                    styles.filterChipText,
                    { color: colors.textSecondary },
                  ]}
                >
                  -
                </Text>
              </Pressable>
              <Pressable
                onPress={() =>
                  adjustPinDimension(
                    setPinMapWidth,
                    PIN_MAP_DIMENSION_STEP,
                  )
                }
                style={[
                  styles.filterChip,
                  { borderColor: colors.textSecondary, paddingHorizontal: 8 },
                ]}
              >
                <Text
                  style={[
                    styles.filterChipText,
                    { color: colors.textSecondary },
                  ]}
                >
                  +
                </Text>
              </Pressable>
              <Text
                style={[
                  styles.pinControlLabel,
                  { color: colors.textSecondary },
                ]}
              >
                高{pinMapHeight}
              </Text>
              <Pressable
                onPress={() =>
                  adjustPinDimension(
                    setPinMapHeight,
                    -PIN_MAP_DIMENSION_STEP,
                  )
                }
                style={[
                  styles.filterChip,
                  { borderColor: colors.textSecondary, paddingHorizontal: 8 },
                ]}
              >
                <Text
                  style={[
                    styles.filterChipText,
                    { color: colors.textSecondary },
                  ]}
                >
                  -
                </Text>
              </Pressable>
              <Pressable
                onPress={() =>
                  adjustPinDimension(
                    setPinMapHeight,
                    PIN_MAP_DIMENSION_STEP,
                  )
                }
                style={[
                  styles.filterChip,
                  { borderColor: colors.textSecondary, paddingHorizontal: 8 },
                ]}
              >
                <Text
                  style={[
                    styles.filterChipText,
                    { color: colors.textSecondary },
                  ]}
                >
                  +
                </Text>
              </Pressable>
              <Pressable
                onPress={() =>
                  setPinOrientation((value) =>
                    value === "vertical" ? "horizontal" : "vertical",
                  )
                }
                style={[
                  styles.filterChip,
                  { borderColor: colors.textSecondary },
                ]}
              >
                <Text
                  style={[
                    styles.filterChipText,
                    { color: colors.textSecondary },
                  ]}
                >
                  {pinOrientation === "vertical" ? "縦" : "横"}
                </Text>
              </Pressable>
              <Text
                style={[
                  styles.pinControlLabel,
                  { color: colors.textSecondary },
                ]}
              >
                X{pinMapOffsetX}
              </Text>
              <Pressable
                onPress={() => adjustPinOffset(setPinMapOffsetX, -PIN_MAP_OFFSET_STEP)}
                style={[
                  styles.filterChip,
                  { borderColor: colors.textSecondary, paddingHorizontal: 8 },
                ]}
              >
                <Text
                  style={[
                    styles.filterChipText,
                    { color: colors.textSecondary },
                  ]}
                >
                  -
                </Text>
              </Pressable>
              <Pressable
                onPress={() => adjustPinOffset(setPinMapOffsetX, PIN_MAP_OFFSET_STEP)}
                style={[
                  styles.filterChip,
                  { borderColor: colors.textSecondary, paddingHorizontal: 8 },
                ]}
              >
                <Text
                  style={[
                    styles.filterChipText,
                    { color: colors.textSecondary },
                  ]}
                >
                  +
                </Text>
              </Pressable>
              <Text
                style={[
                  styles.pinControlLabel,
                  { color: colors.textSecondary },
                ]}
              >
                Y{pinMapOffsetY}
              </Text>
              <Pressable
                onPress={() => adjustPinOffset(setPinMapOffsetY, -PIN_MAP_OFFSET_STEP)}
                style={[
                  styles.filterChip,
                  { borderColor: colors.textSecondary, paddingHorizontal: 8 },
                ]}
              >
                <Text
                  style={[
                    styles.filterChipText,
                    { color: colors.textSecondary },
                  ]}
                >
                  -
                </Text>
              </Pressable>
              <Pressable
                onPress={() => adjustPinOffset(setPinMapOffsetY, PIN_MAP_OFFSET_STEP)}
                style={[
                  styles.filterChip,
                  { borderColor: colors.textSecondary, paddingHorizontal: 8 },
                ]}
              >
                <Text
                  style={[
                    styles.filterChipText,
                    { color: colors.textSecondary },
                  ]}
                >
                  +
                </Text>
              </Pressable>
            </View>
          </View>
        )}

        {/* マップ本体 */}
        <View style={styles.mapArea} onLayout={handleContainerLayout}>
          <GestureDetector gesture={composedGesture}>
            <View
              style={{ flex: 1 }}
            >
            <Animated.View
              style={[
                {
                  width: displaySize.w,
                  height: displaySize.h,
                  transformOrigin: "top left",
                },
                mapAnimatedStyle,
              ]}
            >
              {currentMap && (
                <Image
                  key={mapMetricKey}
                  source={{ uri: currentMap.filename }}
                  style={{ width: displaySize.w, height: displaySize.h }}
                  contentFit="fill"
                  onLoad={(e) => {
                    const { width, height } = e.source;
                    if (width > 0 && height > 0) {
                      // An old image can finish after navigation/tab switch;
                      // do not even publish its natural size into the new map
                      // before the metric-key guard.
                      if (mapMetricKeyRef.current !== mapMetricKey) return;
                      setNaturalSize({ w: width, h: height });
                      if (!mapReadyRecorded.current) {
                        mapReadyRecorded.current = true;
                        const metricEventId = eventId;
                        const metricMapKey = mapMetricKey;
                        const metricRequestKey = mapFmpRequestKey ?? null;
                        recordUiMetric("map-pin-count", pinsForMap.length);
                        mapReadyCancelRef.current();
                        mapReadyCancelRef.current = recordUiMetricAfterPaint(
                          "map-ready-after-data",
                          mapDataReadyStartedAt.current,
                          () =>
                            activeEventIdRef.current === metricEventId &&
                            mapMetricKeyRef.current === metricMapKey,
                        );
                        if (
                          metricRequestKey &&
                          mapFmpRecordedRequestRef.current !== metricRequestKey
                        ) {
                          mapFmpCancelRef.current();
                          mapFmpCancelRef.current = recordUiMetricAfterPaint(
                            "map-fmp",
                            mapFmpStartedAt ?? null,
                            () => {
                              const isCurrent =
                                activeEventIdRef.current === metricEventId &&
                                activeMapFmpRequestKeyRef.current === metricRequestKey &&
                                mapMetricKeyRef.current === metricMapKey;
                              if (isCurrent) {
                                mapFmpRecordedRequestRef.current = metricRequestKey;
                              }
                              return isCurrent;
                            },
                          );
                        }
                      }
                    }
                  }}
                />
              )}
              {/* ピン描画: 正規化座標 × 表示サイズ */}
              {naturalSize &&
                pinsForMap.map((circle) => {
                if (circle.pinX == null || circle.pinY == null) return null;
                const priority = getColor(circle.priorityColor);
                const geometry = getPinDisplayGeometry(circle);
                if (!geometry) return null;
                const isHighlighted = circle.id === activeHighlight;
                const bw = Math.max(
                  isHighlighted ? 2.5 / currentScale : 0.7 / currentScale,
                  StyleSheet.hairlineWidth,
                );
                const fillColor = withAlpha(
                  priority.color,
                  isHighlighted ? 0.5 : PIN_FILL_ALPHA,
                );
                const outlineColor = isHighlighted ? '#ffffff' : withAlpha(priority.color, PIN_OUTLINE_ALPHA);
                const handlePinLongPress = () => {
                  if (!onPinRemove) return;
                  Alert.alert("ピン削除", `「${circle.name}」のピンを削除しますか？`, [
                    { text: "キャンセル", style: "cancel" },
                    { text: "削除", style: "destructive", onPress: () => onPinRemove(circle) },
                  ]);
                };
                const handlePinDragEnd = onPinMove
                  ? (tx: number, ty: number) => {
                      const deltaNormX = tx / (currentScale * displaySize.w);
                      const deltaNormY = ty / (currentScale * displaySize.h);
                      const newNormX = Math.max(0, Math.min(1, (circle.pinX ?? 0) + deltaNormX));
                      const newNormY = Math.max(0, Math.min(1, (circle.pinY ?? 0) + deltaNormY));
                      onPinMove(circle, newNormX, newNormY);
                    }
                  : undefined;
                const commonPinProps = {
                  key: circle.id,
                  width: geometry.width,
                  height: geometry.height,
                  left: geometry.left,
                  top: geometry.top,
                  fillColor,
                  outlineColor,
                  bw,
                  minTouchSize: MIN_PIN_TOUCH_SIZE / currentScale,
                  isHighlighted,
                  onPress: () => handlePinPress(circle),
                  onLongPress: handlePinLongPress,
                };
                return isHighlighted ? (
                  <DraggablePin {...commonPinProps} onDragEnd={handlePinDragEnd} />
                ) : (
                  <StaticPin {...commonPinProps} />
                );
                })}
            </Animated.View>
            {naturalSize && activeHighlight != null && (() => {
              const circle = pinsForMap.find((p) => p.id === activeHighlight);
              const pin = circle ? getPinDisplayGeometry(circle) : null;
              return circle && pin ? <MapCirclePopup key={circle.id} circle={circle} pin={pin}
                viewport={containerSize} scale={scale} translateX={translateX} translateY={translateY}
                color={getColor(circle.priorityColor).color} /> : null;
            })()}
            </View>
          </GestureDetector>
        </View>
      </GestureHandlerRootView>
    );
  },
);

export default MapViewComponent;

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 32,
  },
  mapTabs: {
    flexDirection: "row",
    paddingHorizontal: 8,
    paddingTop: 8,
    gap: 8,
  },
  mapTab: { paddingHorizontal: 16, paddingVertical: 6, borderRadius: 16 },
  mapTabText: { fontSize: 13 },
  filterRow: {
    flexDirection: "row",
    paddingHorizontal: 8,
    paddingVertical: 6,
    gap: 6,
    flexWrap: "wrap",
    alignItems: "center",
  },
  filterChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    borderWidth: 1.5,
  },
  filterDot: { width: 8, height: 8, borderRadius: 4 },
  filterChipText: { fontSize: 11, fontWeight: "600" },
  filterDivider: { width: 1, height: 16 },
  pinControlGroup: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    flexWrap: "wrap",
  },
  pinControlLabel: {
    fontSize: 10,
    minWidth: 32,
    textAlign: "center",
  },
  mapArea: { flex: 1, overflow: "hidden", backgroundColor: "#1a1a2e" },
  pinTouchTarget: {
    position: "absolute",
  },
  pin: {
    position: "absolute",
    borderRadius: 1,
  },
  pinHighlighted: {
    opacity: 0.95,
  },
});
