import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import type { ThemeColors } from "../constants/Colors";
import { PURCHASE_STATUS, PURCHASE_STATUS_LABELS, type Item, type PurchaseStatusValue } from "../lib/types";
import { formatItemPrice } from "../lib/item-purchase-menu";
import ItemPurchaseStatusMenu from "./ItemPurchaseStatusMenu";

interface Props {
  item: Item;
  colors: ThemeColors;
  isDark: boolean;
  isBoughtSomewhere: boolean;
  showReorder: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onEdit: (field: 'name' | 'price') => void;
  onDelete: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onStatusChange: (status: PurchaseStatusValue) => Promise<void>;
}

export default function ItemPurchaseRow({
  item, colors, isDark, isBoughtSomewhere, showReorder,
  canMoveUp, canMoveDown, onEdit, onDelete, onMoveUp, onMoveDown, onStatusChange,
}: Props) {
  const boughtColor = PURCHASE_STATUS_LABELS[PURCHASE_STATUS.BOUGHT].color;
  return (
    // 行全体をPressableにしない。スクロール・状態選択・並び替えを編集タップから分離する。
    <View
      testID="item-purchase-row"
      style={[
        styles.card,
        { borderBottomColor: colors.border },
        isBoughtSomewhere && { backgroundColor: isDark ? "rgba(46,125,50,0.16)" : "rgba(46,125,50,0.08)" },
      ]}
    >
      {showReorder && (
        <View style={styles.reorderButtons}>
          <Pressable
            style={[styles.reorderButton, !canMoveUp && { opacity: 0.2 }]}
            disabled={!canMoveUp}
            onPress={onMoveUp}
            accessibilityRole="button"
            accessibilityLabel={`${item.name}を上に移動`}
            accessibilityState={{ disabled: !canMoveUp }}
          >
            <Text style={[styles.reorderText, { color: colors.textSecondary }]}>▲</Text>
          </Pressable>
          <Pressable
            style={[styles.reorderButton, !canMoveDown && { opacity: 0.2 }]}
            disabled={!canMoveDown}
            onPress={onMoveDown}
            accessibilityRole="button"
            accessibilityLabel={`${item.name}を下に移動`}
            accessibilityState={{ disabled: !canMoveDown }}
          >
            <Text style={[styles.reorderText, { color: colors.textSecondary }]}>▼</Text>
          </Pressable>
        </View>
      )}
      <View style={styles.content}>
        <View style={styles.primaryLine}>
          <ScrollView
            testID="item-name-scroll"
            horizontal
            nestedScrollEnabled
            directionalLockEnabled
            showsHorizontalScrollIndicator
            persistentScrollbar
            style={styles.nameViewport}
            contentContainerStyle={styles.nameScrollContent}
          >
            <Pressable
              onPress={() => onEdit('name')}
              onLongPress={onDelete}
              accessibilityRole="button"
              accessibilityLabel={item.name}
              accessibilityHint="長い商品名は左右にスワイプして読めます。タップで編集、長押しで削除します"
            >
              <Text
                numberOfLines={1}
                style={[
                  styles.name,
                  { color: colors.text },
                  item.purchaseStatus === PURCHASE_STATUS.BOUGHT && { textDecorationLine: "line-through", opacity: 0.5 },
                ]}
              >
                {item.name}
              </Text>
            </Pressable>
          </ScrollView>
          {/* 金額は名前のスクロール領域の外。長い名前・分類に押し出されない。 */}
          <Pressable
            testID="item-price"
            style={styles.priceSlot}
            onPress={() => onEdit('price')}
            onLongPress={onDelete}
            accessibilityRole="button"
            accessibilityLabel={`${item.name}、${formatItemPrice(item.price)}。編集`}
          >
            <Text numberOfLines={1} adjustsFontSizeToFit style={styles.price}>
              {formatItemPrice(item.price)}
            </Text>
          </Pressable>
        </View>
        {(item.type || isBoughtSomewhere) && (
          <Pressable style={styles.metadata} onPress={() => onEdit('name')} onLongPress={onDelete} accessibilityRole="button" accessibilityLabel={`${item.name}の詳細を編集`}>
            {item.type && (
              <Text numberOfLines={1} style={[styles.type, { color: colors.textSecondary, backgroundColor: colors.background }]}>
                {item.type}
              </Text>
            )}
            {isBoughtSomewhere && (
              <Text style={[styles.purchasedBadge, { color: boughtColor, borderColor: boughtColor }]}>
                購入済み
              </Text>
            )}
          </Pressable>
        )}
      </View>
      <ItemPurchaseStatusMenu itemName={item.name} status={item.purchaseStatus} colors={colors} onChange={onStatusChange} />
    </View>
  );
}

const styles = StyleSheet.create({
  card: { flexDirection: "row", alignItems: "center", paddingVertical: 5, paddingHorizontal: 4, borderBottomWidth: StyleSheet.hairlineWidth, borderRadius: 4 },
  content: { flex: 1, minWidth: 0, overflow: "hidden" },
  primaryLine: { flexDirection: "row", alignItems: "center", minWidth: 0 },
  nameViewport: { flex: 1, minWidth: 0, overflow: "hidden" },
  nameScrollContent: { alignItems: "center", minHeight: 28, paddingBottom: 3 },
  name: { fontSize: 13, fontWeight: "600" },
  priceSlot: { flexShrink: 0, paddingLeft: 6, maxWidth: "100%", justifyContent: "center", minHeight: 28 },
  price: { fontSize: 12, fontWeight: "600", color: "#e65100" },
  metadata: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 4, paddingTop: 2 },
  type: { maxWidth: "100%", flexShrink: 1, fontSize: 10, paddingHorizontal: 4, paddingVertical: 1, borderRadius: 3 },
  purchasedBadge: { fontSize: 10, fontWeight: "700", paddingHorizontal: 5, paddingVertical: 1, borderRadius: 3, borderWidth: 1 },
  reorderButtons: { flexShrink: 0, marginRight: 4 },
  reorderButton: { minWidth: 22, minHeight: 22, alignItems: "center", justifyContent: "center" },
  reorderText: { fontSize: 10, fontWeight: "600" },
});
