import { createLoadEpochGuard } from "./event-load-epoch";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export async function runEventLoadEpochTests(): Promise<void> {
  const guard = createLoadEpochGuard();
  const first = guard.next();
  const second = guard.next();
  assert(!guard.isCurrent(first), "古い要求は commit できない");
  assert(guard.isCurrent(second), "最新要求だけ commit できる");

  // A delete/memo/status mutation fences a load at start and again at commit;
  // the pre-mutation response must never resurrect the deleted row.
  const inFlightBeforeDelete = guard.next();
  guard.next(); // mutation started
  guard.next(); // mutation committed/local patch applied
  assert(
    !guard.isCurrent(inFlightBeforeDelete),
    "delete commit must prevent old list response resurrection",
  );
  await runEventListLoadUiTests();
}

// 実画面のhooks/JSX契約を検証する。native描画やSQLite自体の検証ではない。
async function runEventListLoadUiTests(): Promise<void> {
  const Module = require("node:module");
  const originalLoad = Module._load;
  const componentPath = require.resolve("../app/(tabs)/index");
  const previousModule = require.cache[componentPath];
  const previousError = console.error;
  const hooks: any[] = [];
  let cursor = 0;
  let dirty = false;
  let effects: Array<() => void> = [];
  let disposed = false;
  let lateUpdates = 0;
  const focus: { start: (() => (() => void) | void) | null; cleanup: (() => void) | void } = {
    start: null, cleanup: undefined,
  };
  const requests: Array<{ resolve: (rows: any[]) => void; reject: (error: Error) => void }> = [];
  const jsx = (type: any, props: any) => ({ type, props });
  const changed = (previous: any, deps: any[]) => !previous || deps.some((value, i) => !Object.is(value, previous.deps[i]));
  const react: any = {
    useState(initial: any) {
      const index = cursor++;
      if (!(index in hooks)) hooks[index] = { value: typeof initial === "function" ? initial() : initial };
      return [hooks[index].value, (next: any) => {
        if (disposed) lateUpdates++;
        const value = typeof next === "function" ? next(hooks[index].value) : next;
        if (!Object.is(value, hooks[index].value)) dirty = true;
        hooks[index].value = value;
      }];
    },
    useRef(initial: any) {
      const index = cursor++;
      if (!(index in hooks)) hooks[index] = { current: initial };
      return hooks[index];
    },
    useMemo(factory: () => any, deps: any[]) {
      const index = cursor++;
      if (changed(hooks[index], deps)) hooks[index] = { deps, value: factory() };
      return hooks[index].value;
    },
    useEffect(effect: () => any, deps: any[]) {
      const index = cursor++;
      if (changed(hooks[index], deps)) effects.push(() => {
        hooks[index]?.cleanup?.();
        hooks[index] = { deps, cleanup: effect() };
      });
    },
  };
  react.useCallback = (callback: any, deps: any[]) => react.useMemo(() => callback, deps);
  const mocks: Record<string, any> = {
    react,
    "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "Fragment" },
    "react-native": {
      StyleSheet: { create: (value: any) => value }, View: "View", Text: "Text", FlatList: "FlatList",
      ActivityIndicator: "ActivityIndicator", RefreshControl: "RefreshControl", Alert: { alert() {} },
      Modal: "Modal", Pressable: "Pressable", StatusBar: "StatusBar", Platform: { OS: "android" },
    },
    "expo-router": { useRouter: () => ({ push() {} }) },
    "@react-navigation/native": {
      useFocusEffect(callback: any) {
        react.useEffect(() => { focus.start = callback; focus.cleanup = callback(); return () => { focus.cleanup?.(); }; }, [callback]);
      },
    },
    "expo-camera": { CameraView: "CameraView", useCameraPermissions: () => [null, () => {}] },
    "@/lib/event-context": { useEvent: () => ({ setCurrentEventId() {} }) },
    "@/lib/theme-context": { useTheme: () => ({ effectiveScheme: "dark" }) },
    "@/lib/database": {
      getEventSummaries: () => new Promise((resolve, reject) => requests.push({ resolve, reject })),
      getSetting: async () => null, setSetting: async () => {},
    },
    "@/components/KeyboardLayout": { InputTextInput: "TextInput", InputModal: "InputModal", InputScrollView: "InputScrollView" },
    "@/lib/import-helpers": {}, "@/lib/sync-logger": {},
    "@/constants/Colors": { getColors: () => ({ tint: "purple", text: "white", textSecondary: "gray" }) },
    "expo-file-system/legacy": {}, "expo-sharing": {}, "@expo/vector-icons/FontAwesome": "FontAwesome",
    "@/components/ScreenSafeArea": { ScreenSafeArea: "ScreenSafeArea" }, "@/components/EventCard": "EventCard",
    "@/lib/performance": {
      beginSqlMetricsScope: () => () => ({ count: 0, elapsedMs: 0, wallElapsedMs: 0 }),
      recordUiMetric() {}, recordUiMetricAfterPaint() {}, startUiMetric: () => 0,
    },
    "@/lib/event-load-epoch": { createLoadEpochGuard },
    "@/lib/text-collation": { compareJaText: (a: string, b: string) => a.localeCompare(b) },
  };
  Module._load = function (request: string, parent: any, isMain: boolean) {
    if (Object.prototype.hasOwnProperty.call(mocks, request)) return mocks[request];
    return originalLoad.call(this, request, parent, isMain);
  };
  console.error = () => {};
  function find(node: any, predicate: (node: any) => boolean): any[] {
    if (Array.isArray(node)) return node.flatMap((child) => find(child, predicate));
    if (!node?.props) return [];
    return [...(predicate(node) ? [node] : []), ...find(node.props.children, predicate)];
  }
  function textOf(node: any): string {
    if (Array.isArray(node)) return node.map(textOf).join("");
    if (node?.props) return textOf(node.props.children);
    return typeof node === "string" ? node : "";
  }
  const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
  try {
    delete require.cache[componentPath];
    const Screen = require("../app/(tabs)/index").default;
    const render = () => {
      let tree: any;
      let remaining = 10;
      do {
        assert(remaining-- > 0, "画面描画は収束すること");
        cursor = 0; dirty = false; effects = [];
        tree = Screen();
        effects.forEach((effect) => effect());
      } while (dirty);
      return tree;
    };
    const list = (tree: any) => find(tree, (node) => node.type === "FlatList")[0];
    const retry = (tree: any) => find(tree, (node) => node.props.accessibilityLabel === "イベント一覧を再読み込み")[0];
    let tree = render();
    assert(requests.length === 1, "focusで一度だけ一覧を読むこと");
    requests[0].reject(new Error("ERR_INVALID_SHARED_OBJECT_ID")); await flush(); tree = render();
    assert(textOf(tree).includes("イベントを読み込めませんでした"), "初回失敗は明示すること");
    assert(list(tree).props.ListEmptyComponent === null, "初回失敗を空一覧/インポート案内にしないこと");
    const retryButton = retry(tree);
    retryButton.props.onPress(); retryButton.props.onPress(); retryButton.props.onPress();
    assert(Number(requests.length) === 2, "同じ再読込ボタンの連打は一要求にまとめること");
    const row = { id: 56, name: "検証イベント", importedAt: "2026-10-03" };
    requests[1].resolve([row]); await flush(); tree = render();
    assert(list(tree).props.data[0].id === 56 && !retry(tree), "再読込成功で一覧復旧・エラー解除すること");
    list(tree).props.refreshControl.props.onRefresh();
    requests[2].reject(new Error("read failed")); await flush(); tree = render();
    assert(list(tree).props.data[0].id === 56 && retry(tree), "更新失敗は既存一覧を保持して再試行を表示すること");
    retry(tree).props.onPress();
    focus.cleanup?.(); focus.cleanup = focus.start!();
    assert(Number(requests.length) === 5, "blur後のrefocusは古い要求を待たず新要求を開始すること");
    requests[4].resolve([row]); await flush(); tree = render();
    requests[3].reject(new Error("stale failure")); await flush(); tree = render();
    assert(!retry(tree) && list(tree).props.data[0].id === 56, "旧画面の失敗が新しい成功を上書きしないこと");
    list(tree).props.refreshControl.props.onRefresh();
    focus.cleanup?.(); focus.cleanup = focus.start!();
    requests[6].reject(new Error("latest failure")); await flush(); tree = render();
    requests[5].resolve([]); await flush(); tree = render();
    assert(retry(tree) && list(tree).props.data[0].id === 56, "古い0件成功が新しい失敗/既存一覧を上書きしないこと");
    retry(tree).props.onPress();
    requests[7].resolve([]); await flush(); tree = render();
    assert(textOf(list(tree).props.ListEmptyComponent).includes("イベントデータがありません"), "成功した0件のみ空表示を許可すること");
    list(tree).props.refreshControl.props.onRefresh();
    disposed = true;
    hooks.forEach((hook) => hook?.cleanup?.());
    requests[8].reject(new Error("unmounted")); await flush();
    assert(lateUpdates === 0, "unmount後の失敗/finallyはstateを更新しないこと");
  } finally {
    Module._load = originalLoad;
    console.error = previousError;
    delete require.cache[componentPath];
    if (previousModule) require.cache[componentPath] = previousModule;
  }
}
