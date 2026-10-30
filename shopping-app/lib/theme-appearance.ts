export type ThemeMode = "light" | "dark" | "auto";

export type AppearanceColorScheme = "light" | "dark" | null;

export function normalizeThemeMode(value: unknown): ThemeMode {
  return value === "light" || value === "dark" || value === "auto"
    ? value
    : "light";
}

/**
 * Request RN Android to update the Activity's DayNight theme. Auto removes the
 * app override and follows the device; with edge-to-edge bars, that native
 * theme supplies the window surface visible behind transparent system bars.
 */
export function setNativeAppearanceForThemeMode(
  mode: ThemeMode,
  setColorScheme: ((scheme: AppearanceColorScheme) => void) | undefined,
): void {
  // React Native Web does not implement Appearance.setColorScheme.
  if (typeof setColorScheme !== "function") return;
  setColorScheme(mode === "auto" ? null : mode);
}

export async function restoreStoredThemeMode(options: {
  readStoredMode: () => Promise<unknown>;
  isCurrent: () => boolean;
  applyNativeMode: (mode: ThemeMode) => void;
  setThemeMode: (mode: ThemeMode) => void;
  onHydrated: () => void;
}): Promise<void> {
  let storedMode: unknown;
  try {
    storedMode = await options.readStoredMode();
  } catch {
    storedMode = null;
  }

  if (!options.isCurrent()) return;

  const mode = normalizeThemeMode(storedMode);
  options.applyNativeMode(mode);
  options.setThemeMode(mode);
  options.onHydrated();
}
