import { build } from "esbuild";
import { rm, mkdir } from "node:fs/promises";

/**
 * Produces the API container bundle. Lambda bundles are built by CDK at synth time, so
 * only the long-running service needs an artifact here.
 */
const main = async (): Promise<void> => {
  await rm("dist", { recursive: true, force: true });
  await mkdir("dist", { recursive: true });

  await build({
    entryPoints: ["apps/api/src/server.ts"],
    bundle: true,
    platform: "node",
    target: "node22",
    format: "cjs",
    outfile: "dist/api/server.cjs",
    sourcemap: true,
    minify: false,
    // Keep stack traces meaningful in production logs.
    keepNames: true,
    logLevel: "info",
  });
};

await main();
