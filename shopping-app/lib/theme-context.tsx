import React, {
  createContext,
  useContext,
  useState,
  useMemo,
  useEffect,
  useCallback,
  useRef,
} from "react";
import { Appearance, useColorScheme } from "react-native";
import { getSetting, setSetting } from "./database";
import {
  restoreStoredThemeMode,
  setNativeAppearanceForThemeMode,
  type ThemeMode,
} from "./theme-appearance";

export type { ThemeMode } from "./theme-appearance";

const THEME_SETTING_KEY = "theme_mode";

interface ThemeContextType {
  themeMode: ThemeMode;
  effectiveScheme: "light" | "dark";
  setThemeMode: (mode: ThemeMode) => void;
}

const ThemeContext = createContext<ThemeContextType>({
  themeMode: "light",
  effectiveScheme: "light",
  setThemeMode: () => {},
});

function applyNativeThemeMode(mode: ThemeMode) {
  setNativeAppearanceForThemeMode(
    mode,
    Appearance.setColorScheme?.bind(Appearance),
  );
}

export function ThemeProvider({
  children,
  onHydrated,
}: {
  children: React.ReactNode;
  onHydrated?: () => void;
}) {
  const systemScheme = useColorScheme();
  const [themeMode, setThemeModeState] = useState<ThemeMode>("light");
  const [isHydrated, setIsHydrated] = useState(false);
  const hydrationRevision = useRef(0);

  // 保存値を読み、nativeへ反映を要求してから画面を表示する。
  useEffect(() => {
    let active = true;
    const startedAtRevision = hydrationRevision.current;

    void restoreStoredThemeMode({
      readStoredMode: () => getSetting(THEME_SETTING_KEY),
      isCurrent: () =>
        active && hydrationRevision.current === startedAtRevision,
      applyNativeMode: applyNativeThemeMode,
      setThemeMode: setThemeModeState,
      onHydrated: () => {
        setIsHydrated(true);
        onHydrated?.();
      },
    });

    return () => {
      active = false;
    };
  }, [onHydrated]);

  // 明示変更は復元中の非同期読み込みより優先する。
  const setThemeMode = useCallback((mode: ThemeMode) => {
    hydrationRevision.current += 1;
    applyNativeThemeMode(mode);
    setThemeModeState(mode);
    if (!isHydrated) {
      onHydrated?.();
      setIsHydrated(true);
    }
    setSetting(THEME_SETTING_KEY, mode).catch(() => {});
  }, [isHydrated, onHydrated]);

  const effectiveScheme = useMemo(() => {
    if (themeMode === "auto") {
      return systemScheme === "dark" ? "dark" : "light";
    }
    return themeMode;
  }, [themeMode, systemScheme]);

  return (
    <ThemeContext.Provider value={{ themeMode, effectiveScheme, setThemeMode }}>
      {isHydrated ? children : null}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}
