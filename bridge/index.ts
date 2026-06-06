import { resolveConfigPath } from "./config.js";
import { startBridgeRuntime } from "./runtime.js";

const command = process.argv[2] === "once" ? "once" : "run";
const configPath = resolveConfigPath(process.argv.slice(2));

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));

void startBridgeRuntime({ command, configPath, healthServer: command !== "once" }).catch((err) => {
  console.error(`[bridge] arrêt: ${(err as Error).stack ?? String(err)}`);
  process.exitCode = 1;
});
