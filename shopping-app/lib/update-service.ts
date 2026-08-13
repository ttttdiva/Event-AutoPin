import Constants from "expo-constants";
import { Alert, Linking } from "react-native";
import ApkInstaller from "../modules/apk-installer";

const UPDATE_CHECK_URL =
  "https://raw.githubusercontent.com/ttttdiva/Event-AutoPin/main/latest.json";
const RELEASES_URL =
  "https://api.github.com/repos/ttttdiva/Event-AutoPin/releases?per_page=10";

interface UpdateInfo {
  version: string;
  url: string;
  notes: string;
  date: string;
}

interface LatestJson {
  desktop: UpdateInfo;
  mobile: UpdateInfo;
}

interface GitHubReleaseAsset {
  name: string;
  browser_download_url: string;
}

interface GitHubRelease {
  tag_name: string;
  draft?: boolean;
  prerelease?: boolean;
  assets?: GitHubReleaseAsset[];
}

export interface UpdateCheckResult {
  available: boolean;
  currentVersion: string;
  latestVersion?: string;
  downloadUrl?: string;
  releaseNotes?: string;
  errorMessage?: string;
}

function isNewerVersion(current: string, latest: string): boolean {
  const parse = (s: string) =>
    s
      .replace(/^v/, "")
      .split(".")
      .map((n) => parseInt(n, 10) || 0);
  const cur = parse(current);
  const lat = parse(latest);
  for (let i = 0; i < 3; i++) {
    const c = cur[i] ?? 0;
    const l = lat[i] ?? 0;
    if (l > c) return true;
    if (l < c) return false;
  }
  return false;
}

export function getCurrentVersion(): string {
  return Constants.expoConfig?.version ?? "0.0.0";
}

async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchLatestJsonInfo(): Promise<UpdateInfo> {
  const resp = await fetchWithTimeout(UPDATE_CHECK_URL);
  if (!resp.ok) {
    throw new Error(`latest.json HTTP ${resp.status}`);
  }
  const data = (await resp.json()) as LatestJson;
  if (!data.mobile?.url || !data.mobile.version) {
    throw new Error("latest.json mobile missing");
  }
  return data.mobile;
}

async function fetchLatestReleaseInfo(): Promise<UpdateInfo> {
  const resp = await fetchWithTimeout(RELEASES_URL);
  if (!resp.ok) {
    throw new Error(`releases HTTP ${resp.status}`);
  }
  const releases = (await resp.json()) as GitHubRelease[];
  for (const release of releases) {
    if (release.draft || release.prerelease) continue;
    const match = /^mobile-v(.+)$/.exec(release.tag_name);
    if (!match) continue;
    const asset = release.assets?.find((a) => a.name === "EventAutoPin.apk");
    if (!asset?.browser_download_url) continue;
    return {
      version: match[1],
      url: asset.browser_download_url,
      notes: `v${match[1]} リリース`,
      date: new Date().toISOString().slice(0, 10),
    };
  }
  throw new Error("mobile release not found");
}

async function getLatestMobileInfo(): Promise<UpdateInfo> {
  const errors: string[] = [];
  try {
    return await fetchLatestJsonInfo();
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e));
  }
  try {
    return await fetchLatestReleaseInfo();
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e));
  }
  throw new Error(errors.join(" / "));
}

export async function checkForUpdate(): Promise<UpdateCheckResult> {
  const currentVersion = getCurrentVersion();

  try {
    const mobile = await getLatestMobileInfo();

    if (!isNewerVersion(currentVersion, mobile.version)) {
      return { available: false, currentVersion };
    }

    return {
      available: true,
      currentVersion,
      latestVersion: mobile.version,
      downloadUrl: mobile.url,
      releaseNotes: mobile.notes || undefined,
    };
  } catch (e) {
    const errorMessage = e instanceof Error ? e.message : String(e);
    return { available: false, currentVersion, errorMessage };
  }
}

export function showUpdateAlert(result: UpdateCheckResult): void {
  if (!result.available || !result.downloadUrl) return;

  const notes = result.releaseNotes ? `\n\n${result.releaseNotes}` : "";
  const message = `v${result.currentVersion} → v${result.latestVersion}${notes}`;

  Alert.alert("アプリの更新があります", message, [
    { text: "後で", style: "cancel" },
    {
      text: "更新する",
      onPress: async () => {
        if (!result.downloadUrl) return;
        try {
          await ApkInstaller.installApk(result.downloadUrl);
          Alert.alert(
            "ダウンロード開始",
            "通知バーにダウンロードの進捗が表示されます。\n完了後、通知をタップしてインストールしてください。",
          );
        } catch (e) {
          const errMsg = e instanceof Error ? e.message : JSON.stringify(e);
          Alert.alert(
            "ダウンロードに失敗",
            `${errMsg}\n\nブラウザからダウンロードしますか？`,
            [
              { text: "キャンセル", style: "cancel" },
              {
                text: "ブラウザで開く",
                onPress: () => Linking.openURL(result.downloadUrl!),
              },
            ],
          );
        }
      },
    },
  ]);
}
