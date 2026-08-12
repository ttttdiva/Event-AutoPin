import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import {
  StyleSheet,
  View,
  Text,
  TextInput,
  FlatList,
  ActivityIndicator,
  RefreshControl,
  Pressable,
  LayoutAnimation,
  Alert,
  Modal,
  SafeAreaView,
  StatusBar,
  Platform,
  ScrollView,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useFocusEffect } from "@react-navigation/native";
import { Image } from "expo-image";
import FontAwesome from "@expo/vector-icons/FontAwesome";
import { useEvent } from "@/lib/event-context";
import type { ViewMode } from "@/lib/event-context";
import {
  getCirclesByEvent,
  getEvent,
  getEventStats,
  cycleCirclePurchaseStatus,
  updateCirclePurchaseStatus,
  updateItemsFromCirclePurchaseStatus,
  getBudgetSummary,
  getEventMaps,
  getItemImagesByCircle,
  updateCirclePin,
  getItemNamesByEvent,
  getFavoriteCircles,
  addFavoriteCircle,
  removeFavoriteCircle,
  addCircle,
  deleteCircle,
  updateCircle,
  updateCircleGenres,
  updateEvent,
  pickAndSaveEventImage,
  removeEventImage,
  pickAndSaveCircleCut,
  markCircleCatalogNeedsRecheck,
} from "@/lib/database";
import type { FavoriteCircle } from "@/lib/database";
import { getColors } from "@/constants/Colors";
import { CIRCLE_GENRES, PURCHASE_STATUS, PURCHASE_STATUS_LABELS } from "@/lib/types";
import type {
  Circle,
  Event as EventType,
  SortField,
  PurchaseStatusValue,
  BudgetSummary,
  EventMap as EventMapType,
} from "@/lib/types";

import { useTheme } from "@/lib/theme-context";
import { usePriorityColors } from "@/lib/priority-color-context";
import { prioritySortRank } from "@/lib/priority-colors";
import { isGlobalSearchEnabled } from "@/lib/settings-store";
import CircleRow from "@/components/CircleRow";
import CircleExpandedDetail from "@/components/CircleExpandedDetail";
import CollapsibleHeader from "@/components/CollapsibleHeader";
import BottomBar from "@/components/BottomBar";
import ImageViewer from "@/components/ImageViewer";
import MapViewComponent, { type MapViewHandle } from "@/components/MapView";

function formatElapsed(startIso: string): string {
  const start = new Date(startIso + "Z").getTime();
  const now = Date.now();
  const diff = Math.max(0, Math.floor((now - start) / 1000));
  const h = Math.floor(diff / 3600);
  const m = Math.floor((diff % 3600) / 60);
  const s = diff % 60;
  if (h > 0) return `${h}時間${m}分`;
  if (m > 0) return `${m}分${s}秒`;
  return `${s}秒`;
}

function parseCircleGenres(genres: string | null | undefined): string[] {
  if (!genres) return [];
  try {
    const parsed = JSON.parse(genres);
    return Array.isArray(parsed) ? parsed.filter((g: string) => g) : [];
  } catch {
    return [];
  }
}

export default function CircleListScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const eventId = Number(id);
  const { effectiveScheme } = useTheme();
  const colors = getColors(effectiveScheme);
  const router = useRouter();
  const {
    setCurrentEventId,
    expandedCircleId,
    setExpandedCircleId,
    viewMode,
    setViewMode,
    refreshKey,
    refresh,
    refreshStats,
    stats,
    budget,
    isShoppingMode,
    shoppingStartedAt,
  } = useEvent();
  const { options: priorityOptions } = usePriorityColors();

  const [event, setEvent] = useState<EventType | null>(null);
  const [circles, setCircles] = useState<Circle[]>([]);
  const [maps, setMaps] = useState<EventMapType[]>([]);
  const [itemNamesMap, setItemNamesMap] = useState<Map<number, string[]>>(
    new Map(),
  );
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [favorites, setFavorites] = useState<FavoriteCircle[]>([]);
  const [catalogViewer, setCatalogViewer] = useState<{
    circleId: number;
    uri: string;
  } | null>(null);
  const [circleCutViewer, setCircleCutViewer] = useState<string | null>(null);
  const [actionMenuCircle, setActionMenuCircle] = useState<Circle | null>(null);
  const [reprocessRequest, setReprocessRequest] = useState<{
    circleId: number;
    token: number;
  } | null>(null);

  // フィルター
  const [searchQuery, setSearchQuery] = useState("");
  const [globalSearchEnabled, setGlobalSearchEnabled] = useState(false);
  const [statusFilter, setStatusFilter] = useState<PurchaseStatusValue | null>(
    null,
  );
  const [sortBy, setSortBy] = useState<SortField>("space");
  const [hallFilter, setHallFilter] = useState<string | null>(null);
  const [priorityFilter, setPriorityFilter] = useState<Set<number>>(new Set());
  const [genreFilter, setGenreFilter] = useState<string | null>(null);
  const [catalogPostOnly, setCatalogPostOnly] = useState(false);
  const [hideSkipped, setHideSkipped] = useState(false);

  // 経過時間
  const [elapsedTime, setElapsedTime] = useState("");

  // ピン配置モード
  const [pinPlacementCircle, setPinPlacementCircle] = useState<Circle | null>(
    null,
  );

  // サークル追加モーダル
  const [showAddCircle, setShowAddCircle] = useState(false);
  const [newCircleName, setNewCircleName] = useState("");
  const [newCirclePenname, setNewCirclePenname] = useState("");
  const [newCircleSpace, setNewCircleSpace] = useState("");
  const [newCircleHall, setNewCircleHall] = useState("");
  const [newCirclePriority, setNewCirclePriority] = useState(5);
  const [newCircleMemo, setNewCircleMemo] = useState("");
  const [newCircleTwitter, setNewCircleTwitter] = useState("");
  const [newCircleWebsite, setNewCircleWebsite] = useState("");

  // イベント編集モーダル
  const [showEditEvent, setShowEditEvent] = useState(false);
  const [editEventName, setEditEventName] = useState("");
  const [editEventDate, setEditEventDate] = useState("");
  const [editEventVenue, setEditEventVenue] = useState("");

  // サークル編集モーダル
  const [showEditCircle, setShowEditCircle] = useState(false);
  const [editCircleId, setEditCircleId] = useState<number | null>(null);
  const [editCircleName, setEditCircleName] = useState("");
  const [editCirclePenname, setEditCirclePenname] = useState("");
  const [editCircleSpace, setEditCircleSpace] = useState("");
  const [editCircleHall, setEditCircleHall] = useState("");
  const [editCirclePriority, setEditCirclePriority] = useState(5);
  const [editCircleMemo, setEditCircleMemo] = useState("");
  const [editCircleTwitter, setEditCircleTwitter] = useState("");
  const [editCircleWebsite, setEditCircleWebsite] = useState("");
  const [editCirclePixiv, setEditCirclePixiv] = useState("");
  const [editCircleDescription, setEditCircleDescription] = useState("");
  const [editCircleGenres, setEditCircleGenres] = useState<string[]>([]);
  const [editCircleAbsence, setEditCircleAbsence] = useState(false);
  const [editCircleExistingOnly, setEditCircleExistingOnly] = useState(false);

  // サークルリストのref（ピンタップ時のスクロール用）
  const flatListRef = useRef<FlatList>(null);
  // マップViewのref（リスト→マップ連動用）
  const mapViewRef = useRef<MapViewHandle>(null);
  const [pendingMapFocusCircleId, setPendingMapFocusCircleId] = useState<
    number | null
  >(null);

  useEffect(() => {
    setCurrentEventId(eventId);
  }, [eventId]);

  useEffect(() => {
    if (pendingMapFocusCircleId == null) return;
    if (viewMode !== "map" && viewMode !== "split") return;
    mapViewRef.current?.focusOnCircle(pendingMapFocusCircleId);
    setPendingMapFocusCircleId(null);
  }, [pendingMapFocusCircleId, viewMode]);

  useEffect(() => {
    if (!isShoppingMode || !shoppingStartedAt) {
      setElapsedTime("");
      return;
    }
    const update = () => setElapsedTime(formatElapsed(shoppingStartedAt));
    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [isShoppingMode, shoppingStartedAt]);

  useEffect(() => {
    loadData();
  }, [refreshKey, eventId]);

  useFocusEffect(
    useCallback(() => {
      let active = true;
      isGlobalSearchEnabled()
        .then((enabled) => {
          if (active) setGlobalSearchEnabled(enabled);
        })
        .catch((e) => {
          console.error("全体検索設定の読み込みエラー:", e);
        });
      return () => {
        active = false;
      };
    }, []),
  );

  async function loadData() {
    setLoading(true);
    try {
      const [ev, circleList, mapList, itemNames, favs, globalSearch] =
        await Promise.all([
          getEvent(eventId),
          getCirclesByEvent(eventId),
          getEventMaps(eventId),
          getItemNamesByEvent(eventId),
          getFavoriteCircles(),
          isGlobalSearchEnabled(),
        ]);
      setEvent(ev);
      setCircles(circleList);
      setMaps(mapList);
      setItemNamesMap(itemNames);
      setFavorites(favs);
      setGlobalSearchEnabled(globalSearch);
    } catch (e) {
      console.error("データ読み込みエラー:", e);
    } finally {
      setLoading(false);
    }
  }

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadData();
    setRefreshing(false);
  }, [eventId]);

  // サークル展開
  function handleToggleCircle(circleId: number) {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setExpandedCircleId(expandedCircleId === circleId ? null : circleId);
  }

  // 購入状態切り替え
  async function handleCyclePurchaseStatus(id: number) {
    const newStatus = await cycleCirclePurchaseStatus(id);
    setCircles((prev) =>
      prev.map((c) => (c.id === id ? { ...c, purchaseStatus: newStatus } : c)),
    );
    refreshStats();
  }

  function openPurchaseStatusMenu(circle: Circle) {
    Alert.alert(circle.name, "購入ステータス", [
      ...([
        PURCHASE_STATUS.NOT_YET,
        PURCHASE_STATUS.BOUGHT,
        PURCHASE_STATUS.COULDNT_BUY,
        PURCHASE_STATUS.SKIPPED,
      ] as PurchaseStatusValue[]).map((status) => ({
        text: PURCHASE_STATUS_LABELS[status].label,
        onPress: async () => {
          await updateCirclePurchaseStatus(circle.id, status);
          await updateItemsFromCirclePurchaseStatus(circle.id, status);
          setCircles((prev) =>
            prev.map((c) =>
              c.id === circle.id ? { ...c, purchaseStatus: status } : c,
            ),
          );
          refreshStats();
        },
      })),
      { text: "キャンセル", style: "cancel" },
    ]);
  }

  // サークル更新
  function handleCircleUpdated(updated: Circle) {
    setCircles((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
    refreshStats();
  }

  // お気に入り判定
  const favoriteSet = useMemo(() => {
    const nameSet = new Set<string>();
    const tagSet = new Set<string>();
    for (const f of favorites) {
      if (f.name) nameSet.add(f.name);
      if (f.tag) tagSet.add(f.tag);
    }
    return { nameSet, tagSet };
  }, [favorites]);

  function isCircleFavorite(circle: Circle): boolean {
    return (
      (circle.name !== "" && favoriteSet.nameSet.has(circle.name)) ||
      (circle.penname != null &&
        circle.penname !== "" &&
        favoriteSet.tagSet.has(circle.penname))
    );
  }

  async function handleToggleFavorite(circle: Circle) {
    const name = circle.name || "";
    const tag = circle.penname || "";
    const isFav = isCircleFavorite(circle);
    if (isFav) {
      await removeFavoriteCircle(name, tag);
      setFavorites((prev) =>
        prev.filter(
          (f) =>
            !(f.name !== "" && name !== "" && f.name === name) &&
            !(f.tag !== "" && tag !== "" && f.tag === tag),
        ),
      );
    } else {
      await addFavoriteCircle(name, tag);
      setFavorites((prev) => [...prev, { id: 0, name, tag }]);
    }
  }

  function togglePriorityFilter(value: number) {
    setPriorityFilter((prev) => {
      const next = new Set(prev);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });
  }

  function clearPriorityFilter() {
    setPriorityFilter(new Set());
  }

  function handleMapPin(circle: Circle) {
    if (circle.pinX != null && circle.pinY != null) {
      // ピンがある場合はマップ表示＆ピン位置にフォーカス
      if (viewMode !== "split") setViewMode("split");
      setPendingMapFocusCircleId(circle.id);
    } else {
      // ピンがない場合はピン配置モードに
      startPinPlacement(circle);
    }
  }

  function startPinPlacement(circle: Circle) {
    setPinPlacementCircle(circle);
    setViewMode("map");
  }

  async function handleMapLongPress(
    normX: number,
    normY: number,
    mapNumber: number,
  ) {
    if (!pinPlacementCircle) return;
    const circle = pinPlacementCircle;
    setPinPlacementCircle(null);

    await updateCirclePin(circle.id, normX, normY, mapNumber);
    setCircles((prev) =>
      prev.map((c) =>
        c.id === circle.id ? { ...c, pinX: normX, pinY: normY, mapNumber } : c,
      ),
    );
    setViewMode("list");
    Alert.alert("ピン配置", `${circle.name} のピンを配置しました`);
  }

  // ピンドラッグ移動
  async function handlePinMove(
    circle: Circle,
    newNormX: number,
    newNormY: number,
  ) {
    await updateCirclePin(circle.id, newNormX, newNormY, circle.mapNumber);
    setCircles((prev) =>
      prev.map((c) =>
        c.id === circle.id ? { ...c, pinX: newNormX, pinY: newNormY } : c,
      ),
    );
  }

  // M14: ピン長押し削除
  async function handlePinRemove(circle: Circle) {
    await updateCirclePin(circle.id, null, null, null);
    setCircles((prev) =>
      prev.map((c) =>
        c.id === circle.id
          ? { ...c, pinX: null, pinY: null, mapNumber: null }
          : c,
      ),
    );
  }

  function handleViewModeChange(mode: ViewMode) {
    setViewMode(mode);
  }

  // サークル追加
  function openAddCircle() {
    setNewCircleName("");
    setNewCirclePenname("");
    setNewCircleSpace("");
    setNewCircleHall("");
    setNewCirclePriority(5);
    setShowAddCircle(true);
  }

  async function handleAddCircle() {
    const name = newCircleName.trim();
    if (!name) {
      Alert.alert("エラー", "サークル名を入力してください");
      return;
    }
    try {
      const circle = await addCircle(
        eventId,
        name,
        newCirclePenname.trim() || null,
        newCircleSpace.trim() || null,
        newCircleHall.trim() || null,
        newCirclePriority,
        newCircleMemo.trim() || null,
        newCircleTwitter.trim() || null,
        newCircleWebsite.trim() || null,
      );
      setShowAddCircle(false);
      setNewCircleMemo("");
      setNewCircleTwitter("");
      setNewCircleWebsite("");
      setCircles((prev) => [...prev, circle]);
      refreshStats();
      setExpandedCircleId(circle.id);
    } catch (e: any) {
      Alert.alert("エラー", e.message);
    }
  }

  // サークル削除
  async function handleDeleteCircle(circle: Circle) {
    Alert.alert("サークル削除", `「${circle.name}」を削除しますか？`, [
      { text: "キャンセル", style: "cancel" },
      {
        text: "削除",
        style: "destructive",
        onPress: async () => {
          await deleteCircle(circle.id);
          setCircles((prev) => prev.filter((c) => c.id !== circle.id));
          if (expandedCircleId === circle.id) setExpandedCircleId(null);
          refreshStats();
        },
      },
    ]);
  }

  // イベント情報編集
  function requestCircleReprocess(circle: Circle) {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setExpandedCircleId(circle.id);
    setReprocessRequest({ circleId: circle.id, token: Date.now() });
  }

  function openCircleActionMenu(circle: Circle) {
    setActionMenuCircle(circle);
  }

  async function handleMarkCatalogNeedsRecheck(circle: Circle) {
    const result = await markCircleCatalogNeedsRecheck(circle.id);
    setCircles((prev) =>
      prev.map((c) =>
        c.id === circle.id
          ? {
              ...c,
              memo: result.memo,
              catalogStatus: result.catalogStatus,
              hasCatalogPost: false,
            }
          : c,
      ),
    );
    refresh();
  }

  function runCircleMenuAction(action: (circle: Circle) => void | Promise<void>) {
    const circle = actionMenuCircle;
    if (!circle) return;
    setActionMenuCircle(null);
    void action(circle);
  }

  async function handleReplaceCircleCut(circle: Circle) {
    try {
      const newPath = await pickAndSaveCircleCut(circle.id);
      if (!newPath) return;
      setCircles((prev) =>
        prev.map((c) =>
          c.id === circle.id ? { ...c, circleCutFilename: newPath } : c,
        ),
      );
      setCircleCutViewer((prev) =>
        prev === circle.circleCutFilename ? newPath : prev,
      );
      refresh();
    } catch (e: any) {
      Alert.alert("エラー", String(e?.message ?? e));
    }
  }

  function openCircleCutMenu(circle: Circle) {
    Alert.alert("サークルカット", circle.name, [
      { text: "差し替え", onPress: () => handleReplaceCircleCut(circle) },
      ...(circle.circleCutFilename
        ? [
            {
              text: "拡大表示",
              onPress: () => setCircleCutViewer(circle.circleCutFilename),
            },
          ]
        : []),
      { text: "キャンセル", style: "cancel" },
    ]);
  }

  function openEditEvent() {
    if (!event) return;
    setEditEventName(event.name);
    setEditEventDate(event.date ?? "");
    setEditEventVenue(event.venue ?? "");
    setShowEditEvent(true);
  }

  async function handleSaveEvent() {
    const name = editEventName.trim();
    if (!name) {
      Alert.alert("エラー", "イベント名を入力してください");
      return;
    }
    try {
      await updateEvent(
        eventId,
        name,
        editEventDate.trim() || null,
        editEventVenue.trim() || null,
      );
      setShowEditEvent(false);
      setEvent((prev) =>
        prev
          ? {
              ...prev,
              name,
              date: editEventDate.trim() || null,
              venue: editEventVenue.trim() || null,
            }
          : prev,
      );
    } catch (e: any) {
      Alert.alert("エラー", e.message);
    }
  }

  async function handlePickEventImage() {
    const newPath = await pickAndSaveEventImage(eventId);
    if (newPath) {
      setEvent((prev) =>
        prev ? { ...prev, eventImageFilename: newPath } : prev,
      );
    }
  }

  function handleRemoveEventImage() {
    Alert.alert("画像を削除", "イベント画像を削除しますか？", [
      { text: "キャンセル", style: "cancel" },
      {
        text: "削除",
        style: "destructive",
        onPress: async () => {
          await removeEventImage(eventId);
          setEvent((prev) =>
            prev ? { ...prev, eventImageFilename: null } : prev,
          );
        },
      },
    ]);
  }

  // サークル編集
  function openEditCircle(circle: Circle) {
    setEditCircleId(circle.id);
    setEditCircleName(circle.name);
    setEditCirclePenname(circle.penname ?? "");
    setEditCircleSpace(circle.space ?? "");
    setEditCircleHall(circle.hall ?? "");
    setEditCirclePriority(circle.priorityColor);
    setEditCircleMemo(circle.memo ?? "");
    setEditCircleTwitter(circle.twitterUrl ?? "");
    setEditCircleWebsite(circle.websiteUrl ?? "");
    setEditCirclePixiv(circle.pixivUrl ?? "");
    setEditCircleDescription(circle.description ?? "");
    setEditCircleGenres(parseCircleGenres(circle.genres));
    setEditCircleAbsence(!!circle.absenceStatus);
    setEditCircleExistingOnly(!!circle.existingOnlyStatus);
    setShowEditCircle(true);
  }

  function toggleEditCircleGenre(genre: string) {
    setEditCircleGenres((prev) =>
      prev.includes(genre)
        ? prev.filter((g) => g !== genre)
        : [...prev, genre],
    );
  }

  async function handleSaveEditCircle() {
    if (!editCircleId) return;
    const name = editCircleName.trim();
    if (!name) {
      Alert.alert("エラー", "サークル名を入力してください");
      return;
    }
    try {
      const pixivVal = editCirclePixiv.trim() || null;
      const descVal = editCircleDescription.trim() || null;
      const absenceVal = editCircleAbsence ? "absent" : null;
      const existingVal = editCircleExistingOnly ? "existing" : null;
      await updateCircle(
        editCircleId,
        name,
        editCirclePenname.trim() || null,
        editCircleSpace.trim() || null,
        editCircleHall.trim() || null,
        editCirclePriority,
        editCircleMemo.trim() || null,
        editCircleTwitter.trim() || null,
        editCircleWebsite.trim() || null,
        pixivVal,
        descVal,
        absenceVal,
        existingVal,
      );
      await updateCircleGenres(editCircleId, editCircleGenres);
      setShowEditCircle(false);
      setCircles((prev) =>
        prev.map((c) =>
          c.id === editCircleId
            ? {
                ...c,
                name,
                penname: editCirclePenname.trim() || null,
                space: editCircleSpace.trim() || null,
                hall: editCircleHall.trim() || null,
                priorityColor: editCirclePriority,
                memo: editCircleMemo.trim(),
                twitterUrl: editCircleTwitter.trim() || null,
                websiteUrl: editCircleWebsite.trim() || null,
                pixivUrl: pixivVal,
                description: descVal,
                genres: JSON.stringify(editCircleGenres),
                absenceStatus: absenceVal,
                existingOnlyStatus: existingVal,
              }
            : c,
        ),
      );
      refreshStats();
    } catch (e: any) {
      Alert.alert("エラー", e.message);
    }
  }

  // マップのピンタップ → サークルリストをスクロール＆展開
  const halls = useMemo(() => {
    const hallSet = new Set<string>();
    circles.forEach((c) => {
      if (c.hall) hallSet.add(c.hall);
    });
    return Array.from(hallSet).sort();
  }, [circles]);

  const filteredCircles = useMemo(() => {
    let result = circles;
    const activeSearchQuery = searchQuery.trim();
    if (statusFilter !== null)
      result = result.filter((c) => c.purchaseStatus === statusFilter);
    if (hideSkipped)
      result = result.filter((c) => c.purchaseStatus !== PURCHASE_STATUS.SKIPPED);
    if (hallFilter) result = result.filter((c) => c.hall === hallFilter);
    if (priorityFilter.size > 0)
      result = result.filter((c) => priorityFilter.has(c.priorityColor));
    if (catalogPostOnly) result = result.filter((c) => c.hasCatalogPost);
    if (genreFilter) {
      result = result.filter((c) => {
        try {
          const g = JSON.parse(c.genres);
          return Array.isArray(g) && g.includes(genreFilter);
        } catch {
          return false;
        }
      });
    }
    if (activeSearchQuery) {
      const q = activeSearchQuery.toLowerCase();
      result = result.filter(
        (c) => {
          const itemMatches = (itemNamesMap.get(c.id) ?? []).some((n) =>
            n.toLowerCase().includes(q),
          );
          if (globalSearchEnabled) {
            return (
              c.name.toLowerCase().includes(q) ||
              (c.penname && c.penname.toLowerCase().includes(q)) ||
              c.memo.toLowerCase().includes(q) ||
              (c.description && c.description.toLowerCase().includes(q)) ||
              itemMatches
            );
          }
          return (
            c.name.toLowerCase().includes(q) ||
            (c.space && c.space.toLowerCase().includes(q)) ||
            (c.penname && c.penname.toLowerCase().includes(q)) ||
            (c.hall && c.hall.toLowerCase().includes(q)) ||
            c.memo.toLowerCase().includes(q) ||
            itemMatches
          );
        },
      );
    }
    result = [...result].sort((a, b) => {
      switch (sortBy) {
        case "name":
          return a.name.localeCompare(b.name, "ja");
        case "priority": {
          const pa = prioritySortRank(a.priorityColor);
          const pb = prioritySortRank(b.priorityColor);
          if (pb !== pa) return pb - pa;
          return (a.space ?? "").localeCompare(b.space ?? "", "ja");
        }
        case "favorite": {
          const fa = isCircleFavorite(a) ? 1 : 0;
          const fb = isCircleFavorite(b) ? 1 : 0;
          if (fb !== fa) return fb - fa;
          return ((a.hall ?? "") + (a.space ?? "")).localeCompare(
            (b.hall ?? "") + (b.space ?? ""),
            "ja",
          );
        }
        case "space":
        default:
          return ((a.hall ?? "") + (a.space ?? "")).localeCompare(
            (b.hall ?? "") + (b.space ?? ""),
            "ja",
          );
      }
    });
    return result;
  }, [
    circles,
    searchQuery,
    globalSearchEnabled,
    statusFilter,
    sortBy,
    hallFilter,
    priorityFilter,
    genreFilter,
    catalogPostOnly,
    hideSkipped,
    itemNamesMap,
    favoriteSet,
  ]);

  // マップピンタップ後、FlatListマウント完了時にスクロール実行
  const pendingScrollCircleId = useRef<number | null>(null);
  const scrollRetryCount = useRef(0);
  const [scrollTick, setScrollTick] = useState(0);

  const catalogViewerIndex = useMemo(() => {
    if (!catalogViewer) return -1;
    return filteredCircles.findIndex((c) => c.id === catalogViewer.circleId);
  }, [catalogViewer, filteredCircles]);

  function focusCircleInList(circleId: number) {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setExpandedCircleId(circleId);
    pendingScrollCircleId.current = circleId;
    scrollRetryCount.current = 0;
    setScrollTick((t) => t + 1);
  }

  function openCatalogViewer(circle: Circle, uri: string) {
    setCatalogViewer({ circleId: circle.id, uri });
    focusCircleInList(circle.id);
  }

  async function navigateCatalogViewer(direction: -1 | 1) {
    if (!catalogViewer || catalogViewerIndex < 0) return;

    for (
      let index = catalogViewerIndex + direction;
      index >= 0 && index < filteredCircles.length;
      index += direction
    ) {
      const nextCircle = filteredCircles[index];
      const images = await getItemImagesByCircle(nextCircle.id);
      const nextImage = images[0];
      if (!nextImage?.filename) continue;

      setCatalogViewer({ circleId: nextCircle.id, uri: nextImage.filename });
      focusCircleInList(nextCircle.id);
      return;
    }
  }

  useEffect(() => {
    if (pendingScrollCircleId.current == null) return;
    if (viewMode !== "split" && viewMode !== "list") return;
    const circleId = pendingScrollCircleId.current;
    const tryScroll = (attempt: number) => {
      const idx = filteredCircles.findIndex((c) => c.id === circleId);
      if (idx >= 0 && flatListRef.current) {
        scrollRetryCount.current = 0;
        flatListRef.current.scrollToIndex({
          index: idx,
          animated: true,
          viewPosition: 0,
        });
        pendingScrollCircleId.current = null;
      } else if (attempt < 5) {
        setTimeout(() => tryScroll(attempt + 1), 200);
      }
    };
    setTimeout(() => tryScroll(0), 100);
  }, [viewMode, filteredCircles, scrollTick]);

  const handleMapCirclePress = useCallback(
    (circle: Circle) => {
      if (viewMode === "map") setViewMode("split");
      setExpandedCircleId(circle.id);
      pendingScrollCircleId.current = circle.id;
      scrollRetryCount.current = 0;
      setScrollTick((t) => t + 1);
    },
    [viewMode],
  );

  if (loading && circles.length === 0) {
    return (
      <SafeAreaView
        style={[styles.safeArea, { backgroundColor: colors.background }]}
      >
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.tint} />
          <Text style={[styles.loadingText, { color: colors.textSecondary }]}>
            読み込み中...
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  // ピン配置モードのバナー
  function renderPinBanner() {
    if (!pinPlacementCircle) return null;
    return (
      <View style={styles.pinBanner}>
        <Text style={styles.pinBannerText}>
          「{pinPlacementCircle.name}」のピンを配置中 - マップを長押し
        </Text>
        <Pressable
          onPress={() => {
            setPinPlacementCircle(null);
            setViewMode("list");
          }}
        >
          <Text style={styles.pinBannerCancel}>キャンセル</Text>
        </Pressable>
      </View>
    );
  }

  // M5: 統一レンダリング - MapViewを1インスタンスにしてズーム状態を維持
  const showMap = viewMode === "map" || viewMode === "split";
  const showList = viewMode === "list" || viewMode === "split";
  const mapFilterProps = {
    parentStatusFilter: statusFilter,
    parentPriorityFilter: priorityFilter,
    parentHallFilter: hallFilter,
    parentSearchQuery: searchQuery,
    parentGlobalSearchEnabled: globalSearchEnabled,
    parentSearchTextMap: itemNamesMap,
    parentCatalogPostOnly: catalogPostOnly,
    parentHideSkipped: hideSkipped,
  };

  return (
    <SafeAreaView
      style={[styles.safeArea, { backgroundColor: colors.background }]}
    >
      <StatusBar
        barStyle={effectiveScheme === "dark" ? "light-content" : "dark-content"}
      />
      <View style={{ flex: 1 }}>
        {showMap && renderPinBanner()}
        {showMap && (
          <View style={{ flex: 1 }}>
            <MapViewComponent
              ref={mapViewRef}
              circles={circles}
              maps={maps}
              showFilters={viewMode === "map"}
              onMapLongPress={handleMapLongPress}
              onCirclePress={handleMapCirclePress}
              onPinRemove={handlePinRemove}
              onPinMove={handlePinMove}
              {...mapFilterProps}
            />
          </View>
        )}
        {showList && (
          <View
            style={{
              flex: 1,
              ...(viewMode === "split"
                ? { borderTopWidth: 2, borderTopColor: colors.border }
                : {}),
            }}
          >
            {renderCircleList()}
          </View>
        )}
        <BottomBar
          viewMode={viewMode}
          onViewModeChange={handleViewModeChange}
        />
      </View>

      {/* サークル追加モーダル */}
      <Modal
        visible={showAddCircle}
        transparent
        animationType="fade"
        onRequestClose={() => setShowAddCircle(false)}
      >
        <Pressable
          style={styles.modalOverlay}
          onPress={() => setShowAddCircle(false)}
        >
          <ScrollView
            style={styles.modalScroll}
            contentContainerStyle={styles.modalScrollContent}
            keyboardShouldPersistTaps="handled"
          >
            <View
              style={[styles.modalCardWide, { backgroundColor: colors.card }]}
              onStartShouldSetResponder={() => true}
            >
              <Text style={[styles.modalTitle, { color: colors.text }]}>
                サークル追加
              </Text>
              <View style={styles.formGroup}>
                <Text
                  style={[styles.formLabel, { color: colors.textSecondary }]}
                >
                  サークル名 *
                </Text>
                <TextInput
                  style={[
                    styles.formInput,
                    {
                      color: colors.text,
                      borderColor: colors.border,
                      backgroundColor: colors.background,
                    },
                  ]}
                  value={newCircleName}
                  onChangeText={setNewCircleName}
                  placeholder="サークル名"
                  placeholderTextColor={colors.textSecondary}
                  autoFocus
                />
              </View>
              <View style={styles.formGroup}>
                <Text
                  style={[styles.formLabel, { color: colors.textSecondary }]}
                >
                  ペンネーム
                </Text>
                <TextInput
                  style={[
                    styles.formInput,
                    {
                      color: colors.text,
                      borderColor: colors.border,
                      backgroundColor: colors.background,
                    },
                  ]}
                  value={newCirclePenname}
                  onChangeText={setNewCirclePenname}
                  placeholder="ペンネーム"
                  placeholderTextColor={colors.textSecondary}
                />
              </View>
              <View style={styles.formRow}>
                <View style={[styles.formGroup, styles.formRowItem]}>
                  <Text
                    style={[styles.formLabel, { color: colors.textSecondary }]}
                  >
                    スペース
                  </Text>
                  <TextInput
                    style={[
                      styles.formInput,
                      {
                        color: colors.text,
                        borderColor: colors.border,
                        backgroundColor: colors.background,
                      },
                    ]}
                    value={newCircleSpace}
                    onChangeText={setNewCircleSpace}
                    placeholder="A-01a"
                    placeholderTextColor={colors.textSecondary}
                  />
                </View>
                <View style={[styles.formGroup, styles.formRowItem]}>
                  <Text
                    style={[styles.formLabel, { color: colors.textSecondary }]}
                  >
                    ホール
                  </Text>
                  <TextInput
                    style={[
                      styles.formInput,
                      {
                        color: colors.text,
                        borderColor: colors.border,
                        backgroundColor: colors.background,
                      },
                    ]}
                    value={newCircleHall}
                    onChangeText={setNewCircleHall}
                    placeholder="東1"
                    placeholderTextColor={colors.textSecondary}
                  />
                </View>
              </View>
              <View style={styles.formGroup}>
                <Text
                  style={[styles.formLabel, { color: colors.textSecondary }]}
                >
                  優先度
                </Text>
                <View style={styles.prioritySelectRow}>
                  {priorityOptions.map((option) => {
                    const colorNum = option.value;
                    const val = option;
                    return (
                      <Pressable
                        key={colorNum}
                        style={[
                          styles.prioritySelectBtn,
                          { borderColor: val.color },
                          newCirclePriority === colorNum && {
                            backgroundColor: val.bgColor,
                          },
                        ]}
                        onPress={() => setNewCirclePriority(colorNum)}
                      >
                        <View
                          style={[
                            styles.prioritySelectDot,
                            { backgroundColor: val.color },
                          ]}
                        />
                        <Text
                          style={[
                            styles.prioritySelectLabel,
                            { color: val.color },
                          ]}
                          numberOfLines={1}
                          adjustsFontSizeToFit
                        >
                          {val.label}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              </View>
              <View style={styles.formGroup}>
                <Text
                  style={[styles.formLabel, { color: colors.textSecondary }]}
                >
                  Twitter / X
                </Text>
                <TextInput
                  style={[
                    styles.formInput,
                    {
                      color: colors.text,
                      borderColor: colors.border,
                      backgroundColor: colors.background,
                    },
                  ]}
                  value={newCircleTwitter}
                  onChangeText={setNewCircleTwitter}
                  placeholder="https://x.com/..."
                  placeholderTextColor={colors.textSecondary}
                  autoCapitalize="none"
                  keyboardType="url"
                />
              </View>
              <View style={styles.formGroup}>
                <Text
                  style={[styles.formLabel, { color: colors.textSecondary }]}
                >
                  Webサイト
                </Text>
                <TextInput
                  style={[
                    styles.formInput,
                    {
                      color: colors.text,
                      borderColor: colors.border,
                      backgroundColor: colors.background,
                    },
                  ]}
                  value={newCircleWebsite}
                  onChangeText={setNewCircleWebsite}
                  placeholder="https://..."
                  placeholderTextColor={colors.textSecondary}
                  autoCapitalize="none"
                  keyboardType="url"
                />
              </View>
              <View style={styles.formGroup}>
                <Text
                  style={[styles.formLabel, { color: colors.textSecondary }]}
                >
                  メモ
                </Text>
                <TextInput
                  style={[
                    styles.formInput,
                    styles.formTextArea,
                    {
                      color: colors.text,
                      borderColor: colors.border,
                      backgroundColor: colors.background,
                    },
                  ]}
                  value={newCircleMemo}
                  onChangeText={setNewCircleMemo}
                  placeholder="メモ（任意）"
                  placeholderTextColor={colors.textSecondary}
                  multiline
                  numberOfLines={3}
                />
              </View>
              <View style={styles.modalButtons}>
                <Pressable
                  style={[styles.modalBtn, { borderColor: colors.border }]}
                  onPress={() => setShowAddCircle(false)}
                >
                  <Text style={{ color: colors.textSecondary }}>
                    キャンセル
                  </Text>
                </Pressable>
                <Pressable
                  style={[styles.modalBtn, { backgroundColor: colors.tint }]}
                  onPress={handleAddCircle}
                >
                  <Text style={{ color: "#fff", fontWeight: "600" }}>追加</Text>
                </Pressable>
              </View>
            </View>
          </ScrollView>
        </Pressable>
      </Modal>

      {/* イベント編集モーダル */}
      <Modal
        visible={showEditEvent}
        transparent
        animationType="fade"
        onRequestClose={() => setShowEditEvent(false)}
      >
        <Pressable
          style={styles.modalOverlay}
          onPress={() => setShowEditEvent(false)}
        >
          <View
            style={[styles.modalCard, { backgroundColor: colors.card }]}
            onStartShouldSetResponder={() => true}
          >
            <Text style={[styles.modalTitle, { color: colors.text }]}>
              イベント情報編集
            </Text>
            <View style={styles.formGroup}>
              <Text style={[styles.formLabel, { color: colors.textSecondary }]}>
                イベント名 *
              </Text>
              <TextInput
                style={[
                  styles.formInput,
                  {
                    color: colors.text,
                    borderColor: colors.border,
                    backgroundColor: colors.background,
                  },
                ]}
                value={editEventName}
                onChangeText={setEditEventName}
                placeholder="イベント名"
                placeholderTextColor={colors.textSecondary}
                autoFocus
              />
            </View>
            <View style={styles.formGroup}>
              <Text style={[styles.formLabel, { color: colors.textSecondary }]}>
                開催日
              </Text>
              <TextInput
                style={[
                  styles.formInput,
                  {
                    color: colors.text,
                    borderColor: colors.border,
                    backgroundColor: colors.background,
                  },
                ]}
                value={editEventDate}
                onChangeText={setEditEventDate}
                placeholder="例: 2026-08-15"
                placeholderTextColor={colors.textSecondary}
              />
            </View>
            <View style={styles.formGroup}>
              <Text style={[styles.formLabel, { color: colors.textSecondary }]}>
                会場
              </Text>
              <TextInput
                style={[
                  styles.formInput,
                  {
                    color: colors.text,
                    borderColor: colors.border,
                    backgroundColor: colors.background,
                  },
                ]}
                value={editEventVenue}
                onChangeText={setEditEventVenue}
                placeholder="例: 東京ビッグサイト"
                placeholderTextColor={colors.textSecondary}
              />
            </View>
            <View style={styles.formGroup}>
              <Text style={[styles.formLabel, { color: colors.textSecondary }]}>
                イベント画像
              </Text>
              <View style={styles.eventImageRow}>
                {event?.eventImageFilename ? (
                  <Pressable onPress={handlePickEventImage}>
                    <Image
                      source={{ uri: event.eventImageFilename }}
                      style={styles.eventImagePreview}
                      contentFit="cover"
                    />
                  </Pressable>
                ) : (
                  <Pressable
                    style={[
                      styles.eventImagePlaceholder,
                      { borderColor: colors.border },
                    ]}
                    onPress={handlePickEventImage}
                  >
                    <FontAwesome
                      name="camera"
                      size={20}
                      color={colors.textSecondary}
                    />
                    <Text
                      style={[
                        styles.eventImagePlaceholderText,
                        { color: colors.textSecondary },
                      ]}
                    >
                      画像を選択
                    </Text>
                  </Pressable>
                )}
                {event?.eventImageFilename && (
                  <Pressable
                    style={[styles.removeImageBtn, { borderColor: "#c62828" }]}
                    onPress={handleRemoveEventImage}
                  >
                    <FontAwesome name="trash" size={14} color="#c62828" />
                  </Pressable>
                )}
              </View>
            </View>
            <View style={styles.modalButtons}>
              <Pressable
                style={[styles.modalBtn, { borderColor: colors.border }]}
                onPress={() => setShowEditEvent(false)}
              >
                <Text style={{ color: colors.textSecondary }}>キャンセル</Text>
              </Pressable>
              <Pressable
                style={[styles.modalBtn, { backgroundColor: colors.tint }]}
                onPress={handleSaveEvent}
              >
                <Text style={{ color: "#fff", fontWeight: "600" }}>保存</Text>
              </Pressable>
            </View>
          </View>
        </Pressable>
      </Modal>

      {/* サークル編集モーダル */}
      <Modal
        visible={showEditCircle}
        transparent
        animationType="fade"
        onRequestClose={() => setShowEditCircle(false)}
      >
        <View style={styles.modalOverlay}>
          <ScrollView
            style={styles.modalScroll}
            contentContainerStyle={styles.modalScrollContent}
            keyboardShouldPersistTaps="handled"
          >
            <View
              style={[styles.modalCardWide, { backgroundColor: colors.card }]}
              onStartShouldSetResponder={() => true}
            >
              <Text style={[styles.modalTitle, { color: colors.text }]}>
                サークル編集
              </Text>
              <View style={styles.formGroup}>
                <Text
                  style={[styles.formLabel, { color: colors.textSecondary }]}
                >
                  サークル名 *
                </Text>
                <TextInput
                  style={[
                    styles.formInput,
                    {
                      color: colors.text,
                      borderColor: colors.border,
                      backgroundColor: colors.background,
                    },
                  ]}
                  value={editCircleName}
                  onChangeText={setEditCircleName}
                  placeholder="サークル名"
                  placeholderTextColor={colors.textSecondary}
                  autoFocus
                />
              </View>
              <View style={styles.formGroup}>
                <Text
                  style={[styles.formLabel, { color: colors.textSecondary }]}
                >
                  ペンネーム
                </Text>
                <TextInput
                  style={[
                    styles.formInput,
                    {
                      color: colors.text,
                      borderColor: colors.border,
                      backgroundColor: colors.background,
                    },
                  ]}
                  value={editCirclePenname}
                  onChangeText={setEditCirclePenname}
                  placeholder="ペンネーム"
                  placeholderTextColor={colors.textSecondary}
                />
              </View>
              <View style={styles.formRow}>
                <View style={[styles.formGroup, styles.formRowItem]}>
                  <Text
                    style={[styles.formLabel, { color: colors.textSecondary }]}
                  >
                    スペース
                  </Text>
                  <TextInput
                    style={[
                      styles.formInput,
                      {
                        color: colors.text,
                        borderColor: colors.border,
                        backgroundColor: colors.background,
                      },
                    ]}
                    value={editCircleSpace}
                    onChangeText={setEditCircleSpace}
                    placeholder="A-01a"
                    placeholderTextColor={colors.textSecondary}
                  />
                </View>
                <View style={[styles.formGroup, styles.formRowItem]}>
                  <Text
                    style={[styles.formLabel, { color: colors.textSecondary }]}
                  >
                    ホール
                  </Text>
                  <TextInput
                    style={[
                      styles.formInput,
                      {
                        color: colors.text,
                        borderColor: colors.border,
                        backgroundColor: colors.background,
                      },
                    ]}
                    value={editCircleHall}
                    onChangeText={setEditCircleHall}
                    placeholder="東1"
                    placeholderTextColor={colors.textSecondary}
                  />
                </View>
              </View>
              <View style={styles.formGroup}>
                <Text
                  style={[styles.formLabel, { color: colors.textSecondary }]}
                >
                  優先度
                </Text>
                <View style={styles.prioritySelectRow}>
                  {priorityOptions.map((option) => {
                    const colorNum = option.value;
                    const val = option;
                    return (
                      <Pressable
                        key={colorNum}
                        style={[
                          styles.prioritySelectBtn,
                          { borderColor: val.color },
                          editCirclePriority === colorNum && {
                            backgroundColor: val.bgColor,
                          },
                        ]}
                        onPress={() => setEditCirclePriority(colorNum)}
                      >
                        <View
                          style={[
                            styles.prioritySelectDot,
                            { backgroundColor: val.color },
                          ]}
                        />
                        <Text
                          style={[
                            styles.prioritySelectLabel,
                            { color: val.color },
                          ]}
                          numberOfLines={1}
                          adjustsFontSizeToFit
                        >
                          {val.label}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              </View>
              <View style={styles.formGroup}>
                <Text
                  style={[styles.formLabel, { color: colors.textSecondary }]}
                >
                  ジャンル
                </Text>
                <View style={styles.genreSelectWrap}>
                  {CIRCLE_GENRES.map((genre) => {
                    const selected = editCircleGenres.includes(genre);
                    return (
                      <Pressable
                        key={genre}
                        style={[
                          styles.genreSelectChip,
                          { borderColor: colors.border },
                          selected && {
                            backgroundColor: colors.tint,
                            borderColor: colors.tint,
                          },
                        ]}
                        onPress={() => toggleEditCircleGenre(genre)}
                      >
                        <Text
                          style={[
                            styles.genreSelectChipText,
                            { color: colors.textSecondary },
                            selected && { color: "#fff", fontWeight: "700" },
                          ]}
                        >
                          {genre}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              </View>
              <View style={styles.formGroup}>
                <Text
                  style={[styles.formLabel, { color: colors.textSecondary }]}
                >
                  Twitter / X
                </Text>
                <TextInput
                  style={[
                    styles.formInput,
                    {
                      color: colors.text,
                      borderColor: colors.border,
                      backgroundColor: colors.background,
                    },
                  ]}
                  value={editCircleTwitter}
                  onChangeText={setEditCircleTwitter}
                  placeholder="https://x.com/..."
                  placeholderTextColor={colors.textSecondary}
                  autoCapitalize="none"
                  keyboardType="url"
                />
              </View>
              <View style={styles.formGroup}>
                <Text
                  style={[styles.formLabel, { color: colors.textSecondary }]}
                >
                  Webサイト
                </Text>
                <TextInput
                  style={[
                    styles.formInput,
                    {
                      color: colors.text,
                      borderColor: colors.border,
                      backgroundColor: colors.background,
                    },
                  ]}
                  value={editCircleWebsite}
                  onChangeText={setEditCircleWebsite}
                  placeholder="https://..."
                  placeholderTextColor={colors.textSecondary}
                  autoCapitalize="none"
                  keyboardType="url"
                />
              </View>
              <View style={styles.formGroup}>
                <Text
                  style={[styles.formLabel, { color: colors.textSecondary }]}
                >
                  pixiv
                </Text>
                <TextInput
                  style={[
                    styles.formInput,
                    {
                      color: colors.text,
                      borderColor: colors.border,
                      backgroundColor: colors.background,
                    },
                  ]}
                  value={editCirclePixiv}
                  onChangeText={setEditCirclePixiv}
                  placeholder="https://www.pixiv.net/users/..."
                  placeholderTextColor={colors.textSecondary}
                  autoCapitalize="none"
                  keyboardType="url"
                />
              </View>
              <View style={styles.formGroup}>
                <Text
                  style={[styles.formLabel, { color: colors.textSecondary }]}
                >
                  サークル説明
                </Text>
                <TextInput
                  style={[
                    styles.formInput,
                    styles.formTextArea,
                    {
                      color: colors.text,
                      borderColor: colors.border,
                      backgroundColor: colors.background,
                    },
                  ]}
                  value={editCircleDescription}
                  onChangeText={setEditCircleDescription}
                  placeholder="作風・頒布物の説明"
                  placeholderTextColor={colors.textSecondary}
                  multiline
                  numberOfLines={2}
                />
              </View>
              <View style={styles.formRow}>
                <Pressable
                  style={[
                    styles.formRowItem,
                    {
                      flexDirection: "row",
                      alignItems: "center",
                      gap: 8,
                      paddingVertical: 8,
                    },
                  ]}
                  onPress={() => setEditCircleAbsence((v) => !v)}
                >
                  <FontAwesome
                    name={editCircleAbsence ? "check-square" : "square-o"}
                    size={20}
                    color={editCircleAbsence ? colors.danger : colors.textSecondary}
                  />
                  <Text style={{ color: colors.text }}>欠席</Text>
                </Pressable>
                <Pressable
                  style={[
                    styles.formRowItem,
                    {
                      flexDirection: "row",
                      alignItems: "center",
                      gap: 8,
                      paddingVertical: 8,
                    },
                  ]}
                  onPress={() => setEditCircleExistingOnly((v) => !v)}
                >
                  <FontAwesome
                    name={editCircleExistingOnly ? "check-square" : "square-o"}
                    size={20}
                    color={
                      editCircleExistingOnly ? colors.tint : colors.textSecondary
                    }
                  />
                  <Text style={{ color: colors.text }}>既刊のみ</Text>
                </Pressable>
              </View>
              <View style={styles.formGroup}>
                <Text
                  style={[styles.formLabel, { color: colors.textSecondary }]}
                >
                  メモ
                </Text>
                <TextInput
                  style={[
                    styles.formInput,
                    styles.formTextArea,
                    {
                      color: colors.text,
                      borderColor: colors.border,
                      backgroundColor: colors.background,
                    },
                  ]}
                  value={editCircleMemo}
                  onChangeText={setEditCircleMemo}
                  placeholder="メモ（任意）"
                  placeholderTextColor={colors.textSecondary}
                  multiline
                  numberOfLines={3}
                />
              </View>
              <View style={styles.modalButtons}>
                <Pressable
                  style={[styles.modalBtn, { borderColor: colors.border }]}
                  onPress={() => setShowEditCircle(false)}
                >
                  <Text style={{ color: colors.textSecondary }}>
                    キャンセル
                  </Text>
                </Pressable>
                <Pressable
                  style={[styles.modalBtn, { backgroundColor: colors.tint }]}
                  onPress={handleSaveEditCircle}
                >
                  <Text style={{ color: "#fff", fontWeight: "600" }}>保存</Text>
                </Pressable>
              </View>
            </View>
          </ScrollView>
        </View>
      </Modal>
      <Modal
        visible={actionMenuCircle !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setActionMenuCircle(null)}
      >
        <Pressable
          style={styles.actionMenuOverlay}
          onPress={() => setActionMenuCircle(null)}
        >
          <Pressable
            style={[styles.actionMenuCard, { backgroundColor: colors.card }]}
            onPress={(e) => e.stopPropagation()}
          >
            <Text
              style={[styles.actionMenuTitle, { color: colors.text }]}
              numberOfLines={2}
            >
              {actionMenuCircle?.name ?? ""}
            </Text>
            {actionMenuCircle && (
              <>
                <Pressable
                  style={styles.actionMenuItem}
                  onPress={() => runCircleMenuAction(handleToggleFavorite)}
                >
                  <FontAwesome
                    name={isCircleFavorite(actionMenuCircle) ? "star" : "star-o"}
                    size={18}
                    color={colors.tint}
                  />
                  <Text style={[styles.actionMenuItemText, { color: colors.text }]}>
                    {isCircleFavorite(actionMenuCircle)
                      ? "お気に入り解除"
                      : "お気に入り登録"}
                  </Text>
                </Pressable>
                <Pressable
                  style={styles.actionMenuItem}
                  onPress={() => runCircleMenuAction(handleMapPin)}
                >
                  <FontAwesome name="map-marker" size={18} color={colors.tint} />
                  <Text style={[styles.actionMenuItemText, { color: colors.text }]}>
                    {actionMenuCircle.pinX != null && actionMenuCircle.pinY != null
                      ? "ピン位置を表示"
                      : "ピンを配置"}
                  </Text>
                </Pressable>
                <Pressable
                  style={styles.actionMenuItem}
                  onPress={() => runCircleMenuAction(handleMarkCatalogNeedsRecheck)}
                >
                  <FontAwesome name="refresh" size={16} color={colors.tint} />
                  <Text style={[styles.actionMenuItemText, { color: colors.text }]}>
                    おしながき未取得に戻す
                  </Text>
                </Pressable>
                <Pressable
                  style={styles.actionMenuItem}
                  onPress={() => runCircleMenuAction(openEditCircle)}
                >
                  <FontAwesome name="pencil" size={16} color={colors.tint} />
                  <Text style={[styles.actionMenuItemText, { color: colors.text }]}>
                    編集
                  </Text>
                </Pressable>
                <Pressable
                  style={styles.actionMenuItem}
                  onPress={() => runCircleMenuAction(requestCircleReprocess)}
                >
                  <FontAwesome name="download" size={16} color={colors.tint} />
                  <Text style={[styles.actionMenuItemText, { color: colors.text }]}>
                    Xポスト再取得
                  </Text>
                </Pressable>
                <Pressable
                  style={styles.actionMenuItem}
                  onPress={() => runCircleMenuAction(handleDeleteCircle)}
                >
                  <FontAwesome name="trash" size={16} color="#c62828" />
                  <Text style={[styles.actionMenuItemText, { color: "#c62828" }]}>
                    削除
                  </Text>
                </Pressable>
              </>
            )}
          </Pressable>
        </Pressable>
      </Modal>
      <ImageViewer
        visible={catalogViewer !== null}
        uri={catalogViewer?.uri ?? ""}
        onClose={() => setCatalogViewer(null)}
        onNavigatePrevious={() => navigateCatalogViewer(-1)}
        onNavigateNext={() => navigateCatalogViewer(1)}
        canNavigatePrevious={catalogViewerIndex > 0}
        canNavigateNext={
          catalogViewerIndex >= 0 &&
          catalogViewerIndex < filteredCircles.length - 1
        }
      />
      <ImageViewer
        visible={circleCutViewer !== null}
        uri={circleCutViewer ?? ""}
        onClose={() => setCircleCutViewer(null)}
      />
    </SafeAreaView>
  );

  function renderCircleList() {
    return (
      <View style={{ flex: 1 }}>
        {/* 戻るボタン + イベント名 + アクションボタン */}
        <View
          style={[
            styles.headerBar,
            { backgroundColor: colors.card, borderBottomColor: colors.border },
          ]}
        >
          <Pressable style={styles.backBtn} onPress={() => router.back()}>
            <FontAwesome name="arrow-left" size={16} color={colors.tint} />
          </Pressable>
          <Pressable style={{ flex: 1 }} onPress={openEditEvent}>
            <Text
              style={[styles.headerTitle, { color: colors.text }]}
              numberOfLines={1}
            >
              {event?.name ?? ""}
            </Text>
          </Pressable>
          <Pressable style={styles.headerActionBtn} onPress={openAddCircle}>
            <FontAwesome name="plus" size={16} color={colors.tint} />
          </Pressable>
        </View>

        {/* フィルター・統計ヘッダー */}
        <CollapsibleHeader
          globalSearchEnabled={globalSearchEnabled}
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          statusFilter={statusFilter}
          onStatusFilterChange={setStatusFilter}
          sortBy={sortBy}
          onSortChange={setSortBy}
          priorityFilter={priorityFilter}
          onTogglePriorityFilter={togglePriorityFilter}
          hallFilter={hallFilter}
          onHallFilterChange={setHallFilter}
          halls={halls}
          genreFilter={genreFilter}
          onGenreFilterChange={setGenreFilter}
          catalogPostOnly={catalogPostOnly}
          onCatalogPostOnlyChange={setCatalogPostOnly}
          hideSkipped={hideSkipped}
          onHideSkippedChange={setHideSkipped}
          onClearPriorityFilter={clearPriorityFilter}
          stats={stats}
          budget={budget}
          filteredCount={filteredCircles.length}
          totalCount={circles.length}
          onImport={null}
          isShoppingMode={isShoppingMode}
          elapsedTime={elapsedTime}
        />

        <FlatList
          ref={flatListRef}
          data={filteredCircles}
          keyExtractor={(item) => String(item.id)}
          onScrollToIndexFailed={(info) => {
            const retry = scrollRetryCount.current;
            if (retry >= 8) return;
            scrollRetryCount.current = retry + 1;

            const estimatedOffset = Math.max(
              0,
              info.averageItemLength * info.index,
            );
            flatListRef.current?.scrollToOffset({
              offset: estimatedOffset,
              animated: false,
            });

            setTimeout(() => {
              flatListRef.current?.scrollToIndex({
                index: info.index,
                animated: true,
                viewPosition: 0,
              });
            }, 300);
          }}
          renderItem={({ item }) => (
            <>
              <CircleRow
                circle={item}
                isExpanded={expandedCircleId === item.id}
                onToggleExpand={handleToggleCircle}
                onCyclePurchaseStatus={handleCyclePurchaseStatus}
                onPurchaseStatusMenu={openPurchaseStatusMenu}
                onMapPin={handleMapPin}
                onOpenCircleCut={(circle) =>
                  circle.circleCutFilename &&
                  setCircleCutViewer(circle.circleCutFilename)
                }
                onReplaceCircleCut={openCircleCutMenu}
                onOpenActions={openCircleActionMenu}
              />
              {expandedCircleId === item.id && (
                <CircleExpandedDetail
                  circle={item}
                  onCircleUpdated={handleCircleUpdated}
                  onDeleteCircle={handleDeleteCircle}
                  onEditCircle={openEditCircle}
                  onOpenCatalogImage={openCatalogViewer}
                  reprocessRequestToken={
                    reprocessRequest && reprocessRequest.circleId === item.id
                      ? reprocessRequest.token
                      : null
                  }
                />
              )}
            </>
          )}
          ListEmptyComponent={
            <View style={styles.emptyContainer}>
              <Text style={[styles.emptyText, { color: colors.textSecondary }]}>
                {circles.length === 0
                  ? "サークルデータがありません"
                  : "フィルター条件に一致するサークルがありません"}
              </Text>
              {circles.length === 0 && (
                <Pressable
                  style={[styles.emptyAddBtn, { backgroundColor: colors.tint }]}
                  onPress={openAddCircle}
                >
                  <FontAwesome name="plus" size={14} color="#fff" />
                  <Text style={styles.emptyAddBtnText}>サークルを追加</Text>
                </Pressable>
              )}
            </View>
          }
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={colors.tint}
            />
          }
          initialNumToRender={20}
          maxToRenderPerBatch={20}
          windowSize={5}
        />
      </View>
    );
  }
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    paddingTop: Platform.OS === "android" ? StatusBar.currentHeight : 0,
  },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 32,
  },
  loadingText: {
    marginTop: 12,
    fontSize: 14,
  },
  headerBar: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 10,
  },
  backBtn: {
    width: 36,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
  },
  headerTitle: {
    fontSize: 17,
    fontWeight: "700",
    flex: 1,
  },
  pinBanner: {
    backgroundColor: "#e65100",
    paddingVertical: 8,
    paddingHorizontal: 14,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  pinBannerText: {
    color: "#fff",
    fontSize: 13,
    fontWeight: "600",
    flex: 1,
  },
  pinBannerCancel: {
    color: "#fff",
    fontSize: 13,
    fontWeight: "700",
    textDecorationLine: "underline",
    marginLeft: 8,
  },
  headerActionBtn: {
    width: 36,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
  },
  emptyContainer: {
    padding: 48,
    alignItems: "center",
  },
  emptyText: {
    fontSize: 14,
    textAlign: "center",
  },
  emptyAddBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 8,
    marginTop: 16,
  },
  emptyAddBtnText: {
    color: "#fff",
    fontSize: 14,
    fontWeight: "600",
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
    justifyContent: "center",
    alignItems: "center",
  },
  modalScroll: {
    width: "100%",
    maxHeight: "94%",
  },
  modalScrollContent: {
    flexGrow: 1,
    justifyContent: "center",
    alignItems: "center",
    paddingVertical: 24,
  },
  modalCard: {
    width: "85%",
    borderRadius: 14,
    paddingTop: 20,
    paddingBottom: 16,
  },
  modalCardWide: {
    width: "94%",
    borderRadius: 14,
    paddingTop: 20,
    paddingBottom: 16,
  },
  modalTitle: {
    fontSize: 17,
    fontWeight: "700",
    textAlign: "center",
    marginBottom: 16,
  },
  formGroup: {
    paddingHorizontal: 20,
    marginBottom: 12,
  },
  formRow: {
    flexDirection: "row",
    gap: 12,
    paddingHorizontal: 20,
  },
  formRowItem: {
    flex: 1,
    paddingHorizontal: 0,
  },
  formLabel: {
    fontSize: 12,
    fontWeight: "600",
    marginBottom: 4,
  },
  formInput: {
    borderWidth: 1,
    borderRadius: 8,
    padding: 10,
    fontSize: 14,
  },
  formTextArea: {
    minHeight: 72,
    textAlignVertical: "top" as const,
  },
  eventImageRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  eventImagePreview: {
    width: 64,
    height: 64,
    borderRadius: 8,
  },
  eventImagePlaceholder: {
    width: 64,
    height: 64,
    borderRadius: 8,
    borderWidth: 1.5,
    borderStyle: "dashed",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
  },
  eventImagePlaceholderText: {
    fontSize: 10,
  },
  removeImageBtn: {
    width: 32,
    height: 32,
    borderRadius: 6,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  prioritySelectRow: {
    flexDirection: "row",
    gap: 6,
  },
  prioritySelectBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1.5,
    gap: 4,
  },
  prioritySelectDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  prioritySelectLabel: {
    fontSize: 12,
    fontWeight: "600",
  },
  genreSelectWrap: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
  },
  genreSelectChip: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
  },
  genreSelectChipText: {
    fontSize: 12,
    fontWeight: "600",
  },
  modalButtons: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 8,
    paddingHorizontal: 20,
    marginTop: 4,
  },
  modalBtn: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "transparent",
  },
  actionMenuOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.55)",
    justifyContent: "center",
    paddingHorizontal: 28,
  },
  actionMenuCard: {
    borderRadius: 8,
    paddingVertical: 12,
  },
  actionMenuTitle: {
    fontSize: 18,
    fontWeight: "700",
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 12,
  },
  actionMenuItem: {
    minHeight: 48,
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    paddingHorizontal: 20,
  },
  actionMenuItemText: {
    flex: 1,
    fontSize: 16,
    fontWeight: "600",
  },
});
