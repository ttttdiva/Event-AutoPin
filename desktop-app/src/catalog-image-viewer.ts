// おしながき表示では表の未保存値を優先し、空なら既存のイベント画像を使う。
export function usableImageValue(value: string): boolean {
  const trimmed = value.trim();
  return Boolean(trimmed && trimmed !== "0.0" && trimmed !== "0" && !/^\d+(\.\d+)?$/.test(trimmed));
}

export function catalogPathsForRow(
  value: string,
  circle: unknown,
  canonicalPaths: (circle: any) => string[],
): string[] {
  const paths = value.split("\n").map((part) => part.trim()).filter(usableImageValue);
  return paths.length ? paths : canonicalPaths(circle);
}

export function adjacentCatalogImage(
  circles: any[], visibleIndices: number[], currentCircle: any, currentPath: string, currentImageIndex: number,
  direction: -1 | 1, pathsForCircle: (index: number) => string[],
): { circle: any; path: string; imageIndex: number } | null {
  const position = visibleIndices.indexOf(circles.indexOf(currentCircle));
  if (position < 0) return null;
  const paths = pathsForCircle(visibleIndices[position]);
  if (paths[currentImageIndex] !== currentPath) return null;
  const imageIndex = currentImageIndex + direction;
  const path = paths[imageIndex];
  if (path) return { circle: currentCircle, path, imageIndex };
  for (let pos = position + direction; pos >= 0 && pos < visibleIndices.length; pos += direction) {
    const index = visibleIndices[pos];
    const nextPaths = pathsForCircle(index);
    if (circles[index] && nextPaths.length) {
      const imageIndex = direction === 1 ? 0 : nextPaths.length - 1;
      return { circle: circles[index], path: nextPaths[imageIndex], imageIndex };
    }
  }
  return null;
}
