# bAIzness

AI opportunity-validation platform: a React dashboard on top of an Express API with a
SQLite credential store.

```
baizness/
├── frontend/        React 19 + Vite + Tailwind + Recharts (hash-router SPA)
│   └── src/
│       ├── pages/user/Analysis.tsx   deep-dive report view
│       ├── context.tsx               app state + auth against the API
│       └── data.ts                   demo seed data + API helpers
├── backend/         Express REST API
│   ├── src/index.js                  routes
│   ├── src/database.js               SQLite (node:sqlite) credentials + sessions
│   ├── src/db.js                     JSON store for ideas/plans/… + seed fixtures
│   └── src/engine.js                 deterministic validation engine
├── verify.mjs       end-to-end verification of both halves
└── package.json     convenience scripts
```

## Run it

Two processes are needed; the frontend proxies `/api/*` to the backend. Both are
already installed — no `npm install` required.

```bash
# terminal 1 — API on :5000
node backend/src/index.js

# terminal 2 — UI on :5173
node frontend/node_modules/vite/bin/vite.js        # run from the frontend/ folder
```

Then open <http://localhost:5173>.

## Verify it

```bash
node verify.mjs          # backend API matrix + frontend typecheck + proxy check
```

This boots an isolated copy of the stack on free ports with a throwaway database,
so it can run while your dev servers are up. Exit code 0 means everything is healthy.

Individual halves:

```bash
node backend/scripts/smoke-auth.mjs                                   # auth + DB (28 assertions)
node frontend/node_modules/typescript/bin/tsc --noEmit -p frontend    # typecheck
```

## Demo accounts

| Role        | Email                  | Password   |
| ----------- | ---------------------- | ---------- |
| Super admin | admin@baizness.demo    | admin123   |

The super admin is the only account that can create, promote, demote, or remove
administrators. Set `BAIZNESS_SUPERADMIN_EMAIL` to the chosen account email before
starting the backend to designate a different super admin.

## Environment variables

| Variable               | Default            | Purpose                                        |
| ---------------------- | ------------------ | ---------------------------------------------- |
| `PORT`                 | `5000`             | Backend listen port                            |
| `BAIZNESS_DB_FILE`     | `backend/data/baizness.db` | SQLite credential database path        |
| `BAIZNESS_STATE_FILE`  | `backend/src/data.json`    | JSON store for ideas/plans/etc.         |
| `BAIZNESS_SUPERADMIN_EMAIL` | `admin@baizness.demo` | Account that receives the super admin role |
| `BAIZNESS_API_PORT`    | `5000`             | Port the frontend proxies `/api` to            |

## Storage

* **Credentials** live in **SQLite** (`backend/data/baizness.db`, git-ignored).
  Passwords are stored as per-user salted **scrypt** hashes; logins return opaque
  bearer tokens persisted in a `sessions` table. No password ever leaves the server.
* **Everything else** (ideas, plans, categories, reports, notifications) lives in
  `backend/src/data.json`, seeded from `backend/src/initialData.json`.
* `POST /api/state/reset` clears workspace records and restores only the configured super admin.
