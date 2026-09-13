import { useEffect, useRef, useState } from "react";
import {
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { ThemeColors } from "../constants/Colors";
import {
  PURCHASE_STATUS,
  PURCHASE_STATUS_LABELS,
  type PurchaseStatusValue,
} from "../lib/types";
import {
  getItemPurchaseMenuLayout,
  ITEM_PURCHASE_OPTIONS,
  itemPurchaseStatusLabel,
  type MenuAnchor,
} from "../lib/item-purchase-menu";

interface Props {
  itemName: string;
  status: PurchaseStatusValue;
  colors: ThemeColors;
  onChange: (status: PurchaseStatusValue) => Promise<void>;
}

export default function ItemPurchaseStatusMenu({ itemName, status, colors, onChange }: Props) {
  const triggerRef = useRef<View>(null);
  const mountedRef = useRef(true);
  const requestRef = useRef(0);
  const savingRef = useRef(false);
  const [saving, setSaving] = useState(false);
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null);
  const [menuHeight, setMenuHeight] = useState(0);
  const { width, height, fontScale } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const statusInfo = PURCHASE_STATUS_LABELS[status];
  const isNotYet = status === PURCHASE_STATUS.NOT_YET;
  const statusColor = isNotYet ? colors.textSecondary : statusInfo.color;

  function closeMenu() {
    requestRef.current += 1;
    setAnchor(null);
  }

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestRef.current += 1;
    };
  }, []);

  // 回転・文字サイズ変更後に古い座標のメニューを残さない。
  useEffect(() => {
    closeMenu();
  }, [width, height, fontScale]);

  function openMenu() {
    if (savingRef.current) return;
    const request = ++requestRef.current;
    triggerRef.current?.measureInWindow((x, y, measuredWidth, measuredHeight) => {
      if (!mountedRef.current || request !== requestRef.current) return;
      if (measuredWidth <= 0 || measuredHeight <= 0) return;
      setMenuHeight(0);
      setAnchor({ x, y, width: measuredWidth, height: measuredHeight });
    });
  }

  async function selectStatus(nextStatus: PurchaseStatusValue) {
    if (savingRef.current) return;
    closeMenu();
    if (nextStatus === status) return;
    savingRef.current = true;
    setSaving(true);
    try {
      await onChange(nextStatus);
    } catch {
      if (mountedRef.current) {
        Alert.alert(
          "購入状態を更新できませんでした",
          "更新中にエラーが発生しました。内容を確認して、もう一度お試しください。",
        );
      }
    } finally {
      savingRef.current = false;
      if (mountedRef.current) setSaving(false);
    }
  }

  const options = isNotYet
    ? ITEM_PURCHASE_OPTIONS
    : [...ITEM_PURCHASE_OPTIONS, { value: PURCHASE_STATUS.NOT_YET, label: "未購入に戻す" }];
  const layout = anchor
    ? getItemPurchaseMenuLayout(
        anchor,
        { width, height },
        insets,
        menuHeight || (80 + options.length * 56) * Math.max(1, fontScale),
      )
    : null;

  return (
    <>
      <Pressable
        ref={triggerRef}
        testID="item-purchase-status-trigger"
        style={styles.trigger}
        disabled={saving}
        onPress={openMenu}
        accessibilityRole="button"
        accessibilityLabel={`${itemName}の購入状態: ${itemPurchaseStatusLabel(status)}`}
        accessibilityHint="タップして購入状態の選択メニューを開きます"
        accessibilityState={{ expanded: anchor != null, disabled: saving, busy: saving }}
      >
        <View
          pointerEvents="none"
          style={[
            styles.circle,
            { borderColor: statusColor, backgroundColor: isNotYet ? "transparent" : statusColor },
            saving && { opacity: 0.5 },
          ]}
        >
          <Text allowFontScaling={false} style={[styles.icon, { color: isNotYet ? statusColor : "#fff" }]}>
            {isNotYet ? "▾" : statusInfo.icon}
          </Text>
          {!isNotYet && (
            <Text allowFontScaling={false} style={[styles.caret, { color: colors.text, backgroundColor: colors.card }]}>
              ▾
            </Text>
          )}
        </View>
      </Pressable>
      {anchor && layout && (
        <Modal
          transparent
          visible
          animationType="fade"
          statusBarTranslucent
          navigationBarTranslucent
          presentationStyle="overFullScreen"
          onRequestClose={closeMenu}
        >
          <View style={styles.overlay}>
            <Pressable
              testID="item-purchase-status-backdrop"
              style={StyleSheet.absoluteFill}
              onPress={closeMenu}
              accessibilityRole="button"
              accessibilityLabel="購入状態メニューを閉じる"
            />
            <View
              testID="item-purchase-status-menu"
              style={[styles.menu, layout, { backgroundColor: colors.card, borderColor: colors.border }]}
              onLayout={(event) => setMenuHeight(event.nativeEvent.layout.height)}
              accessibilityViewIsModal
              onAccessibilityEscape={closeMenu}
            >
              <ScrollView style={styles.menuScroll} bounces={false} keyboardShouldPersistTaps="handled">
                <View style={[styles.heading, { borderBottomColor: colors.border }]}>
                  <Text accessibilityRole="header" style={[styles.headingText, { color: colors.text }]}>
                    購入状態
                  </Text>
                  <Text numberOfLines={2} style={[styles.itemName, { color: colors.textSecondary }]}>
                    {itemName}
                  </Text>
                </View>
                {options.map(({ value, label }) => {
                  const info = PURCHASE_STATUS_LABELS[value];
                  const selected = value === status;
                  const reset = value === PURCHASE_STATUS.NOT_YET;
                  const color = reset ? colors.textSecondary : info.color;
                  return (
                    <Pressable
                      key={value}
                      testID={`item-purchase-status-option-${value}`}
                      accessibilityRole="radio"
                      accessibilityLabel={label}
                      accessibilityState={{ checked: selected }}
                      onPress={() => { void selectStatus(value); }}
                      style={({ pressed }) => [
                        styles.option,
                        reset && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
                        (pressed || selected) && { backgroundColor: colors.backgroundSecondary },
                      ]}
                    >
                      <Text allowFontScaling={false} style={[styles.optionIcon, { color }]}>{info.icon}</Text>
                      <Text style={[styles.optionLabel, { color: colors.text }]}>{label}</Text>
                      {selected && <Text style={[styles.selectedMark, { color: colors.tint }]}>✓</Text>}
                    </Pressable>
                  );
                })}
              </ScrollView>
            </View>
          </View>
        </Modal>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  // 見た目は既存と同じ28dp。実際のタップ領域だけ44dpを確保する。
  trigger: { width: 44, height: 44, flexShrink: 0, alignItems: "center", justifyContent: "center" },
  circle: { width: 28, height: 28, borderRadius: 14, borderWidth: 1.5, alignItems: "center", justifyContent: "center" },
  icon: { fontSize: 14, fontWeight: "bold" },
  caret: { position: "absolute", bottom: -3, right: -4, fontSize: 10, lineHeight: 12, borderRadius: 6, width: 12, textAlign: "center" },
  overlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.25)" },
  menu: { position: "absolute", borderRadius: 12, borderWidth: 1, overflow: "hidden", elevation: 8, shadowColor: "#000", shadowOpacity: 0.2, shadowRadius: 8, shadowOffset: { width: 0, height: 4 } },
  menuScroll: { flexGrow: 0, flexShrink: 1 },
  heading: { paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, gap: 4 },
  headingText: { fontSize: 15, fontWeight: "700" },
  itemName: { fontSize: 12 },
  option: { minHeight: 56, paddingHorizontal: 16, paddingVertical: 12, flexDirection: "row", alignItems: "center", gap: 12 },
  optionIcon: { width: 24, fontSize: 22, textAlign: "center" },
  optionLabel: { flex: 1, minWidth: 0, fontSize: 16, fontWeight: "600" },
  selectedMark: { fontSize: 18, fontWeight: "700" },
});
