/** v2 entry: build UI if needed, start daemon, open the control center. */
import { buildApp } from "./app.js";

const PORT = Number(process.env.PORT || 8787);

const app = await buildApp();
const { startScheduler } = await import("./scheduler.js");
const { handleUserMessage } = await import("./agent2.js");
startScheduler(async (cmd) => handleUserMessage(cmd));
await app.listen({ port: PORT, host: "127.0.0.1" });
console.log(`personal-agent v2 control center: http://127.0.0.1:${PORT}`);

if (process.env.NO_OPEN !== "1") {
  try {
    const { default: open } = await import("open");
    await open(`http://127.0.0.1:${PORT}`);
  } catch { /* headless */ }
}
