// Smoke test: launches the Electron app, verifies the process tree stays alive
// for 12 seconds (window creation has happened by then), then kills it.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const exe = path.join(__dirname, "node_modules", "electron", "dist", "electron.exe");

const t0 = Date.now();
const events = [];
const child = spawn(exe, ["--no-sandbox", "--disable-gpu", "--in-process-gpu", __dirname], {
  stdio: ["ignore", "pipe", "pipe"],
  // The host environment may carry ELECTRON_RUN_AS_NODE=1 (an Electron-based
  // app reusing the binary as Node); the GUI must run without it.
  env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "ELECTRON_RUN_AS_NODE")),
});
let stderr = "";
child.on("spawn", () => events.push(`spawn@${Date.now() - t0}ms`));
child.stderr.on("data", (data) => { stderr += data.toString(); });
child.stdout.on("data", (data) => { events.push(`stdout@${Date.now() - t0}ms: ${data.toString().slice(0, 200)}`); });
child.on("exit", (code, signal) => {
  events.push(`exit@${Date.now() - t0}ms code=${code} signal=${signal}`);
});

const result = { pid: child.pid, events, stderrTail: "" };
setTimeout(() => {
  result.aliveAfter12s = child.exitCode === null;
  try { child.kill(); } catch {}
  setTimeout(() => {
    result.stderrTail = stderr.slice(-1200);
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.aliveAfter12s ? 0 : 1);
  }, 1500);
}, 12000);
