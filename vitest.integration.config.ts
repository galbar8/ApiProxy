import { defineConfig } from "vitest/config";
import { workspaceAliases } from "./vitest.shared.js";

export default defineConfig({
  resolve: { alias: workspaceAliases },
  test: {
    name: "integration",
    include: ["tests/integration/**/*.test.ts"],
    testTimeout: 60000,
    hookTimeout: 60000,
    environment: "node",
    restoreMocks: true,
    unstubEnvs: true,
    globalSetup: ["tests/support/global-setup.ts"],
    pool: "forks",
    fileParallelism: false,
  },
});
