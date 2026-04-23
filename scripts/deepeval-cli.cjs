#!/usr/bin/env node
/**
 * Run the eval venv's `deepeval` CLI from the repo root so:
 * - The venv's Python/deepeval install is used (not a global `python3`).
 * - DeepEval loads `.env` / `.env.local` from this directory (`cwd` + `ENV_DIR_PATH`; see Confident AI docs).
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
// Prefer project dotenv files when cwd is root (DeepEval also scans cwd).
if (!env.ENV_DIR_PATH) env.ENV_DIR_PATH = root;

const r = spawnSync(bin, process.argv.slice(2), {
  stdio: "inherit",
  cwd: root,
  env,
});
process.exit(r.status === null ? 1 : r.status);
