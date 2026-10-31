import { adjacentCatalogImage, catalogPathsForRow } from "./catalog-image-viewer";

let count = 0;
function equal(actual: unknown, expected: unknown, label: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${label}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
  count++;
}
const circles = [{ id: "A", images: ["fallback1", "fallback2"] }, { id: "empty", images: [] as string[] }, { id: "B", images: ["B1"] }];
const canonical = (circle: typeof circles[number] | undefined) => circle?.images ?? [];
let rows = ["A1\nA2", "", "B1"];
const paths = (index: number) => catalogPathsForRow(rows[index] ?? "", circles[index], canonical);
equal(paths(0), ["A1", "A2"], "row multiimages");
equal(catalogPathsForRow("", circles[0], canonical), ["fallback1", "fallback2"], "event fallback multiimages");
equal(catalogPathsForRow("0\n0.0", circles[0], canonical), ["fallback1", "fallback2"], "invalid row fallback");
equal(catalogPathsForRow("A1\nA1\nA2", circles[0], canonical), ["A1", "A1", "A2"], "row duplicates retained");
equal(paths(1), [], "empty circle");
const step = (circle: typeof circles[number], path: string, direction: -1 | 1, visible = [0, 1, 2]) => adjacentCatalogImage(circles, visible, circle, path, paths(circles.indexOf(circle)).indexOf(path), direction, paths);
equal(step(circles[0], "A1", 1), { circle: circles[0], path: "A2", imageIndex: 1 }, "A1 to A2");
equal(step(circles[0], "A2", 1), { circle: circles[2], path: "B1", imageIndex: 0 }, "A2 skips empty to B1");
equal(step(circles[2], "B1", -1), { circle: circles[0], path: "A2", imageIndex: 1 }, "B1 reverse to A2");
equal(step(circles[0], "A2", -1), { circle: circles[0], path: "A1", imageIndex: 0 }, "A2 reverse to A1");
equal(step(circles[0], "A1", -1), null, "first boundary");
equal(step(circles[2], "B1", 1), null, "last boundary");
equal(step(circles[0], "A2", 1, []), null, "filter zero");
equal(step(circles[0], "A2", 1, [1, 2]), null, "current circle filtered");
equal(step(circles[0], "missing", 1), null, "current image removed");
equal(step(circles[2], "B1", 1, [2, 1, 0]), { circle: circles[0], path: "A1", imageIndex: 0 }, "sorted visible order");
equal(adjacentCatalogImage(circles, [0, 1, 2], { id: "A" }, "A1", 0, 1, paths), null, "reloaded circle identity");
rows = ["", "", "B1"];
equal(step(circles[0], "fallback1", 1), { circle: circles[0], path: "fallback2", imageIndex: 1 }, "navigate fallback");
rows[0] = "A1\nA1\nA2";
equal(adjacentCatalogImage(circles, [0, 1, 2], circles[0], "A1", 1, 1, paths), { circle: circles[0], path: "A2", imageIndex: 2 }, "duplicate position advances");
console.log(`catalog-image-viewer: ${count} checks passed`);
