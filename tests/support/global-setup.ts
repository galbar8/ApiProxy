import { execFile } from "node:child_process";
import { promisify } from "node:util";
import net from "node:net";

const run = promisify(execFile);

const COMPOSE_FILE = "docker-compose.local.yml";
const PORTS = [
  { name: "dynamodb-local", port: 8000 },
  { name: "elasticmq", port: 9324 },
];

const canConnect = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    const done = (ok: boolean): void => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(500);
    socket.once("connect", () => {
      done(true);
    });
    socket.once("timeout", () => {
      done(false);
    });
    socket.once("error", () => {
      done(false);
    });
  });

const allUp = async (): Promise<boolean> => {
  const results = await Promise.all(PORTS.map((entry) => canConnect(entry.port)));
  return results.every(Boolean);
};

/**
 * Integration, e2e and chaos suites need the local topology (ADR-0009). Bring it up if it
 * is not already running, and fail with an actionable message rather than a cascade of
 * connection errors inside individual tests.
 */
export default async function setup(): Promise<void> {
  if (await allUp()) return;

  try {
    await run("docker", ["compose", "-f", COMPOSE_FILE, "up", "-d", "--wait"], {
      timeout: 180_000,
    });
  } catch (error) {
    throw new Error(
      `Could not start the local test topology with "docker compose -f ${COMPOSE_FILE} up -d --wait".\n` +
        `Docker must be running for integration, e2e and chaos suites; unit tests need nothing.\n` +
        `Underlying error: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (await allUp()) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const states = await Promise.all(
    PORTS.map(
      async (entry) =>
        `${entry.name}:${(await canConnect(entry.port)) ? "up" : "down"}`,
    ),
  );
  throw new Error(`Local topology did not become reachable: ${states.join(", ")}`);
}
