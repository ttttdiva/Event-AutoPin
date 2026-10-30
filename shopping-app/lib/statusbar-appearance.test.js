const fs = require("node:fs");
const path = require("node:path");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function readRoute(relativePath) {
  return fs.readFileSync(path.resolve(__dirname, "..", "app", relativePath), "utf8");
}

function runStatusBarAppearanceTests() {
  const routes = ["(tabs)/index.tsx", "event/[id].tsx"];
  const root = readRoute("_layout.tsx");

  const rootSurfaceIsSet = root.includes(
    "<View style={{ flex: 1, backgroundColor: colors.background }}>",
  );
  assert(
    rootSurfaceIsSet,
    "the root surface must fill the window behind transparent edge-to-edge bars",
  );

  for (const route of routes) {
    const source = readRoute(route);
    const declarations = source.match(/<StatusBar\b[\s\S]*?\/>/g) ?? [];

    assert(
      declarations.length === 1,
      `${route} must have exactly one StatusBar declaration`,
    );
    assert(
      declarations[0].includes('backgroundColor="transparent"'),
      `${route} must let the theme-colored app surface show through the edge-to-edge status bar`,
    );
    assert(
      /\btranslucent\b/.test(declarations[0]),
      `${route} must preserve the root KeyboardProvider's edge-to-edge status-bar insets`,
    );
    assert(
      declarations[0].includes('effectiveScheme === "dark"'),
      `${route} must keep status-bar icon color tied to the app theme`,
    );
  }
}

module.exports = { runStatusBarAppearanceTests };
