import { normalizeFilePathForWebview } from "./file-asset-path";

// 公開可能な架空のパスを使い、開発環境の絶対パスを含めない。
const fixtureDrive = "X:";
const slashPath = `${fixtureDrive}/fixture/assets/map.webp`;
const backslashPath = `${fixtureDrive}\\fixture\\assets\\map.webp`;
const japanesePath = `${fixtureDrive}/fixture/events/サンプル/マップ画像.webp`;

function assertEqual(actual: string, expected: string, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

assertEqual(
  normalizeFilePathForWebview(slashPath),
  slashPath,
  "normal drive path",
);
assertEqual(
  normalizeFilePathForWebview(`//?/${slashPath}`),
  slashPath,
  "slash verbatim drive path",
);
assertEqual(
  normalizeFilePathForWebview(`\\\\?\\${backslashPath}`),
  backslashPath,
  "backslash verbatim drive path",
);
assertEqual(
  normalizeFilePathForWebview("//?/UNC/server/share/assets/map.webp"),
  "//server/share/assets/map.webp",
  "slash verbatim UNC path",
);
assertEqual(
  normalizeFilePathForWebview("\\\\?\\UNC\\server\\share\\assets\\map.webp"),
  "\\\\server\\share\\assets\\map.webp",
  "backslash verbatim UNC path",
);
assertEqual(
  normalizeFilePathForWebview("//server/share/assets/map.webp"),
  "//server/share/assets/map.webp",
  "normal slash UNC path",
);
assertEqual(
  normalizeFilePathForWebview(`//?/${japanesePath}`),
  japanesePath,
  "slash verbatim Japanese drive path",
);
assertEqual(
  normalizeFilePathForWebview("\\\\?\\Volume{1234}\\assets\\map.webp"),
  "\\\\?\\Volume{1234}\\assets\\map.webp",
  "unknown verbatim namespace is unchanged",
);
assertEqual(
  normalizeFilePathForWebview("//?/Volume{1234}/assets/map.webp"),
  "//?/Volume{1234}/assets/map.webp",
  "unknown slash namespace is unchanged",
);

console.log("file-asset-path tests passed");
