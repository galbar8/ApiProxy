import { buildProvider } from "./app.js";

const port = Number(process.env["PORT"] ?? 8090);
const { app } = buildProvider();

app
  .listen({ host: "0.0.0.0", port })
  .then(() => {
    console.log(`fake provider listening on ${port}`);
  })
  .catch((error: unknown) => {
    console.error("fake provider failed to start", error);
    process.exit(1);
  });
