import React from 'react';
import { StyleSheet, View, Text, Pressable } from 'react-native';
import { Image } from 'expo-image';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { PURCHASE_STATUS, PURCHASE_STATUS_LABELS } from '@/lib/types';
import { getColors } from '@/constants/Colors';
import { useTheme } from '@/lib/theme-context';
import { usePriorityColors } from '@/lib/priority-color-context';
import type { Circle } from '@/lib/types';
import { getPriorityRowTheme, getRowStatusColors } from '@/lib/priority-row-theme';

interface CircleRowProps {
  circle: Circle;
  isExpanded: boolean;
  onToggleExpand: (id: number) => void;
  onCyclePurchaseStatus: (id: number) => void;
  onMapPin?: (circle: Circle) => void;
  onOpenCircleCut?: (circle: Circle) => void;
  onReplaceCircleCut?: (circle: Circle) => void;
  onOpenActions?: (circle: Circle) => void;
  onPurchaseStatusMenu?: (circle: Circle) => void;
}

function CircleRowInner({
  circle,
  isExpanded,
  onToggleExpand,
  onCyclePurchaseStatus,
  onMapPin,
  onOpenCircleCut,
  onReplaceCircleCut,
  onOpenActions,
  onPurchaseStatusMenu,
}: CircleRowProps) {
  const { effectiveScheme } = useTheme();
  const colors = getColors(effectiveScheme);
  const { getColor } = usePriorityColors();
  const priority = getColor(circle.priorityColor);
  const statusInfo = PURCHASE_STATUS_LABELS[circle.purchaseStatus];
  const isBought = circle.purchaseStatus === PURCHASE_STATUS.BOUGHT;

  // ホール + スペース番号
  const spaceLabel = [circle.hall, circle.space].filter(Boolean).join(' ');

  const imagePath = circle.circleCutFilename
    ? circle.circleCutFilename.startsWith('file://') || circle.circleCutFilename.startsWith('/')
      ? circle.circleCutFilename
      : null
    : null;

  // 購入状態はボタンと取り消し線で示し、文字・画像・操作部を透過しない。
  const surface = React.useMemo(
    () => getPriorityRowTheme(priority.color, effectiveScheme),
    [priority.color, effectiveScheme],
  );
  const statusColors = getRowStatusColors(circle.purchaseStatus, effectiveScheme);
  const priorityRowBorder = effectiveScheme === 'dark'
    ? 'rgba(255,255,255,0.16)'
    : 'rgba(15,23,42,0.18)';

  return (
    <View style={[
      styles.container,
      { backgroundColor: colors.card },
      isExpanded && { borderBottomWidth: 0 },
    ]}>
      <View
        style={[
          styles.prioritySurface,
          {
            backgroundColor: surface.end,
            borderTopColor: priorityRowBorder,
            borderBottomColor: priorityRowBorder,
          },
        ]}
      >
        <Image
          pointerEvents="none"
          accessible={false}
          style={StyleSheet.absoluteFillObject}
          source={{ uri: surface.gradientUri }}
          contentFit="fill"
          cachePolicy="memory"
          recyclingKey={surface.gradientUri}
          transition={0}
          decodeFormat="argb"
        />
        <View pointerEvents="none" style={[styles.priorityAccent, { backgroundColor: surface.ink }]} />
        <Pressable
          style={styles.row}
          onPress={() => onToggleExpand(circle.id)}
          onLongPress={() => onOpenActions?.(circle)}
        >
        {/* サークルカット画像 */}
        <Pressable
          onPress={(e) => {
            e.stopPropagation();
            if (imagePath) onOpenCircleCut?.(circle);
          }}
          onLongPress={(e) => {
            e.stopPropagation();
            onReplaceCircleCut?.(circle);
          }}
          hitSlop={4}
        >
          {imagePath ? (
            <Image source={{ uri: imagePath }} style={styles.circleCut} contentFit="cover" cachePolicy="memory-disk" recyclingKey={`cut-${circle.id}-${imagePath}`} transition={100} />
          ) : (
            <View style={[styles.circleCut, styles.noImage, { backgroundColor: effectiveScheme === 'dark' ? '#333' : '#e8e8e8' }]}>
              <Text style={[styles.noImageText, { color: surface.secondary }]}>
                {circle.name.charAt(0)}
              </Text>
            </View>
          )}
        </Pressable>

        {/* テキスト情報 */}
        <View style={styles.info}>
          {/* スペース番号 (小さめ・上) */}
          {spaceLabel !== '' && (
            <Text style={[styles.space, { color: surface.ink }]}>
              {spaceLabel}
            </Text>
          )}
          {/* サークル名 */}
          <Text
            style={[
              styles.name,
              { color: surface.text },
              isBought && { textDecorationLine: 'line-through' },
            ]}
            numberOfLines={1}
          >
            {circle.name}
          </Text>
          {/* ペンネーム */}
          {circle.penname && (
            <Text style={[styles.penname, { color: surface.secondary }]} numberOfLines={1}>
              {circle.penname}
            </Text>
          )}
          {/* メモ (あれば) */}
          {circle.memo !== '' && (
            <Text style={[styles.memo, { color: surface.secondary }]} numberOfLines={1}>
              {circle.memo}
            </Text>
          )}
        </View>

        {/* 右側ボタン群 */}
        <View style={styles.actions}>
          {/* マップピン */}
          {onMapPin && (
            <Pressable
              style={styles.actionBtn}
              onPress={(e) => {
                e.stopPropagation();
                onMapPin(circle);
              }}
              hitSlop={6}
            >
              <FontAwesome
                name="map-marker"
                size={18}
                color={
                  circle.pinX != null && circle.pinY != null
                    ? surface.ink
                    : surface.secondary
                }
              />
            </Pressable>
          )}

          {/* 購入状態トグル */}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={statusInfo.label}
            style={[
              styles.statusBtn,
              { borderColor: statusColors.foreground, backgroundColor: statusColors.background },
            ]}
            onPress={(e) => {
              e.stopPropagation();
              onCyclePurchaseStatus(circle.id);
            }}
            onLongPress={(e) => {
              e.stopPropagation();
              onPurchaseStatusMenu?.(circle);
            }}
            hitSlop={6}
          >
            <Text style={[styles.statusIcon, { color: statusColors.foreground }]}>{statusInfo.icon}</Text>
          </Pressable>
        </View>
        </Pressable>
      </View>
    </View>
  );
}

export default React.memo(CircleRowInner, (prev, next) => {
  const a = prev.circle;
  const b = next.circle;
  return (
    a.id === b.id &&
    a.eventId === b.eventId &&
    a.name === b.name &&
    a.penname === b.penname &&
    a.space === b.space &&
    a.hall === b.hall &&
    a.twitterUrl === b.twitterUrl &&
    a.websiteUrl === b.websiteUrl &&
    a.pixivUrl === b.pixivUrl &&
    a.description === b.description &&
    a.genres === b.genres &&
    a.tags === b.tags &&
    a.circleCutFilename === b.circleCutFilename &&
    a.priorityColor === b.priorityColor &&
    a.memo === b.memo &&
    a.hasCatalogPost === b.hasCatalogPost &&
    a.purchaseStatus === b.purchaseStatus &&
    a.pinX === b.pinX &&
    a.pinY === b.pinY &&
    a.mapNumber === b.mapNumber &&
    a.absenceStatus === b.absenceStatus &&
    a.existingOnlyStatus === b.existingOnlyStatus &&
    a.catalogStatus === b.catalogStatus &&
    a.rawJson === b.rawJson &&
    a.renderRevision === b.renderRevision &&
    prev.isExpanded === next.isExpanded &&
    prev.onToggleExpand === next.onToggleExpand &&
    prev.onCyclePurchaseStatus === next.onCyclePurchaseStatus &&
    prev.onMapPin === next.onMapPin &&
    prev.onOpenCircleCut === next.onOpenCircleCut &&
    prev.onReplaceCircleCut === next.onReplaceCircleCut &&
    prev.onOpenActions === next.onOpenActions &&
    prev.onPurchaseStatusMenu === next.onPurchaseStatusMenu
  );
});

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(128,128,128,0.2)',
  },
  prioritySurface: {
    flex: 1,
    position: 'relative',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  priorityAccent: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    width: 4,
  },
  row: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    paddingLeft: 12,
    paddingRight: 10,
    minHeight: 76,
  },
  circleCut: {
    width: 60,
    height: 60,
    borderRadius: 4,
    marginRight: 10,
  },
  noImage: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  noImageText: {
    fontSize: 22,
    fontWeight: 'bold',
  },
  info: {
    flex: 1,
    minWidth: 0,
    justifyContent: 'center',
  },
  space: {
    fontSize: 12,
    fontWeight: '700',
    marginBottom: 1,
  },
  name: {
    fontSize: 16,
    fontWeight: '600',
  },
  penname: {
    fontSize: 11,
    marginTop: 2,
  },
  memo: {
    fontSize: 11,
    marginTop: 1,
    fontStyle: 'italic',
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginLeft: 6,
  },
  actionBtn: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  statusBtn: {
    width: 36,
    height: 36,
    borderRadius: 6,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  statusIcon: {
    fontSize: 18,
    fontWeight: 'bold',
  },
});
