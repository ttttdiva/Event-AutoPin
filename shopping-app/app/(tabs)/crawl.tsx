import { useState } from "react";
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { router } from "expo-router";
import FontAwesome from "@expo/vector-icons/FontAwesome";
import { useTheme } from "@/lib/theme-context";
import { getColors } from "@/constants/Colors";
import { crawlPreview, crawlCommit } from "@/lib/crawl/pipeline";
import type { CrawlResult, CrawlProgress } from "@/lib/crawl/types";

export default function CrawlScreen() {
  const { effectiveScheme } = useTheme();
  const colors = getColors(effectiveScheme);

  const [url, setUrl] = useState("");
  const [eventName, setEventName] = useState("");
  const [downloadImages, setDownloadImages] = useState(true);
  const [analyzeCuts, setAnalyzeCuts] = useState(false);
  const [fetchTwitter, setFetchTwitter] = useState(false);

  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<CrawlResult | null>(null);
  const [progress, setProgress] = useState<CrawlProgress | null>(null);

  const onProgress = (p: CrawlProgress) => setProgress(p);

  const runPreview = async () => {
    if (!url.trim()) {
      Alert.alert("URL未入力", "クロール対象のURLを入力してください");
      return;
    }
    setBusy(true);
    setPreview(null);
    setProgress({ phase: "fetch", message: "取得中..." });
    try {
      const result = await crawlPreview(
        { url: url.trim(), eventNameHint: eventName.trim() || undefined },
        onProgress,
      );
      if (!result.circles.length) {
        Alert.alert(
          "サークルが見つかりませんでした",
          "URLやCookie設定を確認してください",
        );
      }
      setPreview(result);
    } catch (e: any) {
      Alert.alert("プレビュー失敗", e?.message ?? String(e));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  const runCommit = async () => {
    if (!preview) return;
    setBusy(true);
    setProgress({ phase: "save", message: "DBに保存中..." });
    try {
      const commitResult = await crawlCommit(
        preview,
        {
          url: url.trim(),
          eventNameHint: eventName.trim() || undefined,
          downloadImages,
          analyzeCircleCuts: analyzeCuts,
          fetchTwitterCatalog: fetchTwitter,
        },
        onProgress,
      );
      const twitter = commitResult.twitterProcessing;
      const twitterLines = twitter
        ? [
            "",
            `Xクロール: 成功 ${twitter.successCount}件 / 未検出 ${twitter.notFoundCount}件 / 失敗 ${twitter.errorCount}件 / スキップ ${twitter.skippedCount}件`,
            twitter.invalidUrlCount ? `不正なX URLを除外: ${twitter.invalidUrlCount}件` : "",
            ...twitter.details
              .filter((detail) => detail.status === "error" || detail.status === "skipped")
              .slice(0, 3)
              .map((detail) => `${detail.circleName}: ${detail.reason ?? detail.status}`),
          ].filter(Boolean)
        : [];
      Alert.alert(
        twitter && twitter.errorCount > 0 ? "取り込み完了（一部失敗）" : "完了",
        `${preview.circles.length} 件のサークルを取り込みました${twitterLines.join("\n")}`,
        [
          {
            text: "開く",
            onPress: () => router.push(`/event/${commitResult.eventId}`),
          },
          { text: "OK" },
        ],
      );
      setPreview(null);
      setUrl("");
      setEventName("");
    } catch (e: any) {
      Alert.alert("保存失敗", e?.message ?? String(e));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  return (
    <ScrollView
      style={[styles.container, { backgroundColor: colors.background }]}
      contentContainerStyle={styles.content}
    >
      <Text style={[styles.h1, { color: colors.text }]}>クロール</Text>
      <Text style={[styles.hint, { color: colors.textSecondary }]}>
        イベントサイトのURLを指定するとLLMが解析してサークルリストを抽出します。
      </Text>

      <Text style={[styles.label, { color: colors.text }]}>
        URL *（複数行可）
      </Text>
      <TextInput
        style={[
          styles.input,
          styles.urlInput,
          {
            color: colors.text,
            backgroundColor: colors.inputBackground,
            borderColor: colors.border,
          },
        ]}
        placeholder={"https://...\nhttps://..."}
        placeholderTextColor={colors.textSecondary}
        value={url}
        onChangeText={setUrl}
        multiline
        textAlignVertical="top"
        autoCapitalize="none"
        autoCorrect={false}
      />

      <Text style={[styles.label, { color: colors.text }]}>
        イベント名（任意・自動抽出の上書き用）
      </Text>
      <TextInput
        style={[
          styles.input,
          {
            color: colors.text,
            backgroundColor: colors.inputBackground,
            borderColor: colors.border,
          },
        ]}
        placeholder="例: サンクリ2026 Spring"
        placeholderTextColor={colors.textSecondary}
        value={eventName}
        onChangeText={setEventName}
      />

      <Text style={[styles.sectionTitle, { color: colors.text }]}>オプション</Text>

      <View style={[styles.row, { borderColor: colors.border }]}>
        <Text style={[styles.rowLabel, { color: colors.text }]}>
          サークルカット画像をダウンロード
        </Text>
        <Switch value={downloadImages} onValueChange={setDownloadImages} />
      </View>
      <View style={[styles.row, { borderColor: colors.border }]}>
        <Text style={[styles.rowLabel, { color: colors.text }]}>
          画像解析でジャンル推定（LLM課金・時間かかる）
        </Text>
        <Switch
          value={analyzeCuts}
          onValueChange={setAnalyzeCuts}
          disabled={!downloadImages}
        />
      </View>
      <View style={[styles.row, { borderColor: colors.border }]}>
        <Text style={[styles.rowLabel, { color: colors.text }]}>
          Grokで「おしながき」を取得（要xAIキー・Grok有効化）
        </Text>
        <Switch value={fetchTwitter} onValueChange={setFetchTwitter} />
      </View>

      <TouchableOpacity
        style={[
          styles.primaryBtn,
          { backgroundColor: busy ? colors.textSecondary : colors.tint },
        ]}
        onPress={runPreview}
        disabled={busy}
      >
        {busy && !preview ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text style={styles.primaryBtnText}>プレビュー（解析）</Text>
        )}
      </TouchableOpacity>

      {progress && (
        <View
          style={[
            styles.progressBox,
            { backgroundColor: colors.card, borderColor: colors.border },
          ]}
        >
          <Text style={{ color: colors.text, fontWeight: "600" }}>
            {progress.phase}
            {progress.total
              ? ` (${progress.current ?? 0}/${progress.total})`
              : ""}
          </Text>
          {progress.message && (
            <Text style={{ color: colors.textSecondary, marginTop: 4 }}>
              {progress.message}
            </Text>
          )}
        </View>
      )}

      {preview && (
        <View
          style={[
            styles.previewBox,
            { backgroundColor: colors.card, borderColor: colors.border },
          ]}
        >
          <Text style={[styles.previewTitle, { color: colors.text }]}>
            プレビュー結果
          </Text>
          <Text style={[styles.previewRow, { color: colors.text }]}>
            <Text style={{ fontWeight: "700" }}>イベント:</Text>{" "}
            {preview.event.name}
          </Text>
          {preview.event.date && (
            <Text style={[styles.previewRow, { color: colors.text }]}>
              <Text style={{ fontWeight: "700" }}>日付:</Text>{" "}
              {preview.event.date}
            </Text>
          )}
          {preview.event.venue && (
            <Text style={[styles.previewRow, { color: colors.text }]}>
              <Text style={{ fontWeight: "700" }}>会場:</Text>{" "}
              {preview.event.venue}
            </Text>
          )}
          <Text style={[styles.previewRow, { color: colors.text }]}>
            <Text style={{ fontWeight: "700" }}>サークル数:</Text>{" "}
            {preview.circles.length} 件
          </Text>
          <Text style={[styles.previewRow, { color: colors.text }]}>
            <Text style={{ fontWeight: "700" }}>アダプター:</Text>{" "}
            {preview.adapterName}
          </Text>
          {preview.event.source_events && preview.event.source_events.length > 1 && (
            <Text style={[styles.previewRow, { color: colors.text }]}>
              <Text style={{ fontWeight: "700" }}>併催元:</Text>{" "}
              {preview.event.source_events.length} 件
            </Text>
          )}

          <Text style={[styles.sampleHeader, { color: colors.textSecondary }]}>
            先頭 5 件:
          </Text>
          {preview.circles.slice(0, 5).map((c, i) => (
            <View
              key={i}
              style={[
                styles.sampleRow,
                { borderColor: colors.border },
              ]}
            >
              <Text style={{ color: colors.text, fontWeight: "600" }}>
                {c.space ? `[${c.space}] ` : ""}
                {c.name}
              </Text>
              {c.penname && (
                <Text style={{ color: colors.textSecondary, fontSize: 12 }}>
                  {c.penname}
                </Text>
              )}
            </View>
          ))}

          <View style={styles.actionRow}>
            <TouchableOpacity
              style={[
                styles.secondaryBtn,
                { borderColor: colors.border, backgroundColor: colors.card },
              ]}
              onPress={() => setPreview(null)}
              disabled={busy}
            >
              <Text style={{ color: colors.text, fontWeight: "600" }}>
                やり直す
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[
                styles.primaryBtn,
                {
                  backgroundColor: busy ? colors.textSecondary : colors.checked,
                  flex: 1,
                },
              ]}
              onPress={runCommit}
              disabled={busy}
            >
              {busy ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.primaryBtnText}>
                  <FontAwesome name="check" size={14} color="#fff" /> 確定して取り込み
                </Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      )}
      <View style={{ height: 40 }} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { padding: 16 },
  h1: { fontSize: 24, fontWeight: "700", marginBottom: 6 },
  hint: { fontSize: 13, marginBottom: 16, lineHeight: 18 },
  label: { fontSize: 14, fontWeight: "600", marginTop: 12, marginBottom: 6 },
  input: {
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 10,
    fontSize: 14,
  },
  urlInput: {
    minHeight: 82,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: "700",
    marginTop: 20,
    marginBottom: 8,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingVertical: 10,
  },
  rowLabel: { flex: 1, fontSize: 14, marginRight: 10 },
  primaryBtn: {
    paddingVertical: 14,
    borderRadius: 8,
    alignItems: "center",
    marginTop: 20,
  },
  primaryBtnText: { color: "#fff", fontWeight: "700", fontSize: 15 },
  progressBox: {
    marginTop: 12,
    padding: 12,
    borderWidth: 1,
    borderRadius: 8,
  },
  previewBox: {
    marginTop: 20,
    padding: 12,
    borderWidth: 1,
    borderRadius: 10,
  },
  previewTitle: { fontSize: 16, fontWeight: "700", marginBottom: 8 },
  previewRow: { fontSize: 14, marginBottom: 4 },
  sampleHeader: { marginTop: 12, fontSize: 12 },
  sampleRow: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingVertical: 8,
  },
  actionRow: { flexDirection: "row", gap: 8, marginTop: 16 },
  secondaryBtn: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 12,
    alignItems: "center",
    justifyContent: "center",
  },
});
