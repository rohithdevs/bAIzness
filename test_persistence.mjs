/**
 * Regression test for the "local-only mutation reverts on refresh" bug class.
 *
 *   node test_persistence.mjs
 *
 * Every check follows the same shape: mutate via the API exactly like
 * context.tsx sync() does, then re-read through GET /api/state — the same
 * endpoint the mount-time hydration uses — and assert the mutation survived.
 */
const API = "http://127.0.0.1:5000";

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

async function api(method, path, body, token) {
  const res = await fetch(API + path, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* no body */
  }
  return { status: res.status, data };
}

/** Fetch the state exactly as a browser refresh would hydrate it. */
const hydrate = () => api("GET", "/api/state");

console.log("\npersistence across refresh (sync() mirror test)\n" + "=".repeat(46));

const login = await api("POST", "/api/auth/login", { email: "user@baizness.demo", password: "user123" });
const token = login.data?.token;
const userId = login.data?.user?.id;
check("signed in", Boolean(token), JSON.stringify(login.data));

/* ------------------------------------- notifications (the reported bug) */
const created = await api(
  "POST",
  "/api/notifications",
  { id: `n-test${Date.now().toString(36)}`, userId, type: "system", title: "Persist probe", message: "probe", read: false, createdAt: "2026-01-01" },
  token
);
const nid = created.data?.id;
check("notification created with the client id", created.status === 201 && typeof nid === "string", `status=${created.status}`);

await api("PATCH", `/api/notifications/${nid}`, { read: true }, token);
let state = (await hydrate()).data;
check("mark-read survives a refresh", state?.notifications?.find((n) => n.id === nid)?.read === true);

await api("POST", "/api/notifications/read-all", { userId }, token);
state = (await hydrate()).data;
const mine = (state?.notifications || []).filter((n) => n.userId === userId);
check("mark-all-read survives a refresh", mine.length > 0 && mine.every((n) => n.read === true), `${mine.length} notifications`);

await api("DELETE", `/api/notifications/${nid}`, undefined, token);
state = (await hydrate()).data;
check("delete notification survives a refresh", !state?.notifications?.some((n) => n.id === nid));

/* ------------------------------------------------- validate id parity */
const ideaId = `i-persist${Date.now().toString(36)}`;
const rid = `r-persist${Date.now().toString(36)}`;
const nnid = `n-persist${Date.now().toString(36)}`;
const aid = `a-persist${Date.now().toString(36)}`;
const recoId = `rc-persist${Date.now().toString(36)}`;
const validated = await api(
  "POST",
  "/api/validate",
  {
    userId,
    ideaId,
    reportId: rid,
    notificationId: nnid,
    activityId: aid,
    recommendations: [
      { id: recoId, ideaId, userId, title: "Probe reco", detail: "d", impact: "high", effort: "low", category: "Discovery", done: false },
    ],
    title: "Persistence Probe Ledger",
    category: "Climate",
    problem: "Ports cannot verify offsets",
    solution: "A shared ledger",
    audience: "Port authorities",
    region: "North America",
    budget: "$100k-$250k",
    model: "SaaS subscription",
    competitorNotes: "",
  },
  token
);
check("validate accepted the satellite ids", validated.status === 201, `status=${validated.status}`);
state = (await hydrate()).data;
check("validated notification uses the client id", state?.notifications?.some((n) => n.id === nnid));
check("validated report uses the client id", state?.reports?.some((r) => r.id === rid));
check("validated activity uses the client id", state?.activities?.some((a) => a.id === aid));
check("validation recommendations persisted", state?.recommendations?.some((r) => r.id === recoId));


/* ------------------------------- same-id re-validate cannot duplicate */
const again = await api(
  "POST",
  "/api/validate",
  { userId, ideaId, reportId: rid, notificationId: nnid, activityId: aid, title: "Persistence Probe Ledger", category: "Climate", problem: "x", solution: "y", audience: "z", region: "North America", budget: "$100k-$250k", model: "SaaS subscription", competitorNotes: "" },
  token
);
state = (await hydrate()).data;
check(
  "re-validating the same id does not duplicate records",
  again.status === 201 &&
    (state?.ideas || []).filter((i) => i.id === ideaId).length === 1 &&
    (state?.reports || []).filter((r) => r.id === rid).length === 1 &&
    (state?.notifications || []).filter((n) => n.id === nnid).length === 1
);

/* ------------------------------------------------------- reco toggle */
await api("PATCH", `/api/recommendations/${recoId}`, { done: true }, token);
state = (await hydrate()).data;
check("reco toggle survives a refresh", state?.recommendations?.find((r) => r.id === recoId)?.done === true);

/* ------------------------------------ selected idea + idea posting */
await api("PATCH", "/api/state", { selectedIdeaId: ideaId }, token);
state = (await hydrate()).data;
check("selected idea survives a refresh", state?.selectedIdeaId === ideaId, `selected=${state?.selectedIdeaId}`);

const post1 = await api("POST", "/api/ideas", { id: "i-dupe-probe", title: "Dupe Probe", category: "Climate" }, token);
const post2 = await api("POST", "/api/ideas", { id: "i-dupe-probe", title: "Dupe Probe", category: "Climate" }, token);
state = (await hydrate()).data;
check(
  "POST /api/ideas is idempotent on the client id",
  (state?.ideas || []).filter((i) => i.id === "i-dupe-probe").length === 1 && post1.status === 201 && post2.status === 200,
  `p1=${post1.status} p2=${post2.status}`
);

/* ------------------------------- categories / prefs / platform */
const catId = `c-persist${Date.now().toString(36)}`;
await api("POST", "/api/categories", { id: catId, name: `Probe ${catId}`, enabled: true, count: 0, description: "probe", color: "#fff" }, token);
await api("PATCH", `/api/categories/${catId}`, { enabled: false }, token);
state = (await hydrate()).data;
const cat = state?.categories?.find((c) => c.id === catId);
check("category create + edit survive a refresh", Boolean(cat) && cat.enabled === false);
await api("DELETE", `/api/categories/${catId}`, undefined, token);
state = (await hydrate()).data;
check("category delete survives a refresh", !state?.categories?.some((c) => c.id === catId));

await api("PATCH", `/api/prefs/${userId}`, { weeklyDigest: false }, token);
state = (await hydrate()).data;
check("prefs edit survives a refresh", state?.prefs?.[userId]?.weeklyDigest === false);
await api("PATCH", `/api/prefs/${userId}`, { weeklyDigest: true }, token);

await api("PATCH", "/api/platform", { maxIdeasFree: 7 }, token);
state = (await hydrate()).data;
check("platform edit survives a refresh", state?.platform?.maxIdeasFree === 7);

/* ------------------------------------------------- feedback + reports */
const fbId = `fb-persist${Date.now().toString(36)}`;
await api("POST", "/api/feedback", { id: fbId, userId, userName: "Probe", subject: "s", message: "m", status: "open", rating: 5, createdAt: "2026-01-01" }, token);
await api("PATCH", `/api/feedback/${fbId}`, { status: "resolved" }, token);
state = (await hydrate()).data;
check("feedback create + resolve survive a refresh", state?.feedback?.find((f) => f.id === fbId)?.status === "resolved");

const rpId = `r-lib${Date.now().toString(36)}`;
await api("POST", "/api/reports", { id: rpId, ideaId, userId, title: "Probe snapshot", type: "Deep-Dive", createdAt: "2026-01-01", size: "1 MB" }, token);
state = (await hydrate()).data;
check("report save survives a refresh", state?.reports?.some((r) => r.id === rpId));
await api("DELETE", `/api/reports/${rpId}`, undefined, token);
state = (await hydrate()).data;
check("report delete survives a refresh", !state?.reports?.some((r) => r.id === rpId));

/* ----------------------------------------------------------- cleanup */
await api("DELETE", `/api/ideas/${ideaId}`, undefined, token);
await api("DELETE", `/api/ideas/i-dupe-probe`, undefined, token);
await api("DELETE", `/api/notifications/${nnid}`, undefined, token);
state = (await hydrate()).data;
check(
  "idea delete survives a refresh",
  !state?.ideas?.some((i) => i.id === ideaId || i.id === "i-dupe-probe")
);

console.log("\n" + "=".repeat(46));
console.log(fail === 0 ? `ALL GREEN — ${pass} checks passed` : `${pass} passed, ${fail} FAILED`);
console.log("");
process.exit(fail ? 1 : 0);
