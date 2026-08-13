import { StyleSheet, View, Text, Pressable } from 'react-native';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { getColors } from '@/constants/Colors';
import { useTheme } from '@/lib/theme-context';
import type { ViewMode } from '@/lib/event-context';

interface BottomBarProps {
  viewMode: ViewMode;
  onViewModeChange: (mode: ViewMode) => void;
}

export default function BottomBar({ viewMode, onViewModeChange }: BottomBarProps) {
  const { effectiveScheme } = useTheme();
  const colors = getColors(effectiveScheme);

  return (
    <View style={[styles.container, { backgroundColor: colors.card, borderTopColor: colors.border }]}>
      <Pressable
        style={[styles.btn, viewMode === 'split' && { backgroundColor: colors.tint + '20' }]}
        onPress={() => onViewModeChange(viewMode === 'split' ? 'list' : 'split')}
      >
        <FontAwesome name="columns" size={16} color={viewMode === 'split' ? colors.tint : colors.textSecondary} />
        <Text style={[styles.btnText, { color: viewMode === 'split' ? colors.tint : colors.textSecondary }]}>
          マップ半分
        </Text>
      </Pressable>

      <Pressable
        style={[styles.btn, viewMode === 'map' && { backgroundColor: colors.tint + '20' }]}
        onPress={() => onViewModeChange(viewMode === 'map' ? 'list' : 'map')}
      >
        <FontAwesome name="map" size={16} color={viewMode === 'map' ? colors.tint : colors.textSecondary} />
        <Text style={[styles.btnText, { color: viewMode === 'map' ? colors.tint : colors.textSecondary }]}>
          マップのみ
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingVertical: 6,
    paddingHorizontal: 16,
    gap: 12,
  },
  btn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 8,
    borderRadius: 8,
    gap: 6,
  },
  btnText: {
    fontSize: 13,
    fontWeight: '600',
  },
});
