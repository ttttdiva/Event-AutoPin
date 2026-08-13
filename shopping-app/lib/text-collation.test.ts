import { compareJaText } from "./text-collation";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function sign(value: number): number {
  return value === 0 ? 0 : value < 0 ? -1 : 1;
}

interface FixtureEntry {
  id: number;
  text: string | null | undefined;
}

function create2000TextFixture(): FixtureEntry[] {
  const bases = [
    "あおい",
    "アオイ",
    "青井",
    "サークル",
    "circle",
    "Circle",
    "A-2",
    "A-10",
    "東",
    "西",
    "",
    null,
    undefined,
  ] as const;
  return Array.from({ length: 2000 }, (_, id) => ({
    id,
    text: bases[(id * 37) % bases.length],
  }));
}

export function runTextCollationTests(): void {
  const cases: Array<readonly [string | null | undefined, string | null | undefined]> = [
    ["あおい", "かえで"],
    ["サークル", "青井"],
    ["circle", "Circle"],
    ["A-2", "A-10"],
    ["同値", "同値"],
    [undefined, null],
    [undefined, "あ"],
  ];
  for (const [a, b] of cases) {
    const expected = (a ?? "").localeCompare(b ?? "", "ja", {
      usage: "sort",
      sensitivity: "variant",
      numeric: false,
    });
    assert(
      sign(compareJaText(a, b)) === sign(expected),
      `comparison mismatch for ${String(a)} / ${String(b)}`,
    );
  }

  assert(compareJaText(undefined, null) === 0, "nullish values should compare equally");
  assert(compareJaText("同値", "同値") === 0, "equal strings should compare equally");

  const stableFixture: FixtureEntry[] = [
    { id: 1, text: "同値" },
    { id: 2, text: "同値" },
    { id: 3, text: null },
    { id: 4, text: undefined },
  ];
  const stableIds = [...stableFixture]
    .sort((a, b) => compareJaText(a.text, b.text))
    .filter((entry) => entry.text === "同値")
    .map((entry) => entry.id);
  assert(stableIds.join(",") === "1,2", "equal values should preserve input order");

  const fixture = create2000TextFixture();
  const expectedIds = [...fixture]
    .sort((a, b) => (a.text ?? "").localeCompare(b.text ?? "", "ja", {
      usage: "sort",
      sensitivity: "variant",
      numeric: false,
    }))
    .map((entry) => entry.id);
  const startedAt = Date.now();
  const actualIds = [...fixture]
    .sort((a, b) => compareJaText(a.text, b.text))
    .map((entry) => entry.id);
  const elapsedMs = Date.now() - startedAt;

  assert(actualIds.join(",") === expectedIds.join(","), "2000-item order mismatch");
  // Generous enough for shared CI hosts while still catching pathological
  // per-comparison work such as rebuilding or scanning the whole fixture.
  assert(elapsedMs < 5000, `2000-item collation took too long: ${elapsedMs}ms`);
  console.log(`text-collation.test passed (${fixture.length} items, ${elapsedMs}ms)`);
}
