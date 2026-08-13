import Constants from "expo-constants";
import { Alert, Linking } from "react-native";
import ApkInstaller from "../modules/apk-installer";

const TRUSTED_REPOSITORY = "ttttdiva/Event-AutoPin";
const UPDATE_CHECK_URL =
  `https://raw.githubusercontent.com/${TRUSTED_REPOSITORY}/main/latest.json`;
const RELEASES_URL =
  `https://api.github.com/repos/${TRUSTED_REPOSITORY}/releases?per_page=10`;
const MOBILE_ASSET_NAME = "EventAutoPin.apk";
const DESKTOP_ASSET_NAME = "EventAutoPin.exe";
const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

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
  draft: boolean;
  prerelease: boolean;
  assets: GitHubReleaseAsset[];
}

type UpdateFetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface UpdateServiceDependencies {
  fetch?: UpdateFetch;
  now?: () => Date;
}

export interface UpdateCheckResult {
  available: boolean;
  currentVersion: string;
  latestVersion?: string;
  downloadUrl?: string;
  releaseNotes?: string;
  errorMessage?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidSemver(version: string): boolean {
  return SEMVER_PATTERN.test(version);
}

function isValidIsoDate(date: string): boolean {
  if (!ISO_DATE_PATTERN.test(date)) return false;
  const parsed = new Date(`${date}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === date;
}

function expectedDownloadUrl(
  channel: "desktop" | "mobile",
  version: string,
): string {
  const asset = channel === "mobile" ? MOBILE_ASSET_NAME : DESKTOP_ASSET_NAME;
  return `https://github.com/${TRUSTED_REPOSITORY}/releases/download/${channel}-v${version}/${asset}`;
}

function parseUpdateInfo(
  value: unknown,
  channel: "desktop" | "mobile",
): UpdateInfo {
  if (!isRecord(value)) {
    throw new Error(`latest.json ${channel} invalid`);
  }

  const { version, url, notes, date } = value;
  if (
    typeof version !== "string" ||
    !isValidSemver(version) ||
    typeof url !== "string" ||
    url !== expectedDownloadUrl(channel, version) ||
    typeof notes !== "string" ||
    typeof date !== "string" ||
    !isValidIsoDate(date)
  ) {
    throw new Error(`latest.json ${channel} invalid`);
  }

  return { version, url, notes, date };
}

export function parseLatestJson(value: unknown): LatestJson {
  if (!isRecord(value)) {
    throw new Error("latest.json invalid");
  }
  return {
    desktop: parseUpdateInfo(value.desktop, "desktop"),
    mobile: parseUpdateInfo(value.mobile, "mobile"),
  };
}

export function isTrustedMobileDownloadUrl(
  url: string,
  version: string,
): boolean {
  return isValidSemver(version) && url === expectedDownloadUrl("mobile", version);
}

export function isNewerVersion(current: string, latest: string): boolean {
  if (!isValidSemver(current) || !isValidSemver(latest)) return false;
  const cur = current.split(".").map(Number);
  const lat = latest.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const currentPart = cur[i] ?? 0;
    const latestPart = lat[i] ?? 0;
    if (latestPart > currentPart) return true;
    if (latestPart < currentPart) return false;
  }
  return false;
}

export function getCurrentVersion(): string {
  return Constants.expoConfig?.version ?? "0.0.0";
}

async function fetchWithTimeout(
  url: string,
  fetchImpl: UpdateFetch,
): Promise<Response> {
  if (url !== UPDATE_CHECK_URL && url !== RELEASES_URL) {
    throw new Error("untrusted update endpoint");
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);
  try {
    // React Native 0.81 uses whatwg-fetch, which supports cache: "no-store"
    // for GET by adding a cache-busting query parameter before native dispatch.
    return await fetchImpl(url, {
      cache: "no-store",
      headers: {
        "Cache-Control": "no-cache, no-store, max-age=0",
        Pragma: "no-cache",
      },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchLatestJsonInfo(fetchImpl: UpdateFetch): Promise<UpdateInfo> {
  const resp = await fetchWithTimeout(UPDATE_CHECK_URL, fetchImpl);
  if (!resp.ok) {
    throw new Error(`latest.json HTTP ${resp.status}`);
  }
  const data = parseLatestJson(await resp.json());
  return data.mobile;
}

function parseGitHubRelease(value: unknown): GitHubRelease | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.tag_name !== "string" ||
    value.draft !== false ||
    value.prerelease !== false ||
    !Array.isArray(value.assets)
  ) {
    return null;
  }
  const assets: GitHubReleaseAsset[] = [];
  for (const asset of value.assets) {
    if (
      !isRecord(asset) ||
      typeof asset.name !== "string" ||
      typeof asset.browser_download_url !== "string"
    ) {
      return null;
    }
    assets.push({
      name: asset.name,
      browser_download_url: asset.browser_download_url,
    });
  }
  return {
    tag_name: value.tag_name,
    draft: false,
    prerelease: false,
    assets,
  };
}

async function fetchLatestReleaseInfo(
  fetchImpl: UpdateFetch,
  now: () => Date,
): Promise<UpdateInfo> {
  const resp = await fetchWithTimeout(RELEASES_URL, fetchImpl);
  if (!resp.ok) {
    throw new Error(`releases HTTP ${resp.status}`);
  }
  const values: unknown = await resp.json();
  if (!Array.isArray(values)) {
    throw new Error("releases invalid");
  }
  for (const value of values) {
    const release = parseGitHubRelease(value);
    if (!release) continue;
    const match = /^mobile-v(.+)$/.exec(release.tag_name);
    const version = match?.[1];
    if (!version || !isValidSemver(version)) continue;
    const expectedUrl = expectedDownloadUrl("mobile", version);
    const asset = release.assets.find(
      (candidate) =>
        candidate.name === MOBILE_ASSET_NAME &&
        candidate.browser_download_url === expectedUrl,
    );
    if (!asset) continue;
    return {
      version,
      url: expectedUrl,
      notes: `v${version} リリース`,
      date: now().toISOString().slice(0, 10),
    };
  }
  throw new Error("mobile release not found");
}

async function getLatestMobileInfo(
  fetchImpl: UpdateFetch,
  now: () => Date,
): Promise<UpdateInfo> {
  const errors: string[] = [];
  try {
    return await fetchLatestJsonInfo(fetchImpl);
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e));
  }
  try {
    return await fetchLatestReleaseInfo(fetchImpl, now);
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e));
  }
  throw new Error(errors.join(" / "));
}

export async function checkForUpdateWithDependencies(
  currentVersion: string,
  dependencies: UpdateServiceDependencies = {},
): Promise<UpdateCheckResult> {
  if (!isValidSemver(currentVersion)) {
    return {
      available: false,
      currentVersion,
      errorMessage: "current version invalid",
    };
  }

  try {
    const mobile = await getLatestMobileInfo(
      dependencies.fetch ?? fetch,
      dependencies.now ?? (() => new Date()),
    );

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

export async function checkForUpdate(): Promise<UpdateCheckResult> {
  return checkForUpdateWithDependencies(getCurrentVersion());
}

export function showUpdateAlert(result: UpdateCheckResult): void {
  if (
    !result.available ||
    !result.downloadUrl ||
    !result.latestVersion ||
    !isTrustedMobileDownloadUrl(result.downloadUrl, result.latestVersion)
  ) {
    return;
  }

  const downloadUrl = result.downloadUrl;
  const latestVersion = result.latestVersion;
  const notes = result.releaseNotes ? `\n\n${result.releaseNotes}` : "";
  const message = `v${result.currentVersion} → v${latestVersion}${notes}`;

  Alert.alert("アプリの更新があります", message, [
    { text: "後で", style: "cancel" },
    {
      text: "更新する",
      onPress: async () => {
        try {
          await ApkInstaller.installApk(downloadUrl);
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
                onPress: () => Linking.openURL(downloadUrl),
              },
            ],
          );
        }
      },
    },
  ]);
}
