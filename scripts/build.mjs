// Build script: runs TypeScript via the project's tsx/typescript
// installation and emits ES2022 JS into ./dist. There is no separate
// bundler step; Herdr invokes the dist/*.js files directly with Node.

import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const tsc = resolve(root, "node_modules", ".bin", "tsc");

if (!existsSync(tsc)) {
  process.stderr.write(
    `tsc not found at ${tsc}; run \`npm install\` first to install devDependencies.\n`,
  );
  process.exit(2);
}

const distDir = resolve(root, "dist");
rmSync(distDir, { recursive: true, force: true });

const child = spawn(tsc, ["-p", resolve(root, "tsconfig.build.json")], {
  stdio: "inherit",
  cwd: root,
});
child.on("exit", (code) => {
  process.exit(code ?? 1);
});
