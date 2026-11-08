import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "integrations/*/test/**/*.test.ts", "bench/test/**/*.test.ts"],
    testTimeout: 20_000,
  },
});
