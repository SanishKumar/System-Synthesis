import { rmSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
const frontendRoot = resolve(scriptsDirectory, "..");
const generatedDirectory = resolve(frontendRoot, ".next");

if (!generatedDirectory.startsWith(`${frontendRoot}${sep}`)) {
  throw new Error("Refusing to clean a build path outside the frontend workspace");
}

rmSync(generatedDirectory, { recursive: true, force: true });
