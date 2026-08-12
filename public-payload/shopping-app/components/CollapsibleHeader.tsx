import { useState } from 'react';
import {
  StyleSheet,
  View,
  Text,
  Pressable,
  TextInput,
  ScrollView,
  LayoutAnimation,
} from 'react-native';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { getColors } from '@/constants/Colors';
import { useTheme } from '@/lib/theme-context';
import { PURCHASE_STATUS, PURCHASE_STATUS_LABELS, CIRCLE_GENRES } from '@/lib/types';
import { usePriorityColors } from '@/lib/priority-color-context';
import { prioritySortRank } from '@/lib/priority-colors';
import type { PurchaseStatusValue, SortField, BudgetSummary } from '@/lib/types';

const SORT_OPTIONS: { key: SortField; label: string }[] = [
  { key: 'space', label: 'スペース順' },
  { key: 'name', label: '名前順' },
  { key: 'priority', label: '優先度順' },
  { key: 'favorite', label: 'お気に入り順' },
];

function formatPrice(n: number): string {
  return n > 0 ? `¥${n.toLocaleString()}` : '¥0';
}

interface CollapsibleHeaderProps {
  // フィルター状態
  globalSearchEnabled: boolean;
  searchQuery: string;
  onSearchChange: (q: string) => void;
  statusFilter: PurchaseStatusValue | null;
  onStatusFilterChange: (v: PurchaseStatusValue | null) => void;
  sortBy: SortField;
  onSortChange: (v: SortField) => void;
  priorityFilter: Set<number>;
  onTogglePriorityFilter: (v: number) => void;
  hallFilter: string | null;
  onHallFilterChange: (v: string | null) => void;
  halls: string[];
  genreFilter: string | null;
  onGenreFilterChange: (v: string | null) => void;
  catalogPostOnly: boolean;
  onCatalogPostOnlyChange: (v: boolean) => void;
  hideSkipped: boolean;
  onHideSkippedChange: (v: boolean) => void;
  onClearPriorityFilter: () => void;
  // 進捗
  stats: {
    totalCircles: number;
    boughtCircles: number;
    couldntBuyCircles: number;
    skippedCircles: number;
    remainingCircles: number;
  };
  budget: BudgetSummary;
  filteredCount: number;
  totalCount: number;
  // インポート（nullならボタン非表示）
  onImport?: (() => void) | null;
  // 買い物モード
  isShoppingMode: boolean;
  elapsedTime: string;
}

export default function CollapsibleHeader({
  globalSearchEnabled,
  searchQuery, onSearchChange,
  statusFilter, onStatusFilterChange,
  sortBy, onSortChange,
  priorityFilter, onTogglePriorityFilter,
  hallFilter, onHallFilterChange,
  halls,
  genreFilter, onGenreFilterChange,
  catalogPostOnly, onCatalogPostOnlyChange,
  hideSkipped, onHideSkippedChange,
  onClearPriorityFilter,
  stats, budget,
  filteredCount, totalCount,
  onImport,
  isShoppingMode, elapsedTime,
}: CollapsibleHeaderProps) {
  const { effectiveScheme } = useTheme();
  const colors = getColors(effectiveScheme);
  const { options: priorityOptions, getColor } = usePriorityColors();
  const [expanded, setExpanded] = useState(false);
  const [showBudget, setShowBudget] = useState(false);
  const totalForProgress = stats.totalCircles || 1;
  const boughtPct = (stats.boughtCircles / totalForProgress) * 100;
  const couldntPct = (stats.couldntBuyCircles / totalForProgress) * 100;
  const skippedPct = (stats.skippedCircles / totalForProgress) * 100;
  const boughtColor = PURCHASE_STATUS_LABELS[PURCHASE_STATUS.BOUGHT].color;
  const couldntBuyColor = PURCHASE_STATUS_LABELS[PURCHASE_STATUS.COULDNT_BUY].color;
  const skippedColor = PURCHASE_STATUS_LABELS[PURCHASE_STATUS.SKIPPED].color;

  function toggleExpand() {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setExpanded(!expanded);
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.card, borderBottomColor: colors.border }]}>
      {/* 常時表示の行: インポート + 買い物状態 + 展開ボタン */}
      <View style={styles.topRow}>
        {onImport && (
          <Pressable style={[styles.importBtn, { backgroundColor: colors.tint }]} onPress={onImport}>
            <FontAwesome name="plus" size={14} color="#fff" />
          </Pressable>
        )}

        {isShoppingMode && (
          <View style={styles.shoppingBadge}>
            <Text style={styles.shoppingBadgeText}>買い物中</Text>
            {elapsedTime !== '' && <Text style={styles.shoppingBadgeTime}> {elapsedTime}</Text>}
          </View>
        )}

        {/* 進捗ミニ表示 */}
        {totalCount > 0 && (
          <Text style={[styles.miniProgress, { color: colors.textSecondary }]}>
            {stats.boughtCircles}/{stats.totalCircles}
          </Text>
        )}

        <View style={{ flex: 1 }} />

        <Pressable style={styles.expandBtn} onPress={toggleExpand}>
          <FontAwesome name={expanded ? 'chevron-up' : 'filter'} size={14} color={colors.textSecondary} />
        </Pressable>
      </View>

      {globalSearchEnabled && (
        <View style={styles.globalSearchRow}>
          <TextInput
            style={[styles.searchInput, {
              borderColor: colors.border,
              backgroundColor: colors.inputBackground,
              color: colors.text,
            }]}
            placeholder="サークル名・ペンネーム・アイテム名・メモで検索"
            placeholderTextColor={colors.textSecondary}
            value={searchQuery}
            onChangeText={onSearchChange}
            clearButtonMode="while-editing"
          />
        </View>
      )}

      {/* 展開部分 */}
      {expanded && (
        <View style={styles.expandedContent}>
          {/* 進捗バー */}
          {stats.totalCircles > 0 && (
            <>
              <View style={[styles.progressBar, { backgroundColor: colors.border }]}>
                <View style={[styles.progressFill, { backgroundColor: boughtColor, width: `${boughtPct}%`, position: 'absolute', left: 0 }]} />
                <View style={[styles.progressFill, { backgroundColor: couldntBuyColor, width: `${couldntPct}%`, position: 'absolute', left: `${boughtPct}%` }]} />
                <View style={[styles.progressFill, { backgroundColor: skippedColor, width: `${skippedPct}%`, position: 'absolute', left: `${boughtPct + couldntPct}%` }]} />
              </View>
              <View style={styles.statsRow}>
                <Text style={[styles.statItem, { color: boughtColor }]}>買えた {stats.boughtCircles}</Text>
                <Text style={[styles.statItem, { color: couldntBuyColor }]}>買えなかった {stats.couldntBuyCircles}</Text>
                <Text style={[styles.statItem, { color: skippedColor }]}>見送り {stats.skippedCircles}</Text>
                <Text style={[styles.statItem, { color: colors.textSecondary }]}>残り {stats.remainingCircles}</Text>
                {budget.totalListPrice > 0 && (
                  <Pressable onPress={() => setShowBudget((v) => !v)}>
                    <Text style={[styles.statItem, { color: colors.tint, fontWeight: '600' }]}>
                      {showBudget ? '▲ 金額' : '▼ 金額'}
                    </Text>
                  </Pressable>
                )}
              </View>
            </>
          )}

          {/* 予算 */}
          {showBudget && budget.totalListPrice > 0 && (
            <View style={[styles.budgetCard, { backgroundColor: colors.backgroundSecondary, borderColor: colors.border }]}>
              <View style={styles.budgetRow}>
                <Text style={[styles.budgetLabel, { color: colors.textSecondary }]}>リスト総額</Text>
                <Text style={[styles.budgetValue, { color: colors.text }]}>{formatPrice(budget.totalListPrice)}</Text>
              </View>
              <View style={styles.budgetRow}>
                <Text style={[styles.budgetLabel, { color: colors.textSecondary }]}>予定</Text>
                <Text style={[styles.budgetValue, { color: colors.text }]}>{formatPrice(budget.totalPlanned)}</Text>
              </View>
              <View style={styles.budgetRow}>
                <Text style={[styles.budgetLabel, { color: boughtColor }]}>購入済み</Text>
                <Text style={[styles.budgetValue, { color: boughtColor }]}>{formatPrice(budget.totalBought)}</Text>
              </View>
              <View style={styles.budgetRow}>
                <Text style={[styles.budgetLabel, { color: couldntBuyColor }]}>買えなかった</Text>
                <Text style={[styles.budgetValue, { color: couldntBuyColor }]}>{formatPrice(budget.totalCouldntBuy)}</Text>
              </View>
              <View style={styles.budgetRow}>
                <Text style={[styles.budgetLabel, { color: skippedColor }]}>見送り</Text>
                <Text style={[styles.budgetValue, { color: skippedColor }]}>{formatPrice(budget.totalSkipped)}</Text>
              </View>
              <View style={styles.budgetRow}>
                <Text style={[styles.budgetLabel, { color: colors.textSecondary }]}>残り</Text>
                <Text style={[styles.budgetValue, { color: colors.text }]}>{formatPrice(budget.totalRemaining)}</Text>
              </View>
              {budget.byPriority.length > 0 && (
                <View style={styles.budgetPrioritySection}>
                  <Text style={[styles.budgetSubTitle, { color: colors.textSecondary }]}>優先度別</Text>
                  {budget.byPriority
                    .sort((a, b) => prioritySortRank(b.priorityColor) - prioritySortRank(a.priorityColor))
                    .map((p) => {
                      const pri = getColor(p.priorityColor);
                      if (!pri) return null;
                      return (
                        <View key={p.priorityColor} style={styles.budgetPriorityRow}>
                          <View style={[styles.budgetPriorityDot, { backgroundColor: pri.color }]} />
                          <Text style={[styles.budgetPriorityLabel, { color: pri.color }]}>{pri.label}</Text>
                          <Text style={[styles.budgetPriorityCount, { color: colors.textSecondary }]}>{p.circleCount}件</Text>
                          <Text style={[styles.budgetPriorityValue, { color: colors.text }]}>{formatPrice(p.planned)} / 総額 {formatPrice(p.total)}</Text>
                        </View>
                      );
                    })}
                </View>
              )}
            </View>
          )}

          {!globalSearchEnabled && (
            <TextInput
              style={[styles.searchInput, styles.filterSearchInput, {
                borderColor: colors.border,
                backgroundColor: colors.inputBackground,
                color: colors.text,
              }]}
              placeholder="サークル名・スペースで検索"
              placeholderTextColor={colors.textSecondary}
              value={searchQuery}
              onChangeText={onSearchChange}
              clearButtonMode="while-editing"
            />
          )}

          {/* フィルター・ソートチップ */}
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipScroll} contentContainerStyle={styles.chipContent}>
            {/* ステータス */}
            <Pressable
              style={[styles.chip, { borderColor: colors.border }, statusFilter === null && { backgroundColor: colors.tint, borderColor: colors.tint }]}
              onPress={() => onStatusFilterChange(null)}
            >
              <Text style={[styles.chipText, { color: colors.textSecondary }, statusFilter === null && { color: '#fff' }]}>全て</Text>
            </Pressable>
            {([PURCHASE_STATUS.NOT_YET, PURCHASE_STATUS.BOUGHT, PURCHASE_STATUS.COULDNT_BUY, PURCHASE_STATUS.SKIPPED] as PurchaseStatusValue[]).map((s) => {
              const info = PURCHASE_STATUS_LABELS[s];
              const isActive = statusFilter === s;
              return (
                <Pressable key={s} style={[styles.chip, { borderColor: info.color }, isActive && { backgroundColor: info.color }]} onPress={() => onStatusFilterChange(isActive ? null : s)}>
                  <Text style={[styles.chipText, { color: isActive ? '#fff' : info.color }]}>{info.label}</Text>
                </Pressable>
              );
            })}

            <View style={[styles.chipDivider, { backgroundColor: colors.border }]} />

            {/* ソート */}
            {SORT_OPTIONS.map((opt) => (
              <Pressable
                key={opt.key}
                style={[styles.chip, { borderColor: colors.border }, sortBy === opt.key && { backgroundColor: colors.tint, borderColor: colors.tint }]}
                onPress={() => onSortChange(opt.key)}
              >
                <Text style={[styles.chipText, { color: colors.textSecondary }, sortBy === opt.key && { color: '#fff' }]}>{opt.label}</Text>
              </Pressable>
            ))}

            {/* 優先度 */}
            <View style={[styles.chipDivider, { backgroundColor: colors.border }]} />
            {priorityOptions.map((opt) => {
              const isActive = priorityFilter.has(opt.value);
              return (
                <Pressable
                  key={opt.value}
                  style={[
                    styles.priorityChip, { borderColor: opt.color },
                    isActive && { backgroundColor: opt.bgColor },
                    !isActive && priorityFilter.size > 0 && { opacity: 0.4 },
                  ]}
                  onPress={() => onTogglePriorityFilter(opt.value)}
                >
                  <View style={[styles.priorityChipDot, { backgroundColor: opt.color }]} />
                  <Text style={[styles.chipText, { color: opt.color }]}>{opt.label}</Text>
                </Pressable>
              );
            })}

            <View style={[styles.chipDivider, { backgroundColor: colors.border }]} />
            <Pressable
              style={[styles.chip, { borderColor: colors.border }, catalogPostOnly && { backgroundColor: colors.tint, borderColor: colors.tint }]}
              onPress={() => onCatalogPostOnlyChange(!catalogPostOnly)}
            >
              <FontAwesome
                name="image"
                size={11}
                color={catalogPostOnly ? "#fff" : colors.textSecondary}
              />
              <Text style={[styles.chipText, { color: colors.textSecondary }, catalogPostOnly && { color: "#fff" }]}>おしながき</Text>
            </Pressable>

            {/* ジャンル */}
            <View style={[styles.chipDivider, { backgroundColor: colors.border }]} />
            <Pressable
              style={[
                styles.chip,
                { borderColor: PURCHASE_STATUS_LABELS[PURCHASE_STATUS.SKIPPED].color },
                hideSkipped && {
                  backgroundColor: PURCHASE_STATUS_LABELS[PURCHASE_STATUS.SKIPPED].color,
                  borderColor: PURCHASE_STATUS_LABELS[PURCHASE_STATUS.SKIPPED].color,
                },
              ]}
              onPress={() => onHideSkippedChange(!hideSkipped)}
            >
              <Text
                style={[
                  styles.chipText,
                  {
                    color: hideSkipped
                      ? "#fff"
                      : PURCHASE_STATUS_LABELS[PURCHASE_STATUS.SKIPPED].color,
                  },
                ]}
              >
                見送り非表示
              </Text>
            </Pressable>

            <View style={[styles.chipDivider, { backgroundColor: colors.border }]} />
            <Pressable
              style={[styles.chip, { borderColor: colors.border }, genreFilter === null && { opacity: 0.5 }]}
              onPress={() => onGenreFilterChange(null)}
            >
              <Text style={[styles.chipText, { color: colors.textSecondary }]}>全ジャンル</Text>
            </Pressable>
            {CIRCLE_GENRES.map((g) => (
              <Pressable
                key={g}
                style={[styles.chip, { borderColor: colors.border }, genreFilter === g && { backgroundColor: colors.tint, borderColor: colors.tint }]}
                onPress={() => onGenreFilterChange(genreFilter === g ? null : g)}
              >
                <Text style={[styles.chipText, { color: colors.textSecondary }, genreFilter === g && { color: '#fff' }]}>{g}</Text>
              </Pressable>
            ))}

            {/* ホール */}
            {halls.length > 1 && (
              <>
                <View style={[styles.chipDivider, { backgroundColor: colors.border }]} />
                <Pressable
                  style={[styles.chip, { borderColor: colors.border }, hallFilter === null && { backgroundColor: colors.tint + '20', borderColor: colors.tint }]}
                  onPress={() => onHallFilterChange(null)}
                >
                  <Text style={[styles.chipText, { color: colors.textSecondary }, hallFilter === null && { color: colors.tint, fontWeight: '600' }]}>全ホール</Text>
                </Pressable>
                {halls.map((hall) => (
                  <Pressable
                    key={hall}
                    style={[styles.chip, { borderColor: colors.border }, hallFilter === hall && { backgroundColor: colors.tint, borderColor: colors.tint }]}
                    onPress={() => onHallFilterChange(hall)}
                  >
                    <Text style={[styles.chipText, { color: colors.textSecondary }, hallFilter === hall && { color: '#fff' }]}>{hall}</Text>
                  </Pressable>
                ))}
              </>
            )}
          </ScrollView>

          {/* 件数表示 */}
          <View style={styles.countRow}>
            <Text style={[styles.countText, { color: colors.textSecondary }]}>
              {filteredCount}件表示
              {filteredCount !== totalCount && ` / 全${totalCount}件`}
            </Text>
            {(priorityFilter.size > 0 || statusFilter !== null || genreFilter !== null || catalogPostOnly || hideSkipped) && (
              <Pressable onPress={() => { onStatusFilterChange(null); onGenreFilterChange(null); onCatalogPostOnlyChange(false); onHideSkippedChange(false); onClearPriorityFilter(); }}>
                <Text style={[styles.clearFilterText, { color: colors.tint }]}>フィルター解除</Text>
              </Pressable>
            )}
          </View>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 8,
  },
  importBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  shoppingBadge: {
    backgroundColor: '#e65100',
    flexDirection: 'row',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 8,
  },
  shoppingBadgeText: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '700',
  },
  shoppingBadgeTime: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '500',
  },
  miniProgress: {
    fontSize: 13,
    fontWeight: '600',
  },
  expandBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  expandedContent: {
    paddingHorizontal: 12,
    paddingBottom: 8,
  },
  globalSearchRow: {
    paddingHorizontal: 12,
    paddingBottom: 8,
  },
  progressBar: {
    height: 4,
    borderRadius: 2,
    marginBottom: 4,
    position: 'relative',
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    borderRadius: 2,
  },
  statsRow: {
    flexDirection: 'row',
    paddingBottom: 6,
    gap: 10,
    alignItems: 'center',
  },
  statItem: {
    fontSize: 11,
    fontWeight: '500',
  },
  budgetCard: {
    marginBottom: 6,
    padding: 10,
    borderRadius: 8,
    borderWidth: 1,
  },
  budgetRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 2,
  },
  budgetLabel: { fontSize: 12 },
  budgetValue: { fontSize: 12, fontWeight: '600' },
  budgetPrioritySection: {
    marginTop: 6,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#e0e0e0',
    paddingTop: 6,
  },
  budgetSubTitle: { fontSize: 11, fontWeight: '600', marginBottom: 3 },
  budgetPriorityRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 1,
  },
  budgetPriorityDot: { width: 6, height: 6, borderRadius: 3 },
  budgetPriorityLabel: { fontSize: 11, fontWeight: '600', width: 45 },
  budgetPriorityCount: { fontSize: 10, width: 28 },
  budgetPriorityValue: { fontSize: 11, fontWeight: '600', flex: 1, textAlign: 'right' },
  searchInput: {
    height: 34,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    fontSize: 14,
  },
  filterSearchInput: {
    marginBottom: 6,
  },
  chipScroll: {
    maxHeight: 36,
    marginBottom: 4,
  },
  chipContent: {
    gap: 6,
    alignItems: 'center',
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    borderWidth: 1,
  },
  chipText: {
    fontSize: 11,
  },
  chipDivider: {
    width: 1,
    height: 16,
    marginHorizontal: 2,
  },
  priorityChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 12,
    borderWidth: 1.5,
  },
  priorityChipDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  countRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  countText: {
    fontSize: 11,
  },
  clearFilterText: {
    fontSize: 11,
    fontWeight: '600',
  },
});
