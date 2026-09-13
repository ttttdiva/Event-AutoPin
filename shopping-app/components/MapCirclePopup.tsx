import { useState } from 'react';
import { Text, StyleSheet } from 'react-native';
import { Image } from 'expo-image';
import Animated, { useAnimatedStyle, type SharedValue } from 'react-native-reanimated';
import { placeMapPopup, type PopupRect } from '@/lib/map-popup-layout';
import type { Circle } from '@/lib/types';

export default function MapCirclePopup({ circle, pin, viewport, scale, translateX, translateY, color }: {
  circle: Circle; pin: PopupRect; viewport: { width: number; height: number };
  scale: SharedValue<number>; translateX: SharedValue<number>; translateY: SharedValue<number>; color: string;
}) {
  const [height, setHeight] = useState(0);
  const width = Math.min(220, Math.max(1, viewport.width - 16));
  const animatedStyle = useAnimatedStyle(() => {
    const position = placeMapPopup(pin, scale.value, translateX.value, translateY.value, viewport, { width, height });
    return { left: position.left, top: position.top, opacity: position.visible && height > 0 ? 1 : 0 };
  });
  const hasImage = circle.circleCutFilename && /^(file:\/\/|\/)/.test(circle.circleCutFilename);
  return (
    <Animated.View pointerEvents="none" onLayout={(e) => setHeight(e.nativeEvent.layout.height)}
      style={[styles.popup, { width, maxHeight: Math.max(1, viewport.height - 16), borderLeftColor: color }, animatedStyle]}>
      {hasImage && viewport.height > 220 && <Image source={{ uri: circle.circleCutFilename! }} style={styles.image} contentFit="cover" />}
      <Text style={styles.space} numberOfLines={1}>選択中: {circle.hall ?? ''}{circle.space ?? ''}</Text>
      <Text style={styles.name} numberOfLines={1}>{circle.name}</Text>
      {!!circle.penname && <Text style={styles.space} numberOfLines={1}>{circle.penname}</Text>}
    </Animated.View>
  );
}
const styles = StyleSheet.create({
  popup: { position: 'absolute', backgroundColor: 'rgba(15,23,42,0.88)', padding: 8,
    borderRadius: 6, borderLeftWidth: 4, alignItems: 'center', zIndex: 200, overflow: 'hidden' },
  image: { width: 80, height: 80, borderRadius: 4, marginBottom: 4 },
  name: { color: '#fff', fontSize: 12, fontWeight: '600' },
  space: { color: '#fff', fontSize: 11 },
});
