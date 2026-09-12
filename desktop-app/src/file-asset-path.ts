/**
 * Convert only the Windows verbatim path forms that Tauri's WebView asset
 * protocol cannot consume reliably.  Backend filesystem paths intentionally
 * remain untouched; this helper is used at the WebView boundary only.
 */
export function normalizeFilePathForWebview(filePath: string): string {
  const value = String(filePath ?? "");

  const slashUnc = value.match(/^\/\/\?\/UNC\/(.+)$/i);
  if (slashUnc) return `//${slashUnc[1]}`;

  const slashDrive = value.match(/^\/\/\?\/([A-Za-z]:\/.*)$/);
  if (slashDrive) return slashDrive[1];

  const backslashUnc = value.match(/^\\\\\?\\UNC\\(.+)$/i);
  if (backslashUnc) return `\\\\${backslashUnc[1]}`;

  const backslashDrive = value.match(/^\\\\\?\\([A-Za-z]:[\\/].*)$/);
  if (backslashDrive) return backslashDrive[1];

  return value;
}
