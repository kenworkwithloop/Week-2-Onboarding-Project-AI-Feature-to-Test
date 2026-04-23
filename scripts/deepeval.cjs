#!/usr/bin/env node
/**
 * Run eval/run_eval.py with the eval/.venv interpreter so `npm run eval:deepeval`
 * works without installing deepeval on the global python3.
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

const r = spawnSync(py, [path.join(root, "eval", "run_eval.py")], {
  stdio: "inherit",
  cwd: root,
  env: process.env,
});
process.exit(r.status === null ? 1 : r.status);
