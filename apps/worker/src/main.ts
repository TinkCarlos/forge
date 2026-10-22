import { startRuntime, stopRuntime } from "@forge/runtime";

startRuntime();
console.log("Forge worker started");

const shutdown = (): void => {
  stopRuntime();
  console.log("Forge worker stopping");
  process.exit(0);
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
