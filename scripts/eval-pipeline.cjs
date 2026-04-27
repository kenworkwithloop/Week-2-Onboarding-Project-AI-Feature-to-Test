#!/usr/bin/env node
/**
 * Run eval/agent_pipeline.py with the eval/.venv interpreter so
 * `npm run eval:pipeline` works without installing deepeval globally.
 *
 * Forwards extra argv (e.g. `--verbose`, `--cases path.json`).
 */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const candidates = [
  path.join(root, "eval", ".venv", "bin", "python"),
  path.join(root, "eval", ".venv", "bin", "python3"),
  path.join(root, "eval", ".venv", "Scripts", "python.exe"),
];

function findPython() {
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      /* ignore */
    }
  }
  return null;
}

const py = findPython();
if (!py) {
  console.error(
    "eval/.venv Python not found. Create the venv and install deps:\n" +
      "  cd eval && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt",
  );
  process.exit(1);
}

const forwarded = process.argv.slice(2);
const r = spawnSync(py, [path.join(root, "eval", "agent_pipeline.py"), ...forwarded], {
  stdio: "inherit",
  cwd: root,
  env: process.env,
});
process.exit(r.status === null ? 1 : r.status);
