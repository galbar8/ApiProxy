import { defineConfig } from "vitest/config";
import { workspaceAliases } from "./vitest.shared.js";

export default defineConfig({
  resolve: { alias: workspaceAliases },
  test: {
    name: "e2e",
    include: ["tests/e2e/**/*.test.ts"],
    testTimeout: 120000,
    hookTimeout: 120000,
    environment: "node",
    restoreMocks: true,
    unstubEnvs: true,
    globalSetup: ["tests/support/global-setup.ts"],
    pool: "forks",
    fileParallelism: false,
  },
});
