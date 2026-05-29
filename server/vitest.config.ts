import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/__tests__/**/*.test.ts"],
    testTimeout: 10000,
    coverage: {
      provider: "v8",
      include: ["src/services/**/*.ts"],
      exclude: ["src/services/db.ts"], // DB connection pooling — tested via integration
    },
  },
});
