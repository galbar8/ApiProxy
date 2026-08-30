import { defineConfig } from "vitest/config";
import { workspaceAliases } from "./vitest.shared.js";

export default defineConfig({
  resolve: { alias: workspaceAliases },
  test: {
    name: "unit",
    include: [
      "packages/*/src/**/*.test.ts",
      "apps/*/src/**/*.test.ts",
      "infrastructure/cdk/test/**/*.test.ts",
    ],
    testTimeout: 10000,
    hookTimeout: 10000,
    environment: "node",
    restoreMocks: true,
    unstubEnvs: true,
    // Forks, not threads: the CDK tests bundle real Lambda assets with esbuild, and a
    // child process cannot inherit a worker thread's stdio.
    pool: "forks",
    coverage: {
      provider: "v8",
      reportsDirectory: "coverage/unit",
      include: ["packages/*/src/**", "apps/*/src/**"],
    },
  },
});
