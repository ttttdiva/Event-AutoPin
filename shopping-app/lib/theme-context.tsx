import React, {
  createContext,
  useContext,
  useState,
  useMemo,
  useEffect,
  useCallback,
} from "react";
import { useColorScheme } from "react-native";
import { getSetting, setSetting } from "./database";

export type ThemeMode = "light" | "dark" | "auto";

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

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const systemScheme = useColorScheme();
  const [themeMode, setThemeModeState] = useState<ThemeMode>("light");

  // 起動時にDBから読み込み
  useEffect(() => {
    getSetting(THEME_SETTING_KEY)
      .then((saved) => {
        if (saved === "light" || saved === "dark" || saved === "auto") {
          setThemeModeState(saved);
        }
      })
      .catch(() => {});
  }, []);

  // テーマ変更時にDBに保存
  const setThemeMode = useCallback((mode: ThemeMode) => {
    setThemeModeState(mode);
    setSetting(THEME_SETTING_KEY, mode).catch(() => {});
  }, []);

  const effectiveScheme = useMemo(() => {
    if (themeMode === "auto") {
      return systemScheme === "dark" ? "dark" : "light";
    }
    return themeMode;
  }, [themeMode, systemScheme]);

  return (
    <ThemeContext.Provider value={{ themeMode, effectiveScheme, setThemeMode }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}
