/**
 * One command to run the whole stack.
 *
 *   node run.mjs
 *
 * Starts the API (:5000) and the Vite dev server (:5173) together, prefixes
 * their output, and shuts both down cleanly on Ctrl+C.
 */
import { spawn, spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_PORT = process.env.PORT || "5000";
const UI_PORT = process.env.BAIZNESS_UI_PORT || "5173";

// `node run.mjs --host` exposes the UI on the LAN (prints a second link).
const EXPOSE = process.argv.includes("--host");

const children = [];

function start(label, command, args, options) {
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], ...options });
  const tag = `[${label}]`;
  const pipe = (stream, isErr) => {
    stream.on("data", (buf) => {
      for (const line of String(buf).split(/\r?\n/)) {
        if (line.trim()) (isErr ? process.stderr : process.stdout).write(`${tag} ${line}\n`);
      }
    });
  };
  pipe(child.stdout, false);
  pipe(child.stderr, true);
  child.on("exit", (code) => {
    if (code !== 0 && code !== null) console.error(`${tag} exited with code ${code}`);
    shutdown(code ?? 0);
  });
  children.push(child);
  return child;
}

function shutdown(code = 0) {
  for (const child of children) {
    if (child.exitCode !== null) continue;
    try {
      if (process.platform === "win32") {
        spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      } else {
        child.kill("SIGTERM");
      }
    } catch {
      /* already gone */
    }
  }
  process.exit(code);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

console.log("bAIzness — starting both halves\n");

start("api", process.execPath, [path.join(__dirname, "backend", "src", "index.js")], {
  cwd: __dirname,
  env: { ...process.env, PORT: API_PORT },
});

start(
  "ui",
  process.execPath,
  [
    path.join(__dirname, "frontend", "node_modules", "vite", "bin", "vite.js"),
    "--port",
    UI_PORT,
    ...(EXPOSE ? ["--host"] : []),
  ],
  { cwd: path.join(__dirname, "frontend"), env: { ...process.env, BAIZNESS_API_PORT: API_PORT } }
);

setTimeout(() => {
  console.log(`\n  API     http://localhost:${API_PORT}/api/health`);
  console.log(`  App     http://localhost:${UI_PORT}/`);
  if (EXPOSE) {
    const lan = Object.values(os.networkInterfaces())
      .flat()
      .find((i) => i && i.family === "IPv4" && !i.internal);
    if (lan) console.log(`  LAN     http://${lan.address}:${UI_PORT}/`);
  }
  console.log(`  Sign in user@baizness.demo / user123   (or admin@baizness.demo / admin123)`);
  console.log(`\n  Ctrl+C stops both.\n`);
}, 2500);