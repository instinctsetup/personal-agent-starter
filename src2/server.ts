/** v2 entry: build UI if needed, start daemon, open the control center. */
import { buildApp } from "./app.js";
import { warnIfCloudSynced } from "./onedrive-check.js";

const PORT = Number(process.env.PORT || 8787);

const app = await buildApp();
const { startScheduler } = await import("./scheduler.js");
const { handleUserMessage } = await import("./agent2.js");
startScheduler(async (cmd) => handleUserMessage(cmd));
const HOST = process.env.HOST || "127.0.0.1";
await app.listen({ port: PORT, host: HOST });
console.log(`personal-agent v2 control center: http://${HOST}:${PORT}`);
warnIfCloudSynced(); // loud startup warning if ./data sits inside a OneDrive/Dropbox-synced path (WAL corruption risk)

if (process.env.NO_OPEN !== "1") {
  try {
    const { default: open } = await import("open");
    await open(`http://127.0.0.1:${PORT}`);
  } catch { /* headless */ }
}
