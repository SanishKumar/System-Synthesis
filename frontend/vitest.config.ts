import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Vitest does not read the `@/*` alias from tsconfig, so a test importing
 * anything that resolves through it fails to load rather than fails an
 * assertion. Declared here so the suite sees the same module graph the
 * application does.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
