import path from "node:path";
import { createRequire } from "node:module";

/**
 * Allows this project to use Codex's bundled worksheet/image packages without
 * committing node_modules. Outside Codex, omit the environment variable and
 * install compatible packages locally instead.
 */
export function requireWorkspacePackage(packageName) {
  const moduleDirectory = process.env.WEATHER_SCRAPE_NODE_MODULES;
  const requireFrom = moduleDirectory
    ? createRequire(path.join(moduleDirectory, "package.json"))
    : createRequire(import.meta.url);
  return requireFrom(packageName);
}
