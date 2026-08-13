const JA_TEXT_COLLATOR = new Intl.Collator("ja", {
  usage: "sort",
  sensitivity: "variant",
  numeric: false,
});

/**
 * Compare user-visible text using the app's Japanese sort order.
 *
 * The collator is intentionally constructed once: constructing it implicitly
 * for every String#localeCompare call is particularly expensive on Hermes.
 * Returning zero for equal values lets the stable Array#sort implementation
 * preserve the caller's existing order (or apply its existing tie-breaker).
 */
export function compareJaText(
  a: string | null | undefined,
  b: string | null | undefined,
): number {
  return JA_TEXT_COLLATOR.compare(a ?? "", b ?? "");
}
