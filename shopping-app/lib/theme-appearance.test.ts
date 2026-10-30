import {
  normalizeThemeMode,
  restoreStoredThemeMode,
  setNativeAppearanceForThemeMode,
  type AppearanceColorScheme,
  type ThemeMode,
} from "./theme-appearance";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export async function runThemeAppearanceTests() {
  const applied: Array<AppearanceColorScheme> = [];
  const setColorScheme = (scheme: AppearanceColorScheme) => applied.push(scheme);

  const modes: ThemeMode[] = ["light", "dark", "auto"];
  for (const mode of modes) {
    setNativeAppearanceForThemeMode(mode, setColorScheme);
  }

  assert(
    applied.length === 3 &&
      applied[0] === "light" &&
      applied[1] === "dark" &&
      applied[2] === null,
    "explicit themes override native appearance and auto restores the system setting",
  );

  const webWithoutNativeSetterDoesNotThrow = (() => {
    try {
      setNativeAppearanceForThemeMode("light", undefined);
      return true;
    } catch {
      return false;
    }
  })();
  assert(
    webWithoutNativeSetterDoesNotThrow,
    "React Native Web without Appearance.setColorScheme must still hydrate",
  );

  assert(normalizeThemeMode("dark") === "dark", "保存済みdarkを復元する");
  assert(normalizeThemeMode("auto") === "auto", "保存済みautoを復元する");
  assert(normalizeThemeMode("invalid") === "light", "不正値はlightへ戻す");

  let restoredAutoScheme: AppearanceColorScheme | undefined;
  let restoredAutoMode: ThemeMode | null = null;
  await restoreStoredThemeMode({
    readStoredMode: async () => "auto",
    isCurrent: () => true,
    applyNativeMode: (mode) =>
      setNativeAppearanceForThemeMode(mode, (scheme) => {
        restoredAutoScheme = scheme;
      }),
    setThemeMode: (mode) => {
      restoredAutoMode = mode;
    },
    onHydrated: () => {},
  });
  assert(
    restoredAutoMode === "auto" && restoredAutoScheme === null,
    "再起動時のautoはnative overrideを解除して端末設定へ戻す",
  );

  const restoreOrder: string[] = [];
  let restoredMode: ThemeMode | null = null;
  await restoreStoredThemeMode({
    readStoredMode: async () => "dark",
    isCurrent: () => true,
    applyNativeMode: (mode) => {
      restoreOrder.push(`native:${mode}`);
    },
    setThemeMode: (mode) => {
      restoreOrder.push(`js:${mode}`);
      restoredMode = mode;
    },
    onHydrated: () => restoreOrder.push("hydrated"),
  });
  assert(
    restoredMode === "dark" &&
      restoreOrder.join(",") === "native:dark,js:dark,hydrated",
    "nativeテーマ変更を要求してからJS状態を更新しhydrationを完了する",
  );

  let resolveStoredMode!: (mode: unknown) => void;
  let revision = 0;
  let currentMode: ThemeMode = "light";
  const raceNativeModes: ThemeMode[] = [];
  const pendingRestore = restoreStoredThemeMode({
    readStoredMode: () =>
      new Promise((resolve) => {
        resolveStoredMode = resolve;
      }),
    isCurrent: () => revision === 0,
    applyNativeMode: (mode) => raceNativeModes.push(mode),
    setThemeMode: (mode) => {
      currentMode = mode;
    },
    onHydrated: () => {},
  });

  revision += 1;
  currentMode = "dark";
  raceNativeModes.push("dark");
  resolveStoredMode("light");
  await pendingRestore;
  assert(
    currentMode === "dark" &&
      raceNativeModes.length === 1 &&
      raceNativeModes[0] === "dark",
    "遅れて返った保存値は明示変更を上書きしない",
  );

  const failedReadOrder: string[] = [];
  await restoreStoredThemeMode({
    readStoredMode: async () => {
      throw new Error("storage unavailable");
    },
    isCurrent: () => true,
    applyNativeMode: (mode) => failedReadOrder.push(`native:${mode}`),
    setThemeMode: (mode) => failedReadOrder.push(`js:${mode}`),
    onHydrated: () => failedReadOrder.push("hydrated"),
  });
  assert(
    failedReadOrder.join(",") === "native:light,js:light,hydrated",
    "保存領域のエラー時もlightへ揃えてhydrationを完了する",
  );
}
