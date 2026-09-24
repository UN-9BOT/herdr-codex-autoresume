// Build script: ensures devDependencies are installed, then runs
// `tsc -p tsconfig.build.json` to emit ES2022 JS into ./dist.
//
// Herdr's `plugin install` runs build commands without first running
// `npm install`, so this script bootstraps dependencies when needed.

import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const tsc = resolve(root, "node_modules", ".bin", "tsc");

if (!existsSync(tsc)) {
  process.stderr.write(
    `devDependencies not installed; running \`npm ci --omit=dev=false\` in ${root}\n`,
  );
  const install = spawnSync("npm", ["ci", "--omit=dev=false"], {
    stdio: "inherit",
    cwd: root,
  });
  if (install.status !== 0) {
    process.stderr.write(`npm ci failed with status ${install.status}\n`);
    process.exit(install.status ?? 1);
  }
}

if (!existsSync(tsc)) {
  process.stderr.write(
    `tsc still not found at ${tsc}; aborting build.\n`,
  );
  process.exit(2);
}

const distDir = resolve(root, "dist");
rmSync(distDir, { recursive: true, force: true });

const child = spawnSync(tsc, ["-p", resolve(root, "tsconfig.build.json")], {
  stdio: "inherit",
  cwd: root,
});
process.exit(child.status ?? 1);
