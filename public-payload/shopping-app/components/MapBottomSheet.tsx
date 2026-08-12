import { useRef, useCallback } from 'react';
import {
  StyleSheet,
  View,
  Text,
  TextInput,
  Pressable,
  FlatList,
  type LayoutChangeEvent,
} from 'react-native';
import { Image } from 'expo-image';
import { router } from 'expo-router';
import {
  GestureDetector,
  Gesture,
  GestureHandlerRootView,
} from 'react-native-gesture-handler';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  runOnJS,
} from 'react-native-reanimated';
import { getColors } from '@/constants/Colors';
import { useTheme } from '@/lib/theme-context';
import { usePriorityColors } from '@/lib/priority-color-context';
import { PURCHASE_STATUS, PURCHASE_STATUS_LABELS } from '@/lib/types';
import type { Circle } from '@/lib/types';

interface MapBottomSheetProps {
  circles: Circle[];
  searchQuery: string;
  onSearchChange: (q: string) => void;
  onCirclePress: (circle: Circle) => void;
  containerHeight: number;
}

const SNAP_COLLAPSED = 60;
const SNAP_HALF = 300;

export default function MapBottomSheet({
  circles,
  searchQuery,
  onSearchChange,
  onCirclePress,
  containerHeight,
}: MapBottomSheetProps) {
  const { effectiveScheme } = useTheme();
  const colors = getColors(effectiveScheme);
  const { getColor } = usePriorityColors();

  const snapMax = Math.max(containerHeight * 0.7, SNAP_HALF);
  const translateY = useSharedValue(containerHeight - SNAP_COLLAPSED);
  const savedTranslateY = useSharedValue(containerHeight - SNAP_COLLAPSED);

  const panGesture = Gesture.Pan()
    .onUpdate((e) => {
      const newY = savedTranslateY.value + e.translationY;
      const minY = containerHeight - snapMax;
      const maxY = containerHeight - SNAP_COLLAPSED;
      translateY.value = Math.max(minY, Math.min(maxY, newY));
    })
    .onEnd((e) => {
      const current = translateY.value;
      const collapsedY = containerHeight - SNAP_COLLAPSED;
      const halfY = containerHeight - SNAP_HALF;
      const maxY = containerHeight - snapMax;

      // スナップ先を決定
      let target: number;
      if (e.velocityY > 500) {
        target = collapsedY; // 下にスワイプ → 閉じる
      } else if (e.velocityY < -500) {
        target = current < halfY ? maxY : halfY; // 上にスワイプ → 展開
      } else {
        // 最も近いスナップポイント
        const dists = [
          { y: collapsedY, d: Math.abs(current - collapsedY) },
          { y: halfY, d: Math.abs(current - halfY) },
          { y: maxY, d: Math.abs(current - maxY) },
        ];
        dists.sort((a, b) => a.d - b.d);
        target = dists[0].y;
      }

      translateY.value = withSpring(target, { damping: 20, stiffness: 200 });
      savedTranslateY.value = target;
    });

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: translateY.value }],
  }));

  const renderItem = useCallback(({ item }: { item: Circle }) => {
    const priority = getColor(item.priorityColor);
    const imagePath = item.circleCutFilename
      ? item.circleCutFilename.startsWith('file://') || item.circleCutFilename.startsWith('/')
        ? item.circleCutFilename
        : null
      : null;

    return (
      <Pressable
        style={[styles.circleItem, { borderBottomColor: colors.border }]}
        onPress={() => onCirclePress(item)}
      >
        {imagePath ? (
          <Image source={{ uri: imagePath }} style={styles.circleThumb} contentFit="cover" />
        ) : (
          <View style={[styles.circleThumb, styles.thumbPlaceholder, { backgroundColor: colors.border }]}>
            <Text style={[styles.thumbText, { color: colors.textSecondary }]}>{item.name.charAt(0)}</Text>
          </View>
        )}
        <View style={styles.circleInfo}>
          <View style={styles.circleTopRow}>
            {item.space && (
              <Text style={[styles.circleSpace, { color: priority.color }]}>{item.space}</Text>
            )}
            <Text style={[styles.circleName, { color: colors.text }]} numberOfLines={1}>{item.name}</Text>
          </View>
          {item.memo !== '' && (
            <Text style={[styles.circleMemo, { color: colors.textSecondary }]} numberOfLines={1}>{item.memo}</Text>
          )}
        </View>
        <View style={[styles.priorityDot, { backgroundColor: priority.color }]} />
        {item.purchaseStatus !== PURCHASE_STATUS.NOT_YET && (
          <View style={[styles.checkedBadge, { backgroundColor: PURCHASE_STATUS_LABELS[item.purchaseStatus].color }]}>
            <Text style={styles.checkedText}>{PURCHASE_STATUS_LABELS[item.purchaseStatus].icon}</Text>
          </View>
        )}
      </Pressable>
    );
  }, [colors, getColor, onCirclePress]);

  return (
    <Animated.View
      style={[
        styles.sheet,
        { backgroundColor: colors.card, height: snapMax },
        animatedStyle,
      ]}
    >
      <GestureDetector gesture={panGesture}>
        <Animated.View style={styles.handleArea}>
          <View style={[styles.handle, { backgroundColor: colors.border }]} />
          <Text style={[styles.title, { color: colors.text }]}>
            サークル一覧 ({circles.length})
          </Text>
        </Animated.View>
      </GestureDetector>

      <View style={styles.content}>
        <TextInput
          style={[styles.searchInput, {
            borderColor: colors.border,
            backgroundColor: colors.inputBackground,
            color: colors.text,
          }]}
          placeholder="サークル検索..."
          placeholderTextColor={colors.textSecondary}
          value={searchQuery}
          onChangeText={onSearchChange}
          clearButtonMode="while-editing"
        />
        <FlatList
          data={circles}
          keyExtractor={(item) => String(item.id)}
          renderItem={renderItem}
          initialNumToRender={15}
          maxToRenderPerBatch={15}
          windowSize={5}
          ListEmptyComponent={
            <Text style={[styles.emptyText, { color: colors.textSecondary }]}>
              {searchQuery ? '該当なし' : 'サークルなし'}
            </Text>
          }
        />
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -2 },
    shadowOpacity: 0.15,
    shadowRadius: 8,
    elevation: 8,
    overflow: 'hidden',
  },
  handleArea: {
    alignItems: 'center',
    paddingTop: 8,
    paddingBottom: 6,
  },
  handle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    marginBottom: 6,
  },
  title: {
    fontSize: 13,
    fontWeight: '600',
  },
  content: {
    flex: 1,
    paddingHorizontal: 12,
  },
  searchInput: {
    height: 34,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 10,
    fontSize: 13,
    marginBottom: 6,
  },
  circleItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 8,
  },
  circleThumb: {
    width: 36,
    height: 36,
    borderRadius: 4,
  },
  thumbPlaceholder: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  thumbText: {
    fontSize: 16,
    fontWeight: 'bold',
  },
  circleInfo: {
    flex: 1,
  },
  circleTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  circleSpace: {
    fontSize: 12,
    fontWeight: '700',
  },
  circleName: {
    fontSize: 13,
    fontWeight: '500',
    flex: 1,
  },
  circleMemo: {
    fontSize: 11,
    marginTop: 1,
    fontStyle: 'italic',
  },
  priorityDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  checkedBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    marginLeft: 4,
  },
  checkedText: {
    color: '#fff',
    fontSize: 10,
    fontWeight: '700',
  },
  emptyText: {
    textAlign: 'center',
    paddingVertical: 20,
    fontSize: 13,
  },
});
