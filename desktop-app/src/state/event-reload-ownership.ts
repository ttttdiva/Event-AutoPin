/**
 * event.json reloadがどの所有者を対象にするかを、UI/IPCから独立して
 * 判定するための純粋なhelper。
 */

export type EventReloadMode = "manual" | "external-authoritative";

export type EventOwnerMapping = {
  slug: string;
  dir: string;
};

export type EventSessionOwner = {
  slug: string;
  eventDir: string;
  eventJsonPath: string;
};

type EventReloadSessionField = Record<"session", EventSessionOwner | null>;

export type ExternalEventReloadOwner = EventOwnerMapping & {
  eventJsonPath: string;
  revision: number;
} & EventReloadSessionField;

/**
 * Windows extended path prefixを比較用に外し、区切りと末尾separatorだけを
 * 正規化する。値をlowercaseにはしないため、Linuxのcase-sensitive pathと
 * 実際のI/Oへ渡すpathの表記を壊さない。
 */
export function normalizeEventPath(path: string): string {
  let normalized = path.trim().replace(/\\/g, "/");
  if (normalized.startsWith("//?/")) normalized = normalized.slice(4);
  return normalized.replace(/\/+$/, "");
}

/**
 * Windows drive pathだけはOSのcase-insensitive semanticsに合わせて比較する。
 * POSIX pathは大文字小文字を保持したまま比較する。
 */
export function eventPathsEqual(left: string, right: string): boolean {
  const normalizedLeft = normalizeEventPath(left);
  const normalizedRight = normalizeEventPath(right);
  const isWindowsDrivePath = (value: string) => /^[A-Za-z]:\//.test(value);
  if (isWindowsDrivePath(normalizedLeft) && isWindowsDrivePath(normalizedRight)) {
    return normalizedLeft.toLowerCase() === normalizedRight.toLowerCase();
  }
  return normalizedLeft === normalizedRight;
}

export function eventJsonPathForDir(eventDir: string): string {
  return `${normalizeEventPath(eventDir)}/event.json`;
}

export function shouldSaveBeforeEventReload(mode: EventReloadMode): boolean {
  return mode === "manual";
}

/** captured ownerと、reload前に再取得したevent listの物理ownerを照合する。 */
export function externalEventOwnerMatches(
  owner: Pick<ExternalEventReloadOwner, "slug" | "dir" | "eventJsonPath">,
  listed: EventOwnerMapping,
): boolean {
  return (
    owner.slug === listed.slug &&
    eventPathsEqual(owner.dir, listed.dir) &&
    eventPathsEqual(owner.eventJsonPath, eventJsonPathForDir(listed.dir))
  );
}

/** sessionの識別情報がcaptured ownerと同じ物理ownerを指すか判定する。 */
export function eventSessionOwnerMatches(
  owner: Pick<ExternalEventReloadOwner, "slug" | "dir" | "eventJsonPath">,
  candidateSession: EventSessionOwner | null,
): boolean {
  return Boolean(
    candidateSession &&
      owner.slug === candidateSession.slug &&
      eventPathsEqual(owner.dir, candidateSession.eventDir) &&
      eventPathsEqual(owner.eventJsonPath, candidateSession.eventJsonPath),
  );
}
