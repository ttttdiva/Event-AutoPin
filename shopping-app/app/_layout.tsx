import {
  DarkTheme,
  DefaultTheme,
  ThemeProvider as NavThemeProvider,
} from "@react-navigation/native";
import { useFonts } from "expo-font";
import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { useCallback, useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { KeyboardViewport } from "@/components/KeyboardLayout";
import { getColors } from "@/constants/Colors";
import { EventProvider } from "@/lib/event-context";
import { ThemeProvider, useTheme } from "@/lib/theme-context";
import { PriorityColorProvider } from "@/lib/priority-color-context";
import { checkForUpdate, showUpdateAlert } from "@/lib/update-service";
import {
  __sqlMetricsDevOnly,
  installDevPerformanceBridge,
  recordUiMetric,
} from "@/lib/performance";

export { ErrorBoundary } from "expo-router";

export const unstable_settings = {
  initialRouteName: "(tabs)",
};

SplashScreen.preventAutoHideAsync();
installDevPerformanceBridge();

export default function RootLayout() {
  const [themeHydrated, setThemeHydrated] = useState(false);
  const rootRenderCount = useRef(0);
  if (__sqlMetricsDevOnly) {
    rootRenderCount.current += 1;
    recordUiMetric("root-render-count", rootRenderCount.current);
  }
  const [loaded, error] = useFonts({});
  const handleThemeHydrated = useCallback(() => {
    void SplashScreen.hideAsync();
    setThemeHydrated(true);
  }, []);

  useEffect(() => {
    if (error) throw error;
  }, [error]);

  useEffect(() => {
    if (loaded && themeHydrated) {
      checkForUpdate().then((result) => {
        if (result.available) {
          showUpdateAlert(result);
        }
      });
    }
  }, [loaded, themeHydrated]);

  if (!loaded) {
    return null;
  }

  return (
    <KeyboardProvider preload={false} statusBarTranslucent preserveEdgeToEdge>
      <KeyboardViewport>
        <ThemeProvider onHydrated={handleThemeHydrated}>
          <RootLayoutNav />
        </ThemeProvider>
      </KeyboardViewport>
    </KeyboardProvider>
  );
}

function RootLayoutNav() {
  const { effectiveScheme } = useTheme();
  const colors = getColors(effectiveScheme);
  return (
    <NavThemeProvider
      value={effectiveScheme === "dark" ? DarkTheme : DefaultTheme}
    >
      <View style={{ flex: 1, backgroundColor: colors.background }}>
        <PriorityColorProvider>
          <EventProvider>
            <Stack screenOptions={{ headerShown: false }}>
              <Stack.Screen name="(tabs)" />
              <Stack.Screen name="event/[id]" />
            </Stack>
          </EventProvider>
        </PriorityColorProvider>
      </View>
    </NavThemeProvider>
  );
}
