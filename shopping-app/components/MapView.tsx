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

const DEFAULT_PIN_WIDTH = 77;
const DEFAULT_PIN_HEIGHT = 24;
const DEFAULT_PIN_OFFSET_X = 0;
const DEFAULT_PIN_OFFSET_Y = 0;
const MIN_PIN_DIMENSION = 10;
const MAX_PIN_DIMENSION = 160;
const MIN_PIN_OFFSET = -160;
const MAX_PIN_OFFSET = 160;
const MIN_PIN_TOUCH_SIZE = 28;
const PIN_DIMENSION_STEP = 2;
const PIN_OFFSET_STEP = 2;
const PIN_FILL_ALPHA = 0.36;
const PIN_OUTLINE_ALPHA = 0.76;

type PinOrientation = "vertical" | "horizontal";

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
  parentStatusFilter?: number | null;
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

function normalizeSpaceNumberText(value: string): string {
  return value.replace(/[０-９]/g, (char) =>
    String.fromCharCode(char.charCodeAt(0) - 0xfee0),
  );
}

function getSpaceSpan(space: string | null): number {
  if (!space) return 1;
  const normalized = normalizeSpaceNumberText(space);
  const target = normalized.includes("-")
    ? normalized.slice(normalized.indexOf("-") + 1)
    : normalized;
  const numbers = target.match(/\d+/g);
  if (!numbers || numbers.length <= 1) return 1;
  return clamp(numbers.length, 1, 4);
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

    const [colorFilter, setColorFilter] = useState<Set<number>>(new Set());
    const [highlightedCircleId, setHighlightedCircleId] = useState<
      number | null
    >(null);
    const [currentScale, setCurrentScale] = useState(1);
    const [pinScreenWidth, setPinScreenWidth] = useState(DEFAULT_PIN_WIDTH);
    const [pinScreenHeight, setPinScreenHeight] = useState(DEFAULT_PIN_HEIGHT);
    const [pinOffsetX, setPinOffsetX] = useState(DEFAULT_PIN_OFFSET_X);
    const [pinOffsetY, setPinOffsetY] = useState(DEFAULT_PIN_OFFSET_Y);
    const [pinOrientation, setPinOrientation] =
      useState<PinOrientation>("vertical");
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

        setHighlightedCircleId(circleId);
        const targetScale = 2;
        const pinScreenX = circle.pinX * displaySize.w + pinOffsetX;
        const pinScreenY = circle.pinY * displaySize.h + pinOffsetY;
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
        pinOffsetX,
        pinOffsetY,
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

    const pinchGesture = Gesture.Pinch()
      .onUpdate((e) => {
        scale.value = savedScale.value * e.scale;
      })
      .onEnd(() => {
        if (scale.value < 0.5) {
          scale.value = withTiming(0.5);
          savedScale.value = 0.5;
          runOnJS(updateScaleJS)(0.5);
        } else if (scale.value > 5) {
          scale.value = withTiming(5);
          savedScale.value = 5;
          runOnJS(updateScaleJS)(5);
        } else {
          savedScale.value = scale.value;
          runOnJS(updateScaleJS)(scale.value);
        }
      });

    const panGesture = Gesture.Pan()
      .minPointers(1)
      .onUpdate((e) => {
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

    const singleTapGesture = Gesture.Tap()
      .numberOfTaps(1)
      .onEnd(() => {
        runOnJS(clearHighlightJS)();
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
      setColorFilter((prev) => {
        const next = new Set(prev);
        if (next.has(value)) next.delete(value);
        else next.add(value);
        return next;
      });
    }

    function adjustPinDimension(
      setter: Dispatch<SetStateAction<number>>,
      delta: number,
    ) {
      setter((value) =>
        clamp(value + delta, MIN_PIN_DIMENSION, MAX_PIN_DIMENSION),
      );
    }

    function adjustPinOffset(
      setter: Dispatch<SetStateAction<number>>,
      delta: number,
    ) {
      setter((value) => clamp(value + delta, MIN_PIN_OFFSET, MAX_PIN_OFFSET));
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
                幅{pinScreenWidth}
              </Text>
              <Pressable
                onPress={() =>
                  adjustPinDimension(
                    setPinScreenWidth,
                    -PIN_DIMENSION_STEP,
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
                    setPinScreenWidth,
                    PIN_DIMENSION_STEP,
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
                高{pinScreenHeight}
              </Text>
              <Pressable
                onPress={() =>
                  adjustPinDimension(
                    setPinScreenHeight,
                    -PIN_DIMENSION_STEP,
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
                    setPinScreenHeight,
                    PIN_DIMENSION_STEP,
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
                X{pinOffsetX}
              </Text>
              <Pressable
                onPress={() => adjustPinOffset(setPinOffsetX, -PIN_OFFSET_STEP)}
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
                onPress={() => adjustPinOffset(setPinOffsetX, PIN_OFFSET_STEP)}
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
                Y{pinOffsetY}
              </Text>
              <Pressable
                onPress={() => adjustPinOffset(setPinOffsetY, -PIN_OFFSET_STEP)}
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
                onPress={() => adjustPinOffset(setPinOffsetY, PIN_OFFSET_STEP)}
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
              {pinsForMap.map((circle) => {
                if (circle.pinX == null || circle.pinY == null) return null;
                const priority = getColor(circle.priorityColor);
                const span = getSpaceSpan(circle.space);
                const baseWidth = pinScreenWidth;
                const baseHeight = pinScreenHeight;
                const pinWidth =
                  pinOrientation === "horizontal"
                    ? baseWidth * span
                    : baseWidth;
                const pinHeight =
                  pinOrientation === "vertical"
                    ? baseHeight * span
                    : baseHeight;
                const isHighlighted = circle.id === activeHighlight;
                const pinLeft =
                  circle.pinX * displaySize.w + pinOffsetX - pinWidth / 2;
                const pinTop =
                  circle.pinY * displaySize.h + pinOffsetY - pinHeight / 2;
                const bw = Math.max(
                  isHighlighted ? 1.5 / currentScale : 0.7 / currentScale,
                  StyleSheet.hairlineWidth,
                );
                const fillColor = withAlpha(
                  priority.color,
                  isHighlighted ? 0.5 : PIN_FILL_ALPHA,
                );
                const outlineColor = withAlpha(priority.color, PIN_OUTLINE_ALPHA);
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
                  width: pinWidth,
                  height: pinHeight,
                  left: pinLeft,
                  top: pinTop,
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
              {/* ツールチップ: タップしたピンのサークル情報 + サークルカット画像 */}
              {activeHighlight != null &&
                (() => {
                  const c = pinsForMap.find((p) => p.id === activeHighlight);
                  if (!c || c.pinX == null || c.pinY == null) return null;
                  const priority = getColor(c.priorityColor);
                  const tipTop = c.pinY * displaySize.h + pinOffsetY;
                  const hasImage =
                    c.circleCutFilename &&
                    (c.circleCutFilename.startsWith("file://") ||
                      c.circleCutFilename.startsWith("/"));
                  const popupW = 220;
                  const popupH = hasImage ? 116 : 40;
                  const gap = Math.max(
                    10,
                    Math.max(pinScreenWidth, pinScreenHeight) * 0.75,
                  );
                  const pinX = c.pinX * displaySize.w + pinOffsetX;
                  const pinY = c.pinY * displaySize.h + pinOffsetY;
                  const showBelow = pinY - (popupH + gap) / currentScale < 0;
                  const minLeft = (popupW / 2 + 8) / currentScale;
                  const maxLeft = displaySize.w - minLeft;
                  const clampedLeft = Math.max(minLeft, Math.min(maxLeft, pinX));
                  return (
                    <View
                      pointerEvents="none"
                      style={{
                        position: "absolute",
                        left: clampedLeft,
                        top: showBelow
                          ? tipTop + gap / currentScale
                          : tipTop - (popupH + gap) / currentScale,
                        transform: [
                          { translateX: -popupW / 2 },
                          { scale: 1 / currentScale },
                        ],
                        transformOrigin: showBelow ? "top center" : "bottom center",
                        backgroundColor: "rgba(15, 23, 42, 0.72)",
                        paddingHorizontal: 8,
                        paddingVertical: 6,
                        borderRadius: 6,
                        borderWidth: StyleSheet.hairlineWidth,
                        borderColor: "rgba(255, 255, 255, 0.22)",
                        borderLeftWidth: 4,
                        borderLeftColor: withAlpha(priority.color, 0.86),
                        width: popupW,
                        alignItems: "center",
                        zIndex: 200,
                      }}
                    >
                      {hasImage && (
                        <Image
                          source={{ uri: c.circleCutFilename! }}
                          style={{
                            width: 80,
                            height: 80,
                            borderRadius: 4,
                            marginBottom: 4,
                          }}
                          contentFit="cover"
                          cachePolicy="memory-disk"
                        />
                      )}
                      <Text
                        style={{
                          color: "#fff",
                          fontSize: 11,
                          fontWeight: "600",
                        }}
                        numberOfLines={1}
                      >
                        {(c.hall ?? "") + (c.space ?? "")} {c.name}
                      </Text>
                    </View>
                  );
                })()}
            </Animated.View>
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
