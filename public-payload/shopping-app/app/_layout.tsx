import {
  DarkTheme,
  DefaultTheme,
  ThemeProvider as NavThemeProvider,
} from "@react-navigation/native";
import { useFonts } from "expo-font";
import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { useEffect } from "react";
import { EventProvider } from "@/lib/event-context";
import { ThemeProvider, useTheme } from "@/lib/theme-context";
import { PriorityColorProvider } from "@/lib/priority-color-context";
import { checkForUpdate, showUpdateAlert } from "@/lib/update-service";

export { ErrorBoundary } from "expo-router";

export const unstable_settings = {
  initialRouteName: "(tabs)",
};

SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
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
