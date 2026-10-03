import { Platform, type StyleProp, type ViewStyle } from "react-native";
import { SafeAreaView, type Edge } from "react-native-safe-area-context";
import type { ReactNode } from "react";

/**
 * 画面ルートのsafe area。
 * Androidはedge-to-edgeで描画するため、ステータスバー分(top)だけを実測insetで避ける。
 * StatusBar.currentHeightの固定値や親側のoffsetと併用しない（二重適用・余白過多の原因）。
 * Androidの下端はタブバー/BottomBar側の既存レイアウトを維持し、iOSは従来のSafeAreaView同様に全辺を扱う。
 */
const SCREEN_EDGES: readonly Edge[] =
  Platform.OS === "ios" ? ["top", "right", "bottom", "left"] : ["top"];

export function ScreenSafeArea({
  style,
  children,
}: {
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
}) {
  return (
    <SafeAreaView style={style} edges={SCREEN_EDGES}>
      {children}
    </SafeAreaView>
  );
}
