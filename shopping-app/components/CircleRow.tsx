import React from 'react';
import { StyleSheet, View, Text, Pressable } from 'react-native';
import { Image } from 'expo-image';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { PURCHASE_STATUS, PURCHASE_STATUS_LABELS } from '@/lib/types';
import { getColors } from '@/constants/Colors';
import { useTheme } from '@/lib/theme-context';
import { usePriorityColors } from '@/lib/priority-color-context';
import type { Circle } from '@/lib/types';

const DARK_PRIORITY_ROW_BASE = '#202638';
const LIGHT_PRIORITY_ROW_BASE = '#f2f5fb';

function normalizeHexColor(color: string): string | null {
  if (!/^#[0-9a-fA-F]{6}$/.test(color)) return null;
  return color;
}

function mixHexColor(color: string, weight: number, base: string): string {
  const normalizedColor = normalizeHexColor(color);
  const normalizedBase = normalizeHexColor(base);
  if (!normalizedColor || !normalizedBase) return base;
  const clampedWeight = Math.min(1, Math.max(0, weight));
  const read = (hex: string, start: number) => parseInt(hex.slice(start, start + 2), 16);
  const r = Math.round(read(normalizedColor, 1) * clampedWeight + read(normalizedBase, 1) * (1 - clampedWeight));
  const g = Math.round(read(normalizedColor, 3) * clampedWeight + read(normalizedBase, 3) * (1 - clampedWeight));
  const b = Math.round(read(normalizedColor, 5) * clampedWeight + read(normalizedBase, 5) * (1 - clampedWeight));
  return `rgb(${r},${g},${b})`;
}

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
  const isDone = circle.purchaseStatus !== PURCHASE_STATUS.NOT_YET;
  const isBought = circle.purchaseStatus === PURCHASE_STATUS.BOUGHT;
  const isCouldntBuy = circle.purchaseStatus === PURCHASE_STATUS.COULDNT_BUY;
  const isSkipped = circle.purchaseStatus === PURCHASE_STATUS.SKIPPED;

  // ホール + スペース番号
  const spaceLabel = [circle.hall, circle.space].filter(Boolean).join(' ');

  const imagePath = circle.circleCutFilename
    ? circle.circleCutFilename.startsWith('file://') || circle.circleCutFilename.startsWith('/')
      ? circle.circleCutFilename
      : null
    : null;

  // 購入済み行は薄く表示
  const rowOpacity = isBought ? 0.5 : isCouldntBuy || isSkipped ? 0.6 : 1;
  const priorityRowBg = mixHexColor(
    priority.color,
    effectiveScheme === 'dark' ? 0.14 : 0.12,
    effectiveScheme === 'dark' ? DARK_PRIORITY_ROW_BASE : LIGHT_PRIORITY_ROW_BASE
  );
  const priorityRowBorder = effectiveScheme === 'dark'
    ? 'rgba(255,255,255,0.05)'
    : 'rgba(15,23,42,0.08)';
  const priorityTintStrong = `${priority.color}${effectiveScheme === 'dark' ? '42' : '3d'}`;
  const priorityTintMid = `${priority.color}${effectiveScheme === 'dark' ? '28' : '24'}`;
  const priorityTintSoft = `${priority.color}${effectiveScheme === 'dark' ? '14' : '14'}`;
  const priorityMeterStrong = `${priority.color}${effectiveScheme === 'dark' ? '90' : '57'}`;
  const priorityMeterMid = `${priority.color}${effectiveScheme === 'dark' ? '38' : '1f'}`;

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
            backgroundColor: priorityRowBg,
            borderTopColor: priorityRowBorder,
            borderBottomColor: priorityRowBorder,
          },
        ]}
      >
        <View pointerEvents="none" style={[styles.priorityTintStrong, { backgroundColor: priorityTintStrong }]} />
        <View pointerEvents="none" style={[styles.priorityTintMid, { backgroundColor: priorityTintMid }]} />
        <View pointerEvents="none" style={[styles.priorityTintSoft, { backgroundColor: priorityTintSoft }]} />
        <Pressable
          style={[styles.row, { opacity: rowOpacity }]}
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
              <Text style={[styles.noImageText, { color: colors.textSecondary }]}>
                {circle.name.charAt(0)}
              </Text>
            </View>
          )}
        </Pressable>

        {/* テキスト情報 */}
        <View style={styles.info}>
          {/* スペース番号 (小さめ・上) */}
          {spaceLabel !== '' && (
            <Text style={[styles.space, { color: priority.color }]}>
              {spaceLabel}
            </Text>
          )}
          {/* サークル名 */}
          <Text
            style={[
              styles.name,
              { color: colors.text },
              isBought && { textDecorationLine: 'line-through' },
            ]}
            numberOfLines={1}
          >
            {circle.name}
          </Text>
          {/* ペンネーム */}
          {circle.penname && (
            <Text style={[styles.penname, { color: colors.textSecondary }]} numberOfLines={1}>
              {circle.penname}
            </Text>
          )}
          {/* メモ (あれば) */}
          {circle.memo !== '' && (
            <Text style={[styles.memo, { color: colors.textSecondary }]} numberOfLines={1}>
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
                    ? colors.tint
                    : colors.textSecondary
                }
              />
            </Pressable>
          )}

          {/* 購入状態トグル */}
          <Pressable
            style={[
              styles.statusBtn,
              { borderColor: statusInfo.color },
              isDone && { backgroundColor: statusInfo.color },
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
            <Text style={[styles.statusIcon, { color: isDone ? '#fff' : statusInfo.color }]}>{statusInfo.icon}</Text>
          </Pressable>
        </View>
        </Pressable>
        <View pointerEvents="none" style={styles.priorityMeter}>
          <View style={[styles.priorityMeterStrong, { backgroundColor: priorityMeterStrong }]} />
          <View style={[styles.priorityMeterMid, { backgroundColor: priorityMeterMid }]} />
        </View>
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
  priorityTintStrong: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    width: '24%',
  },
  priorityTintMid: {
    position: 'absolute',
    left: '24%',
    top: 0,
    bottom: 0,
    width: '20%',
  },
  priorityTintSoft: {
    position: 'absolute',
    left: '44%',
    top: 0,
    bottom: 0,
    width: '12%',
  },
  priorityMeter: {
    position: 'absolute',
    left: 12,
    right: 12,
    bottom: 0,
    height: 2,
    borderTopLeftRadius: 999,
    borderTopRightRadius: 999,
    overflow: 'hidden',
  },
  priorityMeterStrong: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    width: '54%',
  },
  priorityMeterMid: {
    position: 'absolute',
    left: '54%',
    top: 0,
    bottom: 0,
    width: '16%',
  },
  row: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    paddingLeft: 8,
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
