/**
 * bAIzness end-to-end verification.
 *
 *   node verify.mjs
 *
 * Boots an isolated copy of the whole stack on free ports with a throwaway
 * database, then checks:
 *
 *   layout      folder structure is intact
 *   backend     health, auth, sessions, credentials, validation, persistence
 *   frontend    typecheck, dev server boots, /api proxy reaches the backend
 *   guards      regressions we have already fixed stay fixed
 *
 * Exit code 0 means both halves are healthy. Safe to run while your normal dev
 * servers are up: nothing here touches port 5000/5173 or the real database.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.join(__dirname, "backend");
const FRONTEND = path.join(__dirname, "frontend");

const API_PORT = 5088;
const UI_PORT = 5188;
const API = `http://127.0.0.1:${API_PORT}`;

const DB_FILE = path.join(BACKEND, "data", "verify.db");
const STATE_FILE = path.join(BACKEND, "data", "verify-state.json");
const SCRATCH = [DB_FILE, `${DB_FILE}-wal`, `${DB_FILE}-shm`, STATE_FILE];

let pass = 0;
let fail = 0;
const check = (name, cond, extra = "") => {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${name}${extra ? `  -> ${extra}` : ""}`);
  }
};
const section = (title) => console.log(`\n${title}`);

function killTree(child) {
  if (!child || child.exitCode !== null) return;
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

async function waitFor(url, tries = 80) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const r = await fetch(url);
      if (r.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

/**
 * Resolve a reachable origin for a dev server. Vite binds "localhost", which can
 * resolve to ::1 only, so try both loopback spellings before giving up.
 */
async function pickBase(port, hosts = ["127.0.0.1", "localhost"], tries = 80) {
  for (let i = 0; i < tries; i += 1) {
    for (const host of hosts) {
      const base = `http://${host}:${port}`;
      try {
        const r = await fetch(`${base}/`);
        if (r.ok) return base;
      } catch {
        /* try the next spelling */
      }
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

async function api(method, url, body, token) {
  const res = await fetch(API + url, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* no body */
  }
  return { status: res.status, data };
}

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], ...options });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code, out }));
  });
}

const read = (p) => fs.readFileSync(p, "utf-8");

for (const f of SCRATCH) fs.rmSync(f, { force: true });

let backend = null;
let vite = null;

try {
  console.log("\nbAIzness end-to-end verification\n" + "=".repeat(46));

  /* ---------------------------------------------------------------- layout */

  section("layout");
  check("baizness/backend exists", fs.existsSync(path.join(BACKEND, "src", "index.js")));
  check("baizness/frontend exists", fs.existsSync(path.join(FRONTEND, "src", "App.tsx")));
  check("backend SQLite module present", fs.existsSync(path.join(BACKEND, "src", "database.js")));
  check("frontend deps installed", fs.existsSync(path.join(FRONTEND, "node_modules", "vite")));

  /* --------------------------------------------------------------- backend */

  section("backend api");
  backend = spawn(process.execPath, [path.join(BACKEND, "src", "index.js")], {
    env: { ...process.env, PORT: String(API_PORT), BAIZNESS_DB_FILE: DB_FILE, BAIZNESS_STATE_FILE: STATE_FILE },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let boot = "";
  backend.stdout.on("data", (d) => (boot += d));
  backend.stderr.on("data", (d) => (boot += d));

  const up = await waitFor(`${API}/api/health`);
  check(`backend boots on :${API_PORT}`, up, boot.trim().split("\n").join(" | "));
  if (!up) throw new Error("backend never became healthy");

  const health = await api("GET", "/api/health");
  check("health reports the sqlite engine", health.data?.database?.engine === "node:sqlite", JSON.stringify(health.data?.database));
  check("demo founders seeded", (health.data?.database?.users ?? 0) >= 8, `users=${health.data?.database?.users}`);

  const good = await api("POST", "/api/auth/login", { email: "user@baizness.demo", password: "user123" });
  check("valid credentials return 200", good.status === 200 && good.data?.ok === true, `status=${good.status}`);
  check("login issues a session token", typeof good.data?.token === "string" && good.data.token.length === 64);
  check("login response carries no password", !("password" in (good.data?.user || {})));
  const token = good.data?.token;

  const bad = await api("POST", "/api/auth/login", { email: "user@baizness.demo", password: "wrong" });
  check("wrong password returns 401", bad.status === 401, `status=${bad.status}`);
  const suspended = await api("POST", "/api/auth/login", { email: "sofia.alvarez@baizness.demo", password: "user123" });
  check("suspended account returns 403", suspended.status === 403, `status=${suspended.status}`);

  const me = await api("GET", "/api/auth/me", null, token);
  check("bearer token resolves the session", me.status === 200 && me.data?.user?.email === "user@baizness.demo", `status=${me.status}`);
  check("missing token returns 401", (await api("GET", "/api/auth/me")).status === 401);

  const state = await api("GET", "/api/state");
  check("/api/state returns the workspace", Array.isArray(state.data?.users) && Array.isArray(state.data?.ideas), `keys=${Object.keys(state.data || {}).length}`);
  check("/api/state leaks no credentials", !JSON.stringify(state.data?.users || []).includes('"password"'));

  const id = `i-verify${Date.now().toString(36)}`;
  const validated = await api("POST", "/api/validate", {
    userId: "u-alex",
    ideaId: id,
    title: "Verification Ledger",
    category: "Climate",
    problem: "Ports cannot verify offsets across carriers reliably",
    solution: "A shared ledger reconciling emissions per voyage",
    audience: "Port authorities",
    region: "North America",
    budget: "$100k-$250k",
    model: "SaaS subscription",
    competitorNotes: "",
  });
  check("/api/validate keeps the client idea id", validated.data?.idea?.id === id, `id=${validated.data?.idea?.id}`);
  const idea = validated.data?.idea;
  check(
    "engine writes a complete analysis payload",
    Array.isArray(idea?.swot?.strengths) && (idea?.personas?.length ?? 0) > 0 && (idea?.financials?.length ?? 0) > 0 && (idea?.steps?.length ?? 0) > 0,
    `personas=${idea?.personas?.length} financials=${idea?.financials?.length} steps=${idea?.steps?.length}`
  );
  const fetched = await api("GET", `/api/ideas/${id}`);
  check("validated idea persists (deep-dive survives reload)", fetched.status === 200 && fetched.data?.id === id, `status=${fetched.status}`);
  const plan = await api("GET", `/api/plans/${id}`);
  check("business plan stored for the idea", plan.status === 200 && plan.data?.ideaId === id, `status=${plan.status}`);

  /* ---------------------------------------------------- credential store */

  section("credential store");
  const email = `verify.${Date.now().toString(36)}@baizness.demo`;
  const created = await api("POST", "/api/auth/signup", { name: "Verify Bot", email, password: "verify12345" });
  check("signup creates an account", created.status === 201 && created.data?.ok === true, `status=${created.status}`);
  check("signup returns a session token", typeof created.data?.token === "string" && created.data.token.length === 64);

  const relogin = await api("POST", "/api/auth/login", { email, password: "verify12345" });
  check("new credential survives a re-login", relogin.status === 200, `status=${relogin.status}`);

  const rotated = await api("POST", "/api/auth/change-password", { current: "verify12345", next: "rotated12345" }, relogin.data?.token);
  check("password rotation accepted", rotated.status === 200 && rotated.data?.ok === true, `status=${rotated.status}`);
  check("old password rejected after rotation", (await api("POST", "/api/auth/login", { email, password: "verify12345" })).status === 401);
  const fresh = await api("POST", "/api/auth/login", { email, password: "rotated12345" });
  check("new password accepted after rotation", fresh.status === 200, `status=${fresh.status}`);
  check("wrong current password rejected", (await api("POST", "/api/auth/change-password", { current: "nope", next: "another12345" }, fresh.data?.token)).status === 401);

  await api("POST", "/api/auth/logout", null, fresh.data?.token);
  check("logout invalidates the token", (await api("GET", "/api/auth/me", null, fresh.data?.token)).status === 401);

  const dbBytes = fs.readFileSync(DB_FILE);
  check("sqlite database written to disk", dbBytes.length > 0, `${dbBytes.length} bytes`);
  check("no plain-text password on disk", !dbBytes.includes("user123") && !dbBytes.includes("rotated12345"));
  check("json store has no users collection", !("users" in JSON.parse(read(STATE_FILE))));

  await api("DELETE", `/api/users/${created.data?.user?.id}`);
  check("deleting an account revokes its login", (await api("POST", "/api/auth/login", { email, password: "rotated12345" })).status === 401);

  /* -------------------------------------------------------------- frontend */

  section("frontend");
  const tsc = await run(process.execPath, [
    path.join(FRONTEND, "node_modules", "typescript", "bin", "tsc"),
    "--noEmit",
    "--project",
    path.join(FRONTEND, "tsconfig.json"),
  ]);
  check("typecheck passes", tsc.code === 0, tsc.out.trim().split("\n").slice(0, 4).join(" | "));

  vite = spawn(
    process.execPath,
    [path.join(FRONTEND, "node_modules", "vite", "bin", "vite.js"), "--port", String(UI_PORT), "--strictPort", "--host", "127.0.0.1"],
    { cwd: FRONTEND, env: { ...process.env, BAIZNESS_API_PORT: String(API_PORT) }, stdio: ["ignore", "pipe", "pipe"] }
  );
  let viteLog = "";
  vite.stdout.on("data", (d) => (viteLog += d));
  vite.stderr.on("data", (d) => (viteLog += d));

  const uiBase = await pickBase(UI_PORT);
  check(`dev server boots on :${UI_PORT}`, Boolean(uiBase), viteLog.trim().split("\n").slice(-3).join(" | "));
  if (uiBase) {
    const html = await (await fetch(`${uiBase}/`)).text();
    check("serves the SPA shell", html.includes('id="root"') && html.includes("<script"));
    const proxied = await fetch(`${uiBase}/api/health`)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
    check("/api proxy reaches the backend", proxied?.status === "ok", JSON.stringify(proxied));
    check("proxy talks to the sqlite backend", proxied?.database?.engine === "node:sqlite");
  }

  /* ------------------------------------------------------ source guards */

  section("regression guards");
  const app = read(path.join(FRONTEND, "src", "App.tsx"));
  const analysis = read(path.join(FRONTEND, "src", "pages", "user", "Analysis.tsx"));
  const ctx = read(path.join(FRONTEND, "src", "context.tsx"));

  check("/user/analysis route registered", app.includes('path="/user/analysis"'));
  check("routes wrapped in an ErrorBoundary", app.includes("ErrorBoundary"));
  check("analysis effect no longer depends on a fresh function identity", !analysis.includes("[params, setSelectedIdea]"));
  check("idea selection setter is memoized", ctx.includes("const setSelectedIdea = useCallback("));
  check("patchState is memoized", ctx.includes("const patchState = useCallback("));
  check("frontend never compares passwords locally", !ctx.includes("user.password !== current"));
} catch (err) {
  fail += 1;
  console.log(`  FAIL  uncaught error -> ${err.message}`);
} finally {
  killTree(vite);
  killTree(backend);
  await new Promise((r) => setTimeout(r, 400));
  for (const f of SCRATCH) {
    try {
      fs.rmSync(f, { force: true });
    } catch {
      /* windows may hold the handle briefly */
    }
  }
}

console.log(`\n${"=".repeat(46)}`);
console.log(fail === 0 ? `ALL GREEN — ${pass} checks passed` : `${pass} passed, ${fail} FAILED`);
console.log("");
process.exit(fail ? 1 : 0);