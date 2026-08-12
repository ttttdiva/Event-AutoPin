import { getSetting, setSetting } from "../database";

const SITE_SCHEMA_KEY = "crawl_generic_table_schemas_v1";
const MAX_SCHEMAS = 30;

export type CircleColumnKey =
  | "name"
  | "penname"
  | "space"
  | "hall"
  | "twitter_url"
  | "website_url"
  | "pixiv_url"
  | "description"
  | "genres"
  | "circle_cut_url";

export type CircleColumnMapping = Partial<Record<CircleColumnKey, number>> & {
  name: number;
};

interface SavedTableSchema {
  hostname: string;
  headers: string[];
  mapping: CircleColumnMapping;
  updatedAt: string;
}

function normalizeHeader(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function normalizeHeaders(headers: string[]): string[] {
  return headers.map(normalizeHeader);
}

function isValidSchema(value: unknown): value is SavedTableSchema {
  if (!value || typeof value !== "object") return false;
  const schema = value as SavedTableSchema;
  return (
    typeof schema.hostname === "string" &&
    Array.isArray(schema.headers) &&
    schema.headers.every((header) => typeof header === "string") &&
    !!schema.mapping &&
    Number.isInteger(schema.mapping.name)
  );
}

async function loadSchemas(): Promise<SavedTableSchema[]> {
  const raw = await getSetting(SITE_SCHEMA_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isValidSchema) : [];
  } catch {
    return [];
  }
}

export async function findExactTableSchema(
  hostname: string,
  headers: string[],
): Promise<CircleColumnMapping | null> {
  const normalized = normalizeHeaders(headers);
  const schemas = await loadSchemas();
  const found = schemas.find(
    (schema) =>
      schema.hostname === hostname.toLowerCase() &&
      schema.headers.length === normalized.length &&
      schema.headers.every((header, index) => header === normalized[index]),
  );
  if (!found) return null;
  const indexes = Object.values(found.mapping);
  return indexes.every(
    (index) => Number.isInteger(index) && index >= 0 && index < normalized.length,
  )
    ? found.mapping
    : null;
}

export async function saveTableSchema(
  hostname: string,
  headers: string[],
  mapping: CircleColumnMapping,
): Promise<void> {
  const normalizedHost = hostname.toLowerCase();
  const normalizedHeaders = normalizeHeaders(headers);
  const schemas = (await loadSchemas()).filter(
    (schema) =>
      !(
        schema.hostname === normalizedHost &&
        schema.headers.length === normalizedHeaders.length &&
        schema.headers.every((header, index) => header === normalizedHeaders[index])
      ),
  );
  schemas.unshift({
    hostname: normalizedHost,
    headers: normalizedHeaders,
    mapping,
    updatedAt: new Date().toISOString(),
  });
  await setSetting(SITE_SCHEMA_KEY, JSON.stringify(schemas.slice(0, MAX_SCHEMAS)));
}
