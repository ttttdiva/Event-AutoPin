import {
  DarkTheme,
  DefaultTheme,
  ThemeProvider as NavThemeProvider,
} from "@react-navigation/native";
import { useFonts } from "expo-font";
import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { useEffect, useRef } from "react";
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
  const rootRenderCount = useRef(0);
  if (__sqlMetricsDevOnly) {
    rootRenderCount.current += 1;
    recordUiMetric("root-render-count", rootRenderCount.current);
  }
  const [loaded, error] = useFonts({});

  useEffect(() => {
    if (error) throw error;
  }, [error]);

  useEffect(() => {
    if (loaded) {
      SplashScreen.hideAsync();
      checkForUpdate().then((result) => {
        if (result.available) {
          showUpdateAlert(result);
        }
      });
    }
  }, [loaded]);

  if (!loaded) {
    return null;
  }

  return (
    <ThemeProvider>
      <RootLayoutNav />
    </ThemeProvider>
  );
}

function RootLayoutNav() {
  const { effectiveScheme } = useTheme();

  return (
    <NavThemeProvider
      value={effectiveScheme === "dark" ? DarkTheme : DefaultTheme}
    >
      <PriorityColorProvider>
        <EventProvider>
          <Stack screenOptions={{ headerShown: false }}>
            <Stack.Screen name="(tabs)" />
            <Stack.Screen name="event/[id]" />
          </Stack>
        </EventProvider>
      </PriorityColorProvider>
    </NavThemeProvider>
  );
}
