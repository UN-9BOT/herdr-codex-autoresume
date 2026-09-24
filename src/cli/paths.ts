import { join } from "node:path";

export function resolveStateDir(): string {
  const v = process.env.HERDR_PLUGIN_STATE_DIR;
  if (!v) {
    process.stderr.write("HERDR_PLUGIN_STATE_DIR is required\n");
    process.exit(2);
  }
  return v;
}

export function resolveConfigDir(): string {
  const v = process.env.HERDR_PLUGIN_CONFIG_DIR;
  if (!v) {
    process.stderr.write("HERDR_PLUGIN_CONFIG_DIR is required\n");
    process.exit(2);
  }
  return v;
}

export { join };
