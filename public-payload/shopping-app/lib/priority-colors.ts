import {
  DEFAULT_PRIORITY,
  PRIORITY_COLORS,
  type PriorityColorDefinition,
} from "./types";

export type PriorityPalette = Record<number, PriorityColorDefinition>;

export const PRIORITY_ORDER = [15, 10, 11, 5] as const;

const HEX_RE = /^#[0-9a-f]{6}$/i;

function isPriorityColorDefinition(value: unknown): value is PriorityColorDefinition {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.label === "string" &&
    typeof record.color === "string" &&
    typeof record.bgColor === "string"
  );
}

export function normalizeHex(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const normalized = trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
  return HEX_RE.test(normalized) ? normalized.toLowerCase() : null;
}

export function tintColor(hex: string, alpha = 0.14): string {
  const normalized = normalizeHex(hex);
  if (!normalized) return hex;
  const r = parseInt(normalized.slice(1, 3), 16);
  const g = parseInt(normalized.slice(3, 5), 16);
  const b = parseInt(normalized.slice(5, 7), 16);
  const mix = (channel: number) =>
    Math.round(channel * alpha + 255 * (1 - alpha));
  return `rgb(${mix(r)}, ${mix(g)}, ${mix(b)})`;
}

export function normalizePriorityPalette(value: unknown): PriorityPalette {
  const palette: PriorityPalette = { ...PRIORITY_COLORS };
  if (!value || typeof value !== "object") return palette;

  for (const key of Object.keys(PRIORITY_COLORS)) {
    const numericKey = Number(key);
    const raw = (value as Record<string, unknown>)[key];
    if (!isPriorityColorDefinition(raw)) continue;
    const color = normalizeHex(raw.color);
    const bgColor = normalizeHex(raw.bgColor) ?? (color ? tintColor(color) : null);
    if (!color || !bgColor) continue;
    palette[numericKey] = {
      label: raw.label.trim() || PRIORITY_COLORS[numericKey].label,
      color,
      bgColor,
    };
  }
  return palette;
}

export function getPriorityColor(
  palette: PriorityPalette,
  priority: number,
): PriorityColorDefinition {
  return palette[priority] ?? palette[DEFAULT_PRIORITY] ?? PRIORITY_COLORS[DEFAULT_PRIORITY];
}

export function priorityOptionsFromPalette(palette: PriorityPalette) {
  return PRIORITY_ORDER.map((value) => ({
    value,
    ...getPriorityColor(palette, value),
  }));
}

export function prioritySortRank(priority: number): number {
  const index = PRIORITY_ORDER.indexOf(priority as (typeof PRIORITY_ORDER)[number]);
  return index >= 0 ? PRIORITY_ORDER.length - index : 0;
}
