#!/usr/bin/env node
/**
 * Desktop release build entrypoint.
 * Always runs the platform wrapper that copies the built exe to
 * <repo-root>/EventAutoPin.exe — the only path many users launch from.
 */
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const scriptsDir = __dirname;
const projectRoot = path.resolve(scriptsDir, "..");

function run(exe, args) {
  const result = spawnSync(exe, args, {
    stdio: "inherit",
    cwd: projectRoot,
    shell: false,
  });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}

if (process.platform === "win32") {
  run("powershell", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    path.join(scriptsDir, "build_desktop.ps1"),
  ]);
}

run("bash", [path.join(scriptsDir, "build_desktop.sh")]);
