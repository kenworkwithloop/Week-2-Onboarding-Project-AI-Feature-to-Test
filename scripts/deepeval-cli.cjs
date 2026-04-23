#!/usr/bin/env node
/**
 * Run the eval venv's `deepeval` CLI from the repo root so dotenv (.env / .env.local) loads.
 */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const candidates = [
  path.join(root, "eval", ".venv", "bin", "deepeval"),
  path.join(root, "eval", ".venv", "Scripts", "deepeval.exe"),
];

function findDeepeval() {
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      /* ignore */
    }
  }
  return null;
}

const bin = findDeepeval();
if (!bin) {
  console.error(
    "eval/.venv not found or deepeval not installed.\n" +
      "  cd eval && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt",
  );
  process.exit(1);
}

const env = { ...process.env };
if (!env.ENV_DIR_PATH) env.ENV_DIR_PATH = root;

const r = spawnSync(bin, process.argv.slice(2), {
  stdio: "inherit",
  cwd: root,
  env,
});
process.exit(r.status === null ? 1 : r.status);
