import React from 'react';
import { StyleSheet, View, Text, Pressable, type ColorSchemeName } from 'react-native';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { getColors } from '@/constants/Colors';
import { PURCHASE_STATUS, PURCHASE_STATUS_LABELS } from '@/lib/types';
import type { Event } from '@/lib/types';

interface EventStats {
  totalCircles: number;
  boughtCircles: number;
  couldntBuyCircles: number;
  skippedCircles: number;
  remainingCircles: number;
}

interface EventCardProps {
  event: Event;
  stats: EventStats;
  isExpanded: boolean;
  onPress: () => void;
  onLongPress: () => void;
  colorScheme?: ColorSchemeName;
}

export default function EventCard({
  event,
  stats,
  isExpanded,
  onPress,
  onLongPress,
  colorScheme,
}: EventCardProps) {
  const colors = getColors(colorScheme);
  const skippedColor = PURCHASE_STATUS_LABELS[PURCHASE_STATUS.SKIPPED].color;
  const isShoppingActive = event.shoppingStartedAt != null && event.shoppingEndedAt == null;
  const isCompleted = event.completed;
  const progress = stats.totalCircles > 0 ? (stats.boughtCircles / stats.totalCircles) * 100 : 0;
  const couldntProgress = stats.totalCircles > 0 ? (stats.couldntBuyCircles / stats.totalCircles) * 100 : 0;
  const skippedProgress = stats.totalCircles > 0 ? (stats.skippedCircles / stats.totalCircles) * 100 : 0;

  return (
    <Pressable
      style={[
        styles.card,
        { backgroundColor: colors.card, borderBottomColor: colors.border },
        isExpanded && { backgroundColor: colors.tint + '10', borderLeftColor: colors.tint, borderLeftWidth: 3 },
        isCompleted && { opacity: 0.45 },
      ]}
      onPress={onPress}
      onLongPress={onLongPress}
    >
      <View style={styles.headerRow}>
        <View style={styles.titleArea}>
          <Text style={[styles.eventName, { color: colors.text }]} numberOfLines={1}>
            {event.name}
          </Text>
          {isCompleted && (
            <View style={styles.completedBadge}>
              <Text style={styles.completedBadgeText}>完了</Text>
            </View>
          )}
          {isShoppingActive && (
            <View style={styles.shoppingBadge}>
              <Text style={styles.shoppingBadgeText}>買い物中</Text>
            </View>
          )}
        </View>
        <FontAwesome
          name={isExpanded ? 'chevron-up' : 'chevron-down'}
          size={12}
          color={colors.textSecondary}
        />
      </View>

      {/* メタ情報 */}
      <View style={styles.metaRow}>
        {event.date && (
          <Text style={[styles.metaText, { color: colors.textSecondary }]}>{event.date}</Text>
        )}
        {event.venue && (
          <Text style={[styles.metaText, { color: colors.textSecondary }]}> / {event.venue}</Text>
        )}
      </View>

      {/* 進捗 */}
      <View style={styles.progressRow}>
        <View style={[styles.progressBar, { backgroundColor: colors.border }]}>
          {stats.totalCircles > 0 && (
            <>
              <View style={[styles.progressFill, { backgroundColor: '#2e7d32', width: `${progress}%`, position: 'absolute', left: 0 }]} />
              <View style={[styles.progressFill, { backgroundColor: '#c62828', width: `${couldntProgress}%`, position: 'absolute', left: `${progress}%` }]} />
              <View style={[styles.progressFill, { backgroundColor: skippedColor, width: `${skippedProgress}%`, position: 'absolute', left: `${progress + couldntProgress}%` }]} />
            </>
          )}
        </View>
        <Text style={[styles.progressText, { color: colors.textSecondary }]}>
          {stats.boughtCircles}/{stats.totalCircles}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  titleArea: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    gap: 8,
  },
  eventName: {
    fontSize: 16,
    fontWeight: '700',
    flexShrink: 1,
  },
  completedBadge: {
    backgroundColor: '#616161',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 8,
  },
  completedBadgeText: {
    color: '#fff',
    fontSize: 10,
    fontWeight: '700',
  },
  shoppingBadge: {
    backgroundColor: '#e65100',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 8,
  },
  shoppingBadgeText: {
    color: '#fff',
    fontSize: 10,
    fontWeight: '700',
  },
  metaRow: {
    flexDirection: 'row',
    marginTop: 2,
  },
  metaText: {
    fontSize: 12,
  },
  progressRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 6,
    gap: 8,
  },
  progressBar: {
    flex: 1,
    height: 4,
    borderRadius: 2,
    position: 'relative',
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    borderRadius: 2,
  },
  progressText: {
    fontSize: 12,
    fontWeight: '600',
    minWidth: 48,
    textAlign: 'right',
  },
});
