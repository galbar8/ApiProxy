import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(fileURLToPath(import.meta.url));

/**
 * Workspace packages are consumed as TypeScript source. Vitest, tsx and esbuild
 * all resolve them directly, so there is no build step between a code change and
 * a test run.
 */
export const workspaceAliases = {
  "@workflow/contracts": path.resolve(root, "packages/contracts/src/index.ts"),
  "@workflow/config": path.resolve(root, "packages/config/src/index.ts"),
  "@workflow/observability": path.resolve(root, "packages/observability/src/index.ts"),
  "@workflow/persistence": path.resolve(root, "packages/persistence/src/index.ts"),
  "@workflow/messaging": path.resolve(root, "packages/messaging/src/index.ts"),
  "@workflow/idempotency": path.resolve(root, "packages/idempotency/src/index.ts"),
  "@workflow/testing": path.resolve(root, "packages/testing/src/index.ts"),
  "@workflow/api": path.resolve(root, "apps/api/src/index.ts"),
  "@workflow/worker-a": path.resolve(root, "apps/worker-a/src/index.ts"),
  "@workflow/finalizer": path.resolve(root, "apps/finalizer/src/index.ts"),
  "@workflow/outbox-publisher": path.resolve(
    root,
    "apps/outbox-publisher/src/index.ts",
  ),
  "@workflow/reconciler": path.resolve(root, "apps/reconciler/src/index.ts"),
  "@workflow/fake-provider": path.resolve(root, "apps/fake-provider/src/index.ts"),
};
