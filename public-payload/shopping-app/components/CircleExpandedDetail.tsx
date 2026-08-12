import { useEffect, useState, useMemo } from "react";
import {
  StyleSheet,
  View,
  Text,
  Pressable,
  TextInput,
  ScrollView,
  Linking,
  ActivityIndicator,
  Alert,
  Modal,
} from "react-native";
import {
  reprocessCircleFromPost,
  extractTweetId,
} from "@/lib/crawl/post-reprocess";
import { Image } from "expo-image";
import FontAwesome from "@expo/vector-icons/FontAwesome";
import {
  getItemsByCircle,
  getItemImagesByCircle,
  updateCircleMemo,
  addItem,
  deleteItem,
  updateItem,
  updateItemPurchaseStatus,
  reorderItem,
  pickAndReplaceItemImage,
  pickAndAddItemImage,
  getBoughtItemNameKeysForCircle,
  normalizePurchaseLookupKey,
} from "@/lib/database";
import { useEvent } from "@/lib/event-context";
import { useTheme } from "@/lib/theme-context";
import { getColors } from "@/constants/Colors";
import {
  PURCHASE_STATUS,
  PURCHASE_STATUS_LABELS,
  ITEM_CATEGORIES,
} from "@/lib/types";
import ImageViewer from "@/components/ImageViewer";
import type { Circle, Item, ItemImage, PurchaseStatusValue } from "@/lib/types";

// M6: タグからURLでない文言を除去し、URLのみを返す
function extractUrls(tags: string[]): { urls: string[]; others: string[] } {
  const urls: string[] = [];
  const others: string[] = [];
  for (const t of tags) {
    if (/^https?:\/\//.test(t.trim())) {
      urls.push(t.trim());
    } else {
      // 【おしながきツイート】などの文言はスキップ
      if (!/^[\u3010\u3011【】]/.test(t.trim()) && t.trim()) {
        others.push(t.trim());
      }
    }
  }
  return { urls, others };
}

// メモのURL自動リンク化
function renderMemoWithLinks(
  text: string,
  linkColor: string,
  textColor: string,
) {
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  const parts = text.split(urlRegex);
  if (parts.length === 1)
    return <Text style={[styles.memoText, { color: textColor }]}>{text}</Text>;
  return (
    <Text style={[styles.memoText, { color: textColor }]}>
      {parts.map((part, i) =>
        urlRegex.test(part) ? (
          <Text
            key={i}
            style={{ color: linkColor, textDecorationLine: "underline" }}
            onPress={() => Linking.openURL(part)}
          >
            {part}
          </Text>
        ) : (
          <Text key={i}>{part}</Text>
        ),
      )}
    </Text>
  );
}

interface CircleExpandedDetailProps {
  circle: Circle;
  onCircleUpdated: (updated: Circle) => void;
  onDeleteCircle?: (circle: Circle) => void;
  onEditCircle?: (circle: Circle) => void;
  onOpenCatalogImage?: (circle: Circle, uri: string) => void;
  reprocessRequestToken?: number | null;
}

export default function CircleExpandedDetail({
  circle,
  onCircleUpdated,
  onDeleteCircle,
  onEditCircle,
  onOpenCatalogImage,
  reprocessRequestToken,
}: CircleExpandedDetailProps) {
  const { effectiveScheme } = useTheme();
  const colors = getColors(effectiveScheme);
  const { refresh } = useEvent();
  const [items, setItems] = useState<Item[]>([]);
  const [images, setImages] = useState<ItemImage[]>([]);
  const [boughtItemNameKeys, setBoughtItemNameKeys] = useState<Set<string>>(
    () => new Set(),
  );
  const [memo, setMemo] = useState(circle.memo);
  const [editingMemo, setEditingMemo] = useState(false);
  const [loading, setLoading] = useState(true);
  const [viewerImage, setViewerImage] = useState<string | null>(null);
  const [addingItem, setAddingItem] = useState(false);
  const [newItemName, setNewItemName] = useState("");
  const [newItemPrice, setNewItemPrice] = useState("");
  const [newItemType, setNewItemType] = useState("");
  const [newItemDesc, setNewItemDesc] = useState("");
  // M9: アイテム編集
  const [editingItemId, setEditingItemId] = useState<number | null>(null);
  const [editItemName, setEditItemName] = useState("");
  const [editItemPrice, setEditItemPrice] = useState("");
  const [editItemType, setEditItemType] = useState("");
  const [editItemDesc, setEditItemDesc] = useState("");
  // Xポスト再処理モーダル
  const [showReprocessModal, setShowReprocessModal] = useState(false);
  const [reprocessUrl, setReprocessUrl] = useState("");
  const [reprocessing, setReprocessing] = useState(false);
  const [reprocessStatus, setReprocessStatus] = useState("");

  useEffect(() => {
    loadData();
  }, [circle.id, circle.name, circle.penname, circle.purchaseStatus]);

  useEffect(() => {
    if (reprocessRequestToken != null) {
      openReprocessModal();
    }
  }, [reprocessRequestToken]);

  async function loadData() {
    setLoading(true);
    try {
      const [itemList, imageList, boughtKeys] = await Promise.all([
        getItemsByCircle(circle.id),
        getItemImagesByCircle(circle.id),
        getBoughtItemNameKeysForCircle(circle.name, circle.penname),
      ]);
      setItems(itemList);
      setImages(imageList);
      setBoughtItemNameKeys(boughtKeys);
    } catch (e) {
      console.error("詳細読み込みエラー:", e);
    } finally {
      setLoading(false);
    }
  }

  async function refreshBoughtItemKeys() {
    const boughtKeys = await getBoughtItemNameKeysForCircle(
      circle.name,
      circle.penname,
    );
    setBoughtItemNameKeys(boughtKeys);
  }

  const totalPrice = useMemo(() => {
    return items.reduce((sum, item) => sum + (item.price ?? 0), 0);
  }, [items]);

  const tags = useMemo(() => {
    if (!circle.tags) return [];
    try {
      const parsed = JSON.parse(circle.tags);
      return Array.isArray(parsed) ? parsed.filter((t: string) => t) : [];
    } catch {
      return [];
    }
  }, [circle.tags]);

  const genres = useMemo(() => {
    if (!circle.genres) return [];
    try {
      const parsed = JSON.parse(circle.genres);
      return Array.isArray(parsed) ? parsed.filter((g: string) => g) : [];
    } catch {
      return [];
    }
  }, [circle.genres]);

  // M6: タグをURLとその他に分離
  const { urls: tagUrls, others: tagOthers } = useMemo(
    () => extractUrls(tags),
    [tags],
  );

  // M10: アイテム個別ステータス
  async function handleItemPurchaseStatus(
    itemId: number,
    status: PurchaseStatusValue,
  ) {
    await updateItemPurchaseStatus(itemId, status);
    setItems((prev) =>
      prev.map((i) =>
        i.id === itemId
          ? { ...i, purchaseStatus: status, purchaseStatusSource: "manual" }
          : i,
      ),
    );
    await refreshBoughtItemKeys();
  }

  function openItemPurchaseStatusMenu(item: Item) {
    const statuses = [
      PURCHASE_STATUS.NOT_YET,
      PURCHASE_STATUS.BOUGHT,
      PURCHASE_STATUS.COULDNT_BUY,
      PURCHASE_STATUS.SKIPPED,
    ] as PurchaseStatusValue[];
    Alert.alert(
      "購入ステータス",
      item.name,
      [
        ...statuses.map((status) => ({
          text: `${PURCHASE_STATUS_LABELS[status].icon} ${PURCHASE_STATUS_LABELS[status].label}`,
          onPress: () => handleItemPurchaseStatus(item.id, status),
        })),
        { text: "キャンセル", style: "cancel" as const },
      ],
    );
  }

  async function handleSaveMemo() {
    await updateCircleMemo(circle.id, memo);
    onCircleUpdated({ ...circle, memo });
    setEditingMemo(false);
  }

  async function handleAddItem() {
    const name = newItemName.trim();
    if (!name) return;
    const price = newItemPrice.trim() ? parseFloat(newItemPrice) || null : null;
    const type = newItemType.trim() || null;
    const desc = newItemDesc.trim() || null;
    const item = await addItem(circle.id, name, price, type, desc);
    setItems((prev) => [...prev, item]);
    await refreshBoughtItemKeys();
    setNewItemName("");
    setNewItemPrice("");
    setNewItemType("");
    setNewItemDesc("");
    setAddingItem(false);
  }

  // M9: アイテム編集開始
  function startEditItem(item: Item) {
    setEditingItemId(item.id);
    setEditItemName(item.name);
    setEditItemPrice(item.price != null ? String(item.price) : "");
    setEditItemType(item.type ?? "");
    setEditItemDesc(item.description ?? "");
  }

  // M9: アイテム編集保存
  async function handleSaveEditItem() {
    if (!editingItemId) return;
    const name = editItemName.trim();
    if (!name) return;
    const price = editItemPrice.trim()
      ? parseFloat(editItemPrice) || null
      : null;
    const type = editItemType.trim() || null;
    const desc = editItemDesc.trim() || null;
    await updateItem(editingItemId, name, price, type, desc);
    setItems((prev) =>
      prev.map((i) =>
        i.id === editingItemId
          ? { ...i, name, price, type, description: desc }
          : i,
      ),
    );
    setEditingItemId(null);
    await refreshBoughtItemKeys();
  }

  async function handleReorderItem(fromIndex: number, toIndex: number) {
    if (toIndex < 0 || toIndex >= items.length) return;
    await reorderItem(circle.id, fromIndex, toIndex);
    setItems((prev) => {
      const next = [...prev];
      const [moved] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, moved);
      return next;
    });
  }

  async function handleDeleteItem(itemId: number) {
    Alert.alert("アイテム削除", "このアイテムを削除しますか？", [
      { text: "キャンセル", style: "cancel" },
      {
        text: "削除",
        style: "destructive",
        onPress: async () => {
          await deleteItem(itemId);
          setItems((prev) => prev.filter((i) => i.id !== itemId));
        },
      },
    ]);
  }

  function openUrl(url: string | null) {
    if (url) Linking.openURL(url);
  }

  async function handleReplaceCatalogImage(image: ItemImage) {
    try {
      const updated = await pickAndReplaceItemImage(image.id);
      if (!updated) return;
      setImages((prev) =>
        prev.map((img) => (img.id === updated.id ? updated : img)),
      );
      if (viewerImage === image.filename) {
        setViewerImage(updated.filename);
      }
      refresh();
    } catch (e: any) {
      Alert.alert("エラー", String(e?.message ?? e));
    }
  }

  async function handleAddCatalogImage() {
    try {
      const added = await pickAndAddItemImage(circle.id);
      if (!added) return;
      setImages((prev) => [...prev, added]);
      if (!circle.circleCutFilename) {
        onCircleUpdated({ ...circle, circleCutFilename: added.filename });
      }
      refresh();
    } catch (e: any) {
      Alert.alert("エラー", String(e?.message ?? e));
    }
  }

  function openCatalogImageMenu(image: ItemImage) {
    Alert.alert("おしながき画像", undefined, [
      {
        text: "差し替え",
        onPress: () => handleReplaceCatalogImage(image),
      },
      {
        text: "拡大表示",
        onPress: () =>
          onOpenCatalogImage
            ? onOpenCatalogImage(circle, image.filename)
            : setViewerImage(image.filename),
      },
      { text: "キャンセル", style: "cancel" },
    ]);
  }

  function openReprocessModal() {
    setReprocessUrl("");
    setReprocessStatus("");
    setShowReprocessModal(true);
  }

  async function handleReprocessFromPost() {
    const url = reprocessUrl.trim();
    if (!extractTweetId(url)) {
      Alert.alert(
        "URLエラー",
        "Xのポスト(ステータス)URLを入力してください。\n例: https://x.com/user/status/1234567890",
      );
      return;
    }
    setReprocessing(true);
    setReprocessStatus("処理を開始しています...");
    try {
      const result = await reprocessCircleFromPost(circle.id, url, (p) => {
        setReprocessStatus(p.message);
      });
      if (result.success) {
        setShowReprocessModal(false);
        await loadData();
        // memoも更新されているので親へ伝搬 + 全体refresh
        const newMemo = circle.memo.includes(url)
          ? circle.memo
          : circle.memo
            ? `${circle.memo}\n${url}`
            : url;
        onCircleUpdated({ ...circle, memo: newMemo });
        refresh();
        Alert.alert("再処理完了", result.message);
      } else {
        Alert.alert("再処理失敗", result.message);
      }
    } catch (e: any) {
      Alert.alert("エラー", String(e?.message ?? e));
    } finally {
      setReprocessing(false);
      setReprocessStatus("");
    }
  }

  return (
    <View
      style={[
        styles.container,
        { backgroundColor: colors.backgroundSecondary },
      ]}
    >
      {loading && (
        <View style={styles.loadingRow}>
          <ActivityIndicator size="small" color={colors.tint} />
        </View>
      )}

      {/* M12: 要素順見直し - 購入ステータス → お品書き → 頒布物 → リンク → メモ → 優先度 → マップ → タグ */}

      <View style={styles.sectionCompact}>
        {images.length > 0 ? (
          images.map((img) => (
            <Pressable
              key={img.id}
              onPress={() =>
                onOpenCatalogImage
                  ? onOpenCatalogImage(circle, img.filename)
                  : setViewerImage(img.filename)
              }
              onLongPress={() => openCatalogImageMenu(img)}
            >
              <Image
                source={{ uri: img.filename }}
                style={styles.itemImage}
                contentFit="contain"
                cachePolicy="memory-disk"
                transition={200}
              />
            </Pressable>
          ))
        ) : (
          <Pressable
            style={[
              styles.catalogImageAddBtn,
              { borderColor: colors.border, backgroundColor: colors.card },
            ]}
            onPress={handleAddCatalogImage}
          >
            <FontAwesome name="image" size={14} color={colors.tint} />
            <Text style={[styles.catalogImageAddText, { color: colors.tint }]}>
              おしながき画像を追加
            </Text>
          </Pressable>
        )}
      </View>

      {/* リンク（M12: 上の方に移動、M7: おしながきリンクも追加） */}
      {(circle.twitterUrl ||
        circle.websiteUrl ||
        circle.pixivUrl ||
        tagUrls.length > 0) && (
        <View style={styles.sectionCompact}>
          <View style={styles.linkRow}>
            {circle.twitterUrl && (
              <Pressable
                style={[styles.linkBtn, { borderColor: colors.border }]}
                onPress={() => openUrl(circle.twitterUrl)}
              >
                <Text style={[styles.linkBtnText, { color: colors.tint }]}>
                  X
                </Text>
              </Pressable>
            )}
            {circle.websiteUrl && (
              <Pressable
                style={[styles.linkBtn, { borderColor: colors.border }]}
                onPress={() => openUrl(circle.websiteUrl)}
              >
                <Text style={[styles.linkBtnText, { color: colors.tint }]}>
                  Web
                </Text>
              </Pressable>
            )}
            {circle.pixivUrl && (
              <Pressable
                style={[styles.linkBtn, { borderColor: colors.border }]}
                onPress={() => openUrl(circle.pixivUrl)}
              >
                <Text style={[styles.linkBtnText, { color: colors.tint }]}>
                  Pixiv
                </Text>
              </Pressable>
            )}
            {/* M7: おしながきリンク（タグから抽出したURL） */}
            {tagUrls.map((url, i) => (
              <Pressable
                key={`tag-url-${i}`}
                style={[styles.linkBtn, { borderColor: colors.border }]}
                onPress={() => openUrl(url)}
              >
                <Text
                  style={[styles.linkBtnText, { color: colors.tint }]}
                  numberOfLines={1}
                >
                  {url.includes("x.com") || url.includes("twitter.com")
                    ? "おしながき"
                    : "リンク"}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>
      )}

      {/* 合計金額 + 頒布物一覧 */}
      <View style={styles.sectionCompact}>
        <View style={styles.sectionHeader}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <Text
              style={[
                styles.sectionTitle,
                { color: colors.textSecondary, marginBottom: 0 },
              ]}
            >
              頒布物
            </Text>
            {totalPrice > 0 && (
              <Text style={styles.priceValue}>
                ¥{totalPrice.toLocaleString()}
              </Text>
            )}
          </View>
          <Pressable
            style={[styles.addItemBtn, { borderColor: colors.tint }]}
            onPress={() => setAddingItem(!addingItem)}
          >
            <Text style={[styles.addItemBtnText, { color: colors.tint }]}>
              {addingItem ? "×" : "＋"}
            </Text>
          </Pressable>
        </View>
        {items.map((item, itemIndex) => {
          // M9: 編集中のアイテム
          if (editingItemId === item.id) {
            return (
              <View
                key={item.id}
                style={[
                  styles.addItemForm,
                  {
                    backgroundColor: colors.background,
                    borderColor: colors.border,
                  },
                ]}
              >
                <TextInput
                  style={[
                    styles.addItemInput,
                    {
                      borderColor: colors.border,
                      color: colors.text,
                      backgroundColor: colors.inputBackground,
                    },
                  ]}
                  value={editItemName}
                  onChangeText={setEditItemName}
                  placeholder="アイテム名 *"
                  placeholderTextColor={colors.textSecondary}
                  autoFocus
                />
                <TextInput
                  style={[
                    styles.addItemInputHalf,
                    {
                      borderColor: colors.border,
                      color: colors.text,
                      backgroundColor: colors.inputBackground,
                      alignSelf: "flex-start",
                    },
                  ]}
                  value={editItemPrice}
                  onChangeText={setEditItemPrice}
                  placeholder="価格"
                  placeholderTextColor={colors.textSecondary}
                  keyboardType="numeric"
                />
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  style={styles.categoryScroll}
                  contentContainerStyle={styles.categoryContent}
                >
                  {ITEM_CATEGORIES.filter((c) => c !== "").map((cat) => (
                    <Pressable
                      key={cat}
                      style={[
                        styles.categoryChip,
                        { borderColor: colors.border },
                        editItemType === cat && {
                          backgroundColor: colors.tint,
                          borderColor: colors.tint,
                        },
                      ]}
                      onPress={() =>
                        setEditItemType(editItemType === cat ? "" : cat)
                      }
                    >
                      <Text
                        style={[
                          styles.categoryChipText,
                          { color: colors.textSecondary },
                          editItemType === cat && { color: "#fff" },
                        ]}
                      >
                        {cat}
                      </Text>
                    </Pressable>
                  ))}
                </ScrollView>
                <View style={styles.addItemActions}>
                  <Pressable
                    style={[
                      styles.addItemSaveBtn,
                      {
                        backgroundColor: editItemName.trim()
                          ? colors.tint
                          : colors.border,
                      },
                    ]}
                    onPress={handleSaveEditItem}
                    disabled={!editItemName.trim()}
                  >
                    <Text style={styles.addItemSaveBtnText}>保存</Text>
                  </Pressable>
                  <Pressable
                    style={styles.addItemCancelBtn}
                    onPress={() => setEditingItemId(null)}
                  >
                    <Text
                      style={[
                        styles.addItemCancelBtnText,
                        { color: colors.textSecondary },
                      ]}
                    >
                      キャンセル
                    </Text>
                  </Pressable>
                  <View style={{ flex: 1 }} />
                  <Pressable
                    onPress={() => {
                      setEditingItemId(null);
                      handleDeleteItem(item.id);
                    }}
                  >
                    <Text
                      style={{
                        color: "#c62828",
                        fontSize: 12,
                        fontWeight: "600",
                      }}
                    >
                      削除
                    </Text>
                  </Pressable>
                </View>
              </View>
            );
          }

          const boughtStatusInfo = PURCHASE_STATUS_LABELS[PURCHASE_STATUS.BOUGHT];
          const isBoughtSomewhere = boughtItemNameKeys.has(
            normalizePurchaseLookupKey(item.name),
          );
          return (
            <Pressable
              key={item.id}
              style={[
                styles.itemCard,
                { borderBottomColor: colors.border },
                isBoughtSomewhere && {
                  backgroundColor:
                    effectiveScheme === "dark"
                      ? "rgba(46,125,50,0.16)"
                      : "rgba(46,125,50,0.08)",
                },
              ]}
              onPress={() => startEditItem(item)}
              onLongPress={() => handleDeleteItem(item.id)}
            >
              <View style={styles.itemRow}>
                {/* 並び替えボタン */}
                {items.length > 1 && (
                  <View style={styles.reorderBtns}>
                    <Pressable
                      style={[
                        styles.reorderBtn,
                        itemIndex === 0 && { opacity: 0.2 },
                      ]}
                      onPress={(e) => {
                        e.stopPropagation();
                        handleReorderItem(itemIndex, itemIndex - 1);
                      }}
                      disabled={itemIndex === 0}
                      hitSlop={4}
                    >
                      <Text
                        style={[
                          styles.reorderBtnText,
                          { color: colors.textSecondary },
                        ]}
                      >
                        ▲
                      </Text>
                    </Pressable>
                    <Pressable
                      style={[
                        styles.reorderBtn,
                        itemIndex === items.length - 1 && { opacity: 0.2 },
                      ]}
                      onPress={(e) => {
                        e.stopPropagation();
                        handleReorderItem(itemIndex, itemIndex + 1);
                      }}
                      disabled={itemIndex === items.length - 1}
                      hitSlop={4}
                    >
                      <Text
                        style={[
                          styles.reorderBtnText,
                          { color: colors.textSecondary },
                        ]}
                      >
                        ▼
                      </Text>
                    </Pressable>
                  </View>
                )}
                <View style={styles.itemContent}>
                  <View
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      gap: 4,
                    }}
                  >
                    <Text
                      style={[
                        styles.itemName,
                        { color: colors.text },
                        item.purchaseStatus === PURCHASE_STATUS.BOUGHT && {
                          textDecorationLine: "line-through",
                          opacity: 0.5,
                        },
                      ]}
                    >
                      {item.name}
                    </Text>
                    {item.price != null && (
                      <Text style={styles.itemPrice}>{item.price}円</Text>
                    )}
                    {item.type && (
                      <Text
                        style={[
                          styles.itemType,
                          {
                            color: colors.textSecondary,
                            backgroundColor: colors.background,
                          },
                        ]}
                      >
                        {item.type}
                      </Text>
                    )}
                    {isBoughtSomewhere && (
                      <Text
                        style={[
                          styles.purchasedBadge,
                          {
                            color: boughtStatusInfo.color,
                            borderColor: boughtStatusInfo.color,
                            backgroundColor:
                              effectiveScheme === "dark"
                                ? "rgba(46,125,50,0.18)"
                                : "rgba(46,125,50,0.08)",
                          },
                        ]}
                      >
                        購入済み
                      </Text>
                    )}
                  </View>
                </View>
                {/* M10: アイテム購入ステータスボタン */}
                <View style={styles.itemStatusRow}>
                  {(
                    [
                      PURCHASE_STATUS.BOUGHT,
                      PURCHASE_STATUS.COULDNT_BUY,
                      PURCHASE_STATUS.SKIPPED,
                    ] as PurchaseStatusValue[]
                  ).map((s) => {
                    const info = PURCHASE_STATUS_LABELS[s];
                    const isActive = item.purchaseStatus === s;
                    return (
                      <Pressable
                        key={s}
                        style={[
                          styles.itemStatusBtn,
                          { borderColor: info.color },
                          isActive && { backgroundColor: info.color },
                        ]}
                        onPress={() =>
                          handleItemPurchaseStatus(
                            item.id,
                            isActive ? PURCHASE_STATUS.NOT_YET : s,
                          )
                        }
                        onLongPress={() => openItemPurchaseStatusMenu(item)}
                      >
                        <Text
                          style={[
                            styles.itemStatusText,
                            { color: isActive ? "#fff" : info.color },
                          ]}
                        >
                          {info.icon}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              </View>
            </Pressable>
          );
        })}
        {items.length === 0 && !addingItem && (
          <Text style={[styles.emptyText, { color: colors.textSecondary }]}>
            アイテムなし
          </Text>
        )}
        {addingItem && (
          <View
            style={[
              styles.addItemForm,
              {
                backgroundColor: colors.background,
                borderColor: colors.border,
              },
            ]}
          >
            <TextInput
              style={[
                styles.addItemInput,
                {
                  borderColor: colors.border,
                  color: colors.text,
                  backgroundColor: colors.inputBackground,
                },
              ]}
              value={newItemName}
              onChangeText={setNewItemName}
              placeholder="アイテム名 *"
              placeholderTextColor={colors.textSecondary}
              autoFocus
            />
            <TextInput
              style={[
                styles.addItemInputHalf,
                {
                  borderColor: colors.border,
                  color: colors.text,
                  backgroundColor: colors.inputBackground,
                  alignSelf: "flex-start",
                },
              ]}
              value={newItemPrice}
              onChangeText={setNewItemPrice}
              placeholder="価格"
              placeholderTextColor={colors.textSecondary}
              keyboardType="numeric"
            />
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              style={styles.categoryScroll}
              contentContainerStyle={styles.categoryContent}
            >
              {ITEM_CATEGORIES.filter((c) => c !== "").map((cat) => (
                <Pressable
                  key={cat}
                  style={[
                    styles.categoryChip,
                    { borderColor: colors.border },
                    newItemType === cat && {
                      backgroundColor: colors.tint,
                      borderColor: colors.tint,
                    },
                  ]}
                  onPress={() => setNewItemType(newItemType === cat ? "" : cat)}
                >
                  <Text
                    style={[
                      styles.categoryChipText,
                      { color: colors.textSecondary },
                      newItemType === cat && { color: "#fff" },
                    ]}
                  >
                    {cat}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
            <View style={styles.addItemActions}>
              <Pressable
                style={[
                  styles.addItemSaveBtn,
                  {
                    backgroundColor: newItemName.trim()
                      ? colors.tint
                      : colors.border,
                  },
                ]}
                onPress={handleAddItem}
                disabled={!newItemName.trim()}
              >
                <Text style={styles.addItemSaveBtnText}>追加</Text>
              </Pressable>
              <Pressable
                style={styles.addItemCancelBtn}
                onPress={() => {
                  setAddingItem(false);
                  setNewItemName("");
                  setNewItemPrice("");
                  setNewItemType("");
                  setNewItemDesc("");
                }}
              >
                <Text
                  style={[
                    styles.addItemCancelBtnText,
                    { color: colors.textSecondary },
                  ]}
                >
                  キャンセル
                </Text>
              </Pressable>
            </View>
          </View>
        )}
      </View>

      {/* メモ */}
      {(circle.memo || editingMemo) && (
        <View style={styles.sectionCompact}>
          {editingMemo ? (
            <View>
              <TextInput
                style={[
                  styles.memoInput,
                  {
                    borderColor: colors.border,
                    backgroundColor: colors.inputBackground,
                    color: colors.text,
                  },
                ]}
                value={memo}
                onChangeText={setMemo}
                multiline
                autoFocus
                placeholder="メモを入力..."
                placeholderTextColor={colors.textSecondary}
              />
              <View style={styles.memoActions}>
                <Pressable
                  style={[styles.memoSaveBtn, { backgroundColor: colors.tint }]}
                  onPress={handleSaveMemo}
                >
                  <Text style={styles.memoSaveBtnText}>保存</Text>
                </Pressable>
                <Pressable
                  style={styles.memoCancelBtn}
                  onPress={() => {
                    setMemo(circle.memo);
                    setEditingMemo(false);
                  }}
                >
                  <Text
                    style={[
                      styles.memoCancelBtnText,
                      { color: colors.textSecondary },
                    ]}
                  >
                    キャンセル
                  </Text>
                </Pressable>
              </View>
            </View>
          ) : (
            <Pressable onPress={() => setEditingMemo(true)}>
              {renderMemoWithLinks(
                circle.memo,
                colors.tint,
                colors.textSecondary,
              )}
            </Pressable>
          )}
        </View>
      )}

      <View style={styles.circleActionRow}>
        {onEditCircle && (
          <Pressable
            style={[styles.editCircleBtn, { borderColor: colors.tint }]}
            onPress={() => onEditCircle(circle)}
          >
            <FontAwesome name="pencil" size={12} color={colors.tint} />
            <Text style={[styles.editCircleBtnText, { color: colors.tint }]}>
              編集
            </Text>
          </Pressable>
        )}
        <Pressable
          style={[styles.editCircleBtn, { borderColor: colors.tint }]}
          onPress={openReprocessModal}
        >
          <FontAwesome name="refresh" size={12} color={colors.tint} />
          <Text style={[styles.editCircleBtnText, { color: colors.tint }]}>
            Xポスト再処理
          </Text>
        </Pressable>
        {onDeleteCircle && (
          <Pressable
            style={styles.deleteCircleBtn}
            onPress={() => onDeleteCircle(circle)}
          >
            <FontAwesome name="trash" size={12} color="#c62828" />
            <Text style={styles.deleteCircleBtnText}>削除</Text>
          </Pressable>
        )}
      </View>

      {/* タグ・ジャンル（M6: URLは除去済み、おしながき文言も除去） */}
      {(tagOthers.length > 0 || genres.length > 0) && (
        <View style={styles.chipContainer}>
          {genres.map((g: string, i: number) => (
            <View
              key={`g-${i}`}
              style={[
                styles.genreChip,
                { backgroundColor: colors.tint + "20" },
              ]}
            >
              <Text style={[styles.chipText, { color: colors.tint }]}>{g}</Text>
            </View>
          ))}
          {tagOthers.map((t: string, i: number) => (
            <View
              key={`t-${i}`}
              style={[styles.tagChip, { backgroundColor: colors.background }]}
            >
              <Text style={[styles.chipText, { color: colors.textSecondary }]}>
                {t}
              </Text>
            </View>
          ))}
        </View>
      )}

      <ImageViewer
        visible={viewerImage !== null}
        uri={viewerImage ?? ""}
        onClose={() => setViewerImage(null)}
      />

      {/* Xポスト再処理モーダル */}
      <Modal
        visible={showReprocessModal}
        transparent
        animationType="fade"
        onRequestClose={() => !reprocessing && setShowReprocessModal(false)}
      >
        <Pressable
          style={styles.reprocessOverlay}
          onPress={() => !reprocessing && setShowReprocessModal(false)}
        >
          <View
            style={[styles.reprocessCard, { backgroundColor: colors.card }]}
            onStartShouldSetResponder={() => true}
          >
            <Text style={[styles.reprocessTitle, { color: colors.text }]}>
              Xポストから再処理
            </Text>
            <Text
              style={[styles.reprocessDesc, { color: colors.textSecondary }]}
            >
              「{circle.name}
              」の頒布物・お品書き画像を、指定したXポストで置き換えます。既存の頒布物・画像は削除されます。
            </Text>
            <TextInput
              style={[
                styles.reprocessInput,
                {
                  color: colors.text,
                  borderColor: colors.border,
                  backgroundColor: colors.background,
                },
              ]}
              value={reprocessUrl}
              onChangeText={setReprocessUrl}
              placeholder="https://x.com/user/status/1234567890"
              placeholderTextColor={colors.textSecondary}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              editable={!reprocessing}
            />
            {reprocessing && (
              <View style={styles.reprocessStatusRow}>
                <ActivityIndicator size="small" color={colors.tint} />
                <Text
                  style={[
                    styles.reprocessStatusText,
                    { color: colors.textSecondary },
                  ]}
                >
                  {reprocessStatus}
                </Text>
              </View>
            )}
            <View style={styles.reprocessBtnRow}>
              <Pressable
                style={[styles.reprocessBtn, { borderColor: colors.border }]}
                onPress={() => setShowReprocessModal(false)}
                disabled={reprocessing}
              >
                <Text style={{ color: colors.textSecondary }}>キャンセル</Text>
              </Pressable>
              <Pressable
                style={[
                  styles.reprocessBtn,
                  {
                    backgroundColor: reprocessing ? colors.border : colors.tint,
                  },
                ]}
                onPress={handleReprocessFromPost}
                disabled={reprocessing}
              >
                <Text style={{ color: "#fff", fontWeight: "600" }}>
                  {reprocessing ? "処理中..." : "再処理"}
                </Text>
              </Pressable>
            </View>
          </View>
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: 12,
    paddingBottom: 6,
    borderBottomWidth: 2,
    borderBottomColor: "rgba(0,0,0,0.15)",
  },
  loadingRow: {
    paddingVertical: 8,
    alignItems: "center",
  },
  priceValue: { fontSize: 13, fontWeight: "700", color: "#e65100" },
  sectionCompact: {
    paddingVertical: 4,
  },
  sectionTitle: {
    fontSize: 11,
    fontWeight: "700",
    marginBottom: 4,
  },
  memoText: { fontSize: 12, lineHeight: 16 },
  memoInput: {
    borderWidth: 1,
    borderRadius: 6,
    padding: 8,
    fontSize: 13,
    minHeight: 50,
    textAlignVertical: "top",
  },
  memoActions: { flexDirection: "row", gap: 6, marginTop: 4 },
  memoSaveBtn: { paddingHorizontal: 12, paddingVertical: 5, borderRadius: 6 },
  memoSaveBtnText: { color: "#fff", fontWeight: "600", fontSize: 12 },
  memoCancelBtn: { paddingHorizontal: 12, paddingVertical: 5 },
  memoCancelBtnText: { fontSize: 12 },
  linkRow: { flexDirection: "row", gap: 6, flexWrap: "wrap" },
  linkBtn: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
    borderWidth: 1,
  },
  linkBtnText: { fontSize: 12, fontWeight: "600" },
  itemCard: {
    paddingVertical: 5,
    paddingHorizontal: 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderRadius: 4,
  },
  itemName: { fontSize: 13, fontWeight: "600" },
  itemMeta: { flexDirection: "row", gap: 6, marginTop: 2 },
  itemPrice: { fontSize: 12, fontWeight: "600", color: "#e65100" },
  itemType: {
    fontSize: 10,
    paddingHorizontal: 4,
    paddingVertical: 1,
    borderRadius: 3,
  },
  purchasedBadge: {
    fontSize: 10,
    fontWeight: "700",
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 3,
    borderWidth: 1,
  },
  itemDesc: { fontSize: 11, marginTop: 2 },
  itemImage: { width: "100%", height: 180, borderRadius: 6, marginBottom: 4 },
  catalogImageAddBtn: {
    minHeight: 84,
    borderRadius: 8,
    borderWidth: 1,
    borderStyle: "dashed",
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: 8,
  },
  catalogImageAddText: {
    fontSize: 13,
    fontWeight: "600",
  },
  itemRow: { flexDirection: "row", alignItems: "center" },
  itemContent: { flex: 1 },
  itemStatusRow: { flexDirection: "row", gap: 4, marginLeft: 4 },
  itemStatusBtn: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1.5,
  },
  itemStatusText: { fontSize: 12, fontWeight: "bold" },
  chipContainer: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 3,
    paddingVertical: 4,
  },
  genreChip: { paddingHorizontal: 6, paddingVertical: 1, borderRadius: 8 },
  tagChip: { paddingHorizontal: 6, paddingVertical: 1, borderRadius: 8 },
  chipText: { fontSize: 10, fontWeight: "500" },
  sectionHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 2,
  },
  addItemBtn: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 6,
    borderWidth: 1,
  },
  addItemBtnText: { fontSize: 12, fontWeight: "600" },
  emptyText: { fontSize: 12, fontStyle: "italic", paddingVertical: 2 },
  addItemForm: {
    padding: 8,
    borderRadius: 6,
    borderWidth: 1,
    marginTop: 4,
    gap: 6,
  },
  addItemInput: {
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 5,
    fontSize: 13,
  },
  addItemRow: { flexDirection: "row", gap: 6 },
  addItemInputHalf: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 5,
    fontSize: 13,
  },
  addItemActions: { flexDirection: "row", gap: 6, alignItems: "center" },
  addItemSaveBtn: {
    paddingHorizontal: 14,
    paddingVertical: 5,
    borderRadius: 6,
  },
  addItemSaveBtnText: { color: "#fff", fontWeight: "600", fontSize: 12 },
  addItemCancelBtn: { paddingHorizontal: 14, paddingVertical: 5 },
  addItemCancelBtnText: { fontSize: 12 },
  reorderBtns: {
    flexDirection: "column",
    justifyContent: "center",
    marginRight: 4,
    gap: 0,
  },
  reorderBtn: {
    paddingHorizontal: 4,
    paddingVertical: 1,
  },
  reorderBtnText: {
    fontSize: 10,
    fontWeight: "600",
  },
  circleActionRow: {
    flexDirection: "row",
    justifyContent: "center",
    gap: 16,
    paddingVertical: 8,
    marginTop: 4,
  },
  editCircleBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
    borderWidth: 1,
  },
  editCircleBtnText: {
    fontSize: 12,
    fontWeight: "600",
  },
  deleteCircleBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  deleteCircleBtnText: {
    fontSize: 12,
    color: "#c62828",
    fontWeight: "600",
  },
  categoryScroll: {
    maxHeight: 30,
    marginVertical: 2,
  },
  categoryContent: {
    gap: 4,
    alignItems: "center",
  },
  categoryChip: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 10,
    borderWidth: 1,
  },
  categoryChipText: {
    fontSize: 10,
  },
  reprocessOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
    justifyContent: "center",
    alignItems: "center",
    padding: 20,
  },
  reprocessCard: {
    width: "100%",
    maxWidth: 420,
    borderRadius: 12,
    padding: 18,
    gap: 10,
  },
  reprocessTitle: {
    fontSize: 16,
    fontWeight: "700",
  },
  reprocessDesc: {
    fontSize: 12,
    lineHeight: 17,
  },
  reprocessInput: {
    borderWidth: 1,
    borderRadius: 8,
    padding: 10,
    fontSize: 13,
  },
  reprocessStatusRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  reprocessStatusText: {
    fontSize: 12,
    flex: 1,
  },
  reprocessBtnRow: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 8,
    marginTop: 4,
  },
  reprocessBtn: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "transparent",
  },
});
