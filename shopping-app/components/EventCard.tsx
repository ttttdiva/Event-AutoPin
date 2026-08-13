import React from "react";
import { StyleSheet, View, Text, Pressable, type ColorSchemeName } from "react-native";
import { Image } from "expo-image";
import FontAwesome from "@expo/vector-icons/FontAwesome";
import { getColors } from "@/constants/Colors";
import { PURCHASE_STATUS, PURCHASE_STATUS_LABELS } from "@/lib/types";
import type { EventSummary } from "@/lib/database";

interface EventCardProps {
  event: EventSummary;
  isExpanded?: boolean;
  onPress: (event: EventSummary) => void;
  onLongPress: (event: EventSummary) => void;
  colorScheme?: ColorSchemeName;
}

function EventCardInner({
  event,
  isExpanded = false,
  onPress,
  onLongPress,
  colorScheme,
}: EventCardProps) {
  const colors = getColors(colorScheme);
  const skippedColor = PURCHASE_STATUS_LABELS[PURCHASE_STATUS.SKIPPED].color;
  const isShoppingActive = event.shoppingStartedAt != null && event.shoppingEndedAt == null;
  const progress = event.totalCircles > 0 ? (event.boughtCircles / event.totalCircles) * 100 : 0;
  const couldntProgress = event.totalCircles > 0 ? (event.couldntBuyCircles / event.totalCircles) * 100 : 0;
  const skippedProgress = event.totalCircles > 0 ? (event.skippedCircles / event.totalCircles) * 100 : 0;
  const eventImagePath = event.eventImageFilename &&
    (event.eventImageFilename.startsWith("file://") || event.eventImageFilename.startsWith("/")
      ? event.eventImageFilename
      : null);

  return (
    <Pressable
      style={[
        styles.card,
        { backgroundColor: colors.card, borderBottomColor: colors.border },
        isExpanded && { backgroundColor: colors.tint + "10", borderLeftColor: colors.tint, borderLeftWidth: 3 },
        event.completed && { opacity: 0.45 },
      ]}
      onPress={() => onPress(event)}
      onLongPress={() => onLongPress(event)}
    >
      <View style={styles.eventRow}>
        {eventImagePath ? (
          <Image
            source={{ uri: eventImagePath }}
            style={styles.eventThumbnail}
            contentFit="cover"
            cachePolicy="memory-disk"
            recyclingKey={`event-img-${event.id}`}
            transition={100}
          />
        ) : (
          <View style={[styles.eventThumbnail, styles.eventNoImage, { backgroundColor: colorScheme === "dark" ? "#333" : "#e8e8e8" }]}>
            <Text style={[styles.eventNoImageText, { color: colors.textSecondary }]}>{event.name.charAt(0)}</Text>
          </View>
        )}
        <View style={styles.eventContent}>
          <View style={styles.headerRow}>
            <View style={styles.titleArea}>
              <Text style={[styles.eventName, { color: colors.text }]} numberOfLines={1}>{event.name}</Text>
              {event.completed && <View style={styles.completedBadge}><Text style={styles.completedBadgeText}>完了</Text></View>}
              {isShoppingActive && <View style={styles.shoppingBadge}><Text style={styles.shoppingBadgeText}>買い物中</Text></View>}
            </View>
            <FontAwesome name="chevron-right" size={12} color={colors.textSecondary} />
          </View>
          <View style={styles.metaRow}>
            {event.date && <Text style={[styles.metaText, { color: colors.textSecondary }]}>{event.date}</Text>}
            {event.venue && <Text style={[styles.metaText, { color: colors.textSecondary }]}> / {event.venue}</Text>}
          </View>
          {event.memo !== "" && <Text style={[styles.memo, { color: colors.textSecondary }]} numberOfLines={1}>
            <FontAwesome name="sticky-note-o" size={11} color={colors.textSecondary} /> {event.memo}
          </Text>}
          <View style={styles.progressRow}>
            <View style={[styles.progressBar, { backgroundColor: colors.border }]}>
              {event.totalCircles > 0 && <>
                <View style={[styles.progressFill, { backgroundColor: "#2e7d32", width: `${progress}%`, left: 0 }]} />
                <View style={[styles.progressFill, { backgroundColor: "#c62828", width: `${couldntProgress}%`, left: `${progress}%` }]} />
                <View style={[styles.progressFill, { backgroundColor: skippedColor, width: `${skippedProgress}%`, left: `${progress + couldntProgress}%` }]} />
              </>}
            </View>
            <Text style={[styles.progressText, { color: colors.textSecondary }]}>{event.boughtCircles}/{event.totalCircles}</Text>
          </View>
        </View>
      </View>
    </Pressable>
  );
}

export default React.memo(EventCardInner, (prev, next) => (
  prev.event.id === next.event.id &&
  prev.event.name === next.event.name &&
  prev.event.date === next.event.date &&
  prev.event.venue === next.event.venue &&
  prev.event.memo === next.event.memo &&
  prev.event.completed === next.event.completed &&
  prev.event.shoppingStartedAt === next.event.shoppingStartedAt &&
  prev.event.shoppingEndedAt === next.event.shoppingEndedAt &&
  prev.event.eventImageFilename === next.event.eventImageFilename &&
  prev.event.totalCircles === next.event.totalCircles &&
  prev.event.boughtCircles === next.event.boughtCircles &&
  prev.event.couldntBuyCircles === next.event.couldntBuyCircles &&
  prev.event.skippedCircles === next.event.skippedCircles &&
  prev.isExpanded === next.isExpanded &&
  prev.colorScheme === next.colorScheme &&
  prev.onPress === next.onPress &&
  prev.onLongPress === next.onLongPress
));

const styles = StyleSheet.create({
  card: { paddingVertical: 12, paddingHorizontal: 14, borderBottomWidth: StyleSheet.hairlineWidth },
  eventRow: { flexDirection: "row", alignItems: "center" },
  eventThumbnail: { width: 52, height: 52, borderRadius: 6, marginRight: 10 },
  eventNoImage: { alignItems: "center", justifyContent: "center" },
  eventNoImageText: { fontSize: 20, fontWeight: "700" },
  eventContent: { flex: 1 },
  headerRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  titleArea: { flexDirection: "row", alignItems: "center", flex: 1, gap: 8 },
  eventName: { fontSize: 16, fontWeight: "700", flexShrink: 1 },
  completedBadge: { backgroundColor: "#616161", paddingHorizontal: 8, paddingVertical: 2, borderRadius: 8 },
  completedBadgeText: { color: "#fff", fontSize: 10, fontWeight: "700" },
  shoppingBadge: { backgroundColor: "#e65100", paddingHorizontal: 8, paddingVertical: 2, borderRadius: 8 },
  shoppingBadgeText: { color: "#fff", fontSize: 10, fontWeight: "700" },
  metaRow: { flexDirection: "row", marginTop: 2 },
  metaText: { fontSize: 12 },
  memo: { fontSize: 11, marginTop: 2 },
  progressRow: { flexDirection: "row", alignItems: "center", marginTop: 6, gap: 8 },
  progressBar: { flex: 1, height: 4, borderRadius: 2, position: "relative", overflow: "hidden" },
  progressFill: { height: "100%", borderRadius: 2, position: "absolute" },
  progressText: { fontSize: 12, fontWeight: "600", minWidth: 48, textAlign: "right" },
});
