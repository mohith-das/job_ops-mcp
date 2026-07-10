# jobops — Operator's Guide (project memory)

> A self-contained reference for **jobops**, a self-hosted Model Context Protocol (MCP)
> server for the end-to-end job search. Drop this file into your Claude Desktop (or any MCP
> client) **project memory** so you can ask "how do I X?" and get answers, and modify the
> tool confidently. This documents the **tool**, not any individual's job search — it is
> generic and public-repo-safe.
>
> Repo: https://github.com/mohith-das/jobops · npm: `jobops` · License: MIT
> Current line: **0.12.x**. Run `npm view jobops version` for the latest.

---

## 1. What it is — and the core split

jobops exposes a full job-search pipeline to your MCP client as **51 tools** + **6
editable behaviour resources**. The design principle:

- **The chat client is the brain.** It reasons, scores JDs, drafts resumes/cover letters and
  outreach. Most tools default to `mode: "chat"`: the server returns the rubric + context,
  the chat does the thinking, then calls the tool again to persist the result.
- **The server is the hands.** It scans job portals, normalizes JDs, renders resume/cover
  artifacts (LaTeX→PDF, `.tex`, `.docx`, HTML), runs a SQLite tracker, drafts/queues
  outreach, builds a negotiation brief, and returns every artifact as an
  `http://<host>:<port>/files/...` link the chat can hand back to you.

There is also an **`api` mode** for server-side scoring (see §8 Sampling) — but chat mode
needs no API key and is the default.

**Guiding principle: _this finds jobs; it does not send them._** No tool ever auto-submits
an application or auto-sends a DM. Every outward action stops at a draft/preview for a human
to review and send. (See §9 Hard rules.)

---

## 2. Architecture

Three planes in one process:
1. **MCP plane** — tools + resources, over **stdio** (e.g. Claude Desktop) or
   **streamable-HTTP** (e.g. LibreChat, Cursor).
2. **HTTP plane** — a file server (`/files/*` for rendered artifacts), a tracker dashboard
   (`/`) + soft-delete `/trash` page + `/api/*` CRUD endpoints (incl. `/api/status` server
   identity), `/healthz`, and the `/mcp` endpoint. One port serves all of it.
3. **Data plane** — a local **SQLite** DB (WAL mode) that holds all runtime state.

### Multi-client topology (one server, every client)
HTTP mode is the first-class **shared** mode: ONE long-running process on ONE port serves
many concurrent MCP clients (Claude Desktop via mcp-remote, Claude Code, opencode, codex,
gemini-cli, LibreChat, the web UI) against the one DB — work done in any client is
instantly visible in all others. Safety model: each HTTP request gets a **fresh MCP
protocol instance** (`src/mcp/server.ts` — a shared instance would cross-route responses
between overlapping clients); reads run concurrently under WAL; **all writes serialize
through `runInWriteLock`** in the single process; `busy_timeout=5000` covers a second
*process* on the same DB file (e.g. a stdio instance). `npx @mohith_das/jobops connect` prints
per-client config; `npx @mohith_das/jobops status` (or the `doctor` tool) verifies uptime, the
source-of-truth DB path + fingerprint, and which clients have connected. Beyond localhost,
`JOBOPS_AUTH_TOKEN` is mandatory (default-deny) and goes into every client's config.
stdio mode stays available as the single-client alternative (private process; needs its
own port next to a running shared server).

### SQLite schema (overview)
Key tables: `companies`, `company_aliases` (legal-name variants), `target_companies`
(what the scanner polls), `jobs`, `applications`, `eval_reports`, `career_packet`
(**versioned**, one `is_active=1` row), `contacts`, `linkedin_connections`, `h1b_filings`,
`outreach`, `story_bank`, `negotiation_notes`, `enrichment`, `llm_calls` (telemetry →
`cost_estimate`), `scan_runs`, `scheduler_state`, `digest_state`.
Helper views: `v_top_jobs`, `v_rated_jobs`, `v_active_pipeline`, `v_apply_ready`,
`v_jobs_with_warm_intros`, `v_founder_network`, `v_followups_due`, `v_company_h1b_signal`.

### Job lifecycle (state machine)
`sourced → scored → ready_to_apply → applied → screen → onsite → offer`
(plus terminal `rejected` / `discarded` / `skip`). Tools move jobs along this machine;
mutations are serialized through a write lock so concurrent tool calls never interleave.

### modes/ resources (the editable "brain")
Six markdown files shape behaviour. They ship bundled in the package, but `init` copies
editable copies into `<project-root>/modes/`. **Loader precedence (per file): the
project-root copy wins, the bundled default is the fallback.** Re-running `init` never
overwrites an edited copy (it warns); `doctor` reports which files are user-overridden vs
bundled. Edits are live-reloaded (no restart) and exposed as MCP resources.

| File | Controls |
|---|---|
| `modes/rubric.md` | Scoring dimensions, weights, role priority, archetype override, hard rules |
| `modes/report_format.md` | The 6-block A–F (+G) evaluation report shape |
| `modes/tailoring_rules.md` | Resume/cover tailoring decisions per `role_category` |
| `modes/outreach_tone.md` | Outreach char caps, forbidden phrases, persona |
| `modes/negotiation_playbook.md` | Negotiation framework + scripts |
| `modes/career_packet.md` | Career-packet structural template (preamble + Section 9 hard rules) |

### career_packet versioning + the source-of-truth model
The **career packet** is the authoritative superset of every claim you may make. It is
**versioned** in the `career_packet` table (one active row; reseeds demote the prior row and
keep history). It is rebuilt ("reseeded") from:
- `config/profile.yml` → Section 1 (identity) + Section 2 (taglines)
- `cv.md` (parsed) → Sections 3–8 (experience bullets, projects, skills, education)
- `modes/career_packet.md` → the template wrapper + Section 9 hard rules (preserved across reseeds)

Each row records an `origin`: `seed` / `reseed` (built from the source files) or
`chat_edit` (written via `update_career_packet`). This makes editing safe from **both**
directions (see §12):
> **Two safe edit directions, neither destructive.** Edit from chat
> (`update_career_packet`) — the packet is marked `chat_edit` and a plain `reseed` then
> **refuses** to overwrite it (pass `force` to override). Or edit the source files and
> `reseed`. To reconcile, `sync_packet_to_cv` writes the packet back into `cv.md` +
> `profile.yml`. `reseed` = cv.md → packet; `sync_packet_to_cv` = packet → cv.md.

---

## 3. The 51 tools (grouped)

Most reasoning tools take `mode: "chat"` (default, no key) or `mode: "api"` (server-side).

**Evaluation**
- `evaluate_job` — 2-step JD evaluator. Step 1: `input` (URL or pasted JD) → returns
  normalized JD + rubric + career packet. Step 2: `job_id` + `report` + `scores` → persists
  the 6-block report + scores, returns a report link. `mode="api"` runs both server-side.
- `batch_evaluate` — rates all unrated jobs (`score_total IS NULL`); params `role_category`,
  `company`, `limit`, `concurrency`. Reports an A–F tier distribution + `scored_via`.
- `get_top_jobs` — highest-scored jobs; params `min_score`, `limit`, `role_category`.
- `evaluate_training` / `evaluate_project` — score a course/cert or a side-project idea
  against your profile.

**Materials**
- `generate_materials` — picks bullets/tagline/projects from the packet per a JD via the
  tailoring rules; writes tailored bullets + cover draft; runs the visa-leakage scan before
  persisting.
- `render_pdf` — renders resume/cover. Params: `job_id`, `kind` (`resume|cover|both`),
  `formats` (subset of `["pdf","tex","docx"]`), `template` (theme name). Returns `/files/...` links.
  All formats share one content snapshot taken at call time (`core/render_source.ts`
  `cvForRender`): cv.md/profile.yml + the active packet (chat-edited packets win per
  section) + the job's current `tailored_bullets` — so every render reflects the
  latest `materials_v` and packet version, never a stale snapshot.
- `get_report` — fetch a saved eval report (HTML link).

**Tracker**
- `get_tracker` — filtered/paginated pipeline view (same query as the dashboard). Params:
  `statuses[]`/`status`, `min_score`/`max_score`, `company` (contains), `role_category`,
  `seniority`, `q` (title/company search), `sort` (score/discovered/company) + `dir`,
  `limit`/`offset`, `show_trashed`. Returns `items` + `total_matching` (across pages) +
  `counts_by_status` (FULL pipeline, independent of the filter). Trashed excluded by default.
- `update_status` — move a job along the lifecycle.
- `mark_ready_to_apply` — flag a job as ready.
- `delete_jobs` — **soft-delete (trash)** 1..N jobs by `job_ids` and/or `statuses` (e.g. all
  `skip`/`discard`). Recoverable; trashed jobs drop out of tracker/top_jobs/batch but are
  retained. Echoes title + company. NOT a hard delete.
- `restore_jobs` — bring trashed jobs back to their prior state.
- `list_trashed` — review what's in the trash (title, company, score, prior status, when trashed).
- `purge_jobs` — **HARD delete** of trashed jobs only. `job_ids` or `purge_all: true` (needs
  `confirm: true`). Writes a timestamped backup to the project root first; echoes what was
  permanently removed. The only path to permanent deletion.

**Sourcing**
- `scan_portals` — poll tracked ATS endpoints (Greenhouse, Ashby, Lever, Workday, Amazon,
  Google, generic Playwright); normalize + dedupe into `jobs`.

**Outreach** (all draft-only; you send manually)
- `find_warm_intros` — people you know at a target company (non-recruiters, ranked).
- `find_founders` — founders/C-suite in your network.
- `add_contacts` — insert/update **1..N** network contacts from chat in one call (complements
  the `import_linkedin` CSV path; for capturing people found mid-search). Upsert (match on
  `linkedin_url`, else `full_name` + company — no silent duplicates), same company alias
  resolution, title-based role-flag inference, merge-don't-clobber on update. Writes to
  `linkedin_connections`, so contacts are discoverable by `find_warm_intros`/`find_founders`.
  Only `full_name` required; partial contacts are stored and gaps reported per contact. The
  client parses free-text into the structured fields first.
- `export_contacts` — dump ALL contacts + every field to timestamped `contacts_export_*.csv`
  + `.json` in the project root (backup/portability).
- `import_contacts path="…"` — **upsert/merge** from a `.json`/`.csv` (never delete-and-replace;
  blank fields don't overwrite richer data; idempotent re-import = no dups, no loss). Writes a
  backup first.
- `delete_contacts` — **soft-delete** 1..N (by `linkedin_url` / `full_name`+company / `id`).
  Archived rows hidden from `find_warm_intros`/`find_founders` but recoverable; backup written
  first; result echoes exactly which rows matched.
- `draft_outreach` — warm-intro / founder DM (2-step chat, or `mode=api`); validates safety rails.
- `draft_followup` / `draft_reply` — nudge / reply drafts.
- `get_outreach_queue` / `update_outreach` / `get_followups_due` — manage the queue + due nudges.

**Interview / offer**
- `extract_stories` — mine STAR stories from your CV/packet into `story_bank`.
- `get_story_bank` — retrieve stories.
- `negotiation_brief` — build an anchor + pillars + knobs brief for an offer.

**Research**
- `deep_research` — structured company/role research prompt + context.
- `enrich_company` — fill company metadata.
- `daily_digest` — a morning summary of new high-scoring jobs + due follow-ups.

**Profile + ops**
- `get_career_packet` — read the active packet (markdown + version + origin).
- `update_career_packet` — **edit the packet from chat** and persist a new version. Two
  modes: full replace (`content`) or ergonomic **section edit** (`section` + `section_content`,
  e.g. section "2" for taglines, "6" for projects — no need to re-send the whole packet).
  Marks the packet **user-edited** so a later reseed won't silently overwrite it.
- `reseed_career_packet` — rebuild the active packet from `cv.md` + `profile.yml`. **Safe by
  default:** refuses (warns) if the packet has chat edits not in cv.md; pass `force:true` to
  rebuild anyway.
- `sync_packet_to_cv` — **inverse of reseed:** write the active packet back into `cv.md`
  (Sections 3–8) + `profile.yml` (taglines/identity) so the source files catch up to chat
  edits and a later reseed reproduces them. Optional `then_reseed:true` to rebuild + reconcile
  in one step.
- `edit_packet_item` / `remove_packet_item` — change/remove ONE item (bullet/project/skill/
  tagline) in a section (`projects`/`skills`/`taglines`/`education` or a number; experience =
  3/4/5) by 1-based index or matching substring — no whole-doc resend. Versions the packet;
  edit runs the visa scan on new text; remove echoes what it deleted.
- `restore_packet_version` — list packet versions (call with no arg) or restore one (writes its
  content as a new active version). Makes every edit/removal reversible.
- `update_profile` — capture identity fields + taglines via elicitation (or `fields={...}`),
  write `profile.yml`, and reseed in one step (see §8).
- `cost_estimate` — LLM spend per provider/model/tool over a window (flags sampling as
  client-borne $0).
- `doctor` — **read-only health report** (same checks as the `npx @mohith_das/jobops doctor` CLI):
  packet ↔ cv.md sync state (incl. chat-edited / cv-edited-after-reseed), LLM provider+key,
  sampling + auth posture, active template, modes (bundled vs overridden), visa scoring,
  public base URL, Chromium, Node, config files. Returns structured `{ ok, counts, checks[],
  summary }`. Mutates nothing.

**Apply (preview only — never submits)**
- `apply_prefill` — opens the application page, drafts field values, screenshots, and stops.

**Visa (optional; hidden when `JOBOPS_VISA_SCORING=false`)**
- `visa_signal` — H1B-friendliness band for a company (internal scoring only).
- `import_h1b` — bulk-load a DOL OFLC LCA disclosure CSV.
- `import_linkedin` — bulk-load a LinkedIn `Connections.csv` (path can be captured
  out-of-band via URL-mode elicitation — see §8).

**Scheduler (opt-in cron, off by default)**
- `scheduler_status` / `scheduler_enable` / `scheduler_disable` — run scans + batch rates on
  a cadence while the server is alive.

---

## 4. Environment variables

| Var | Default | Purpose |
|---|---|---|
| `JOBOPS_PORT` | `7891` | HTTP port (MCP + file server + dashboard) |
| `JOBOPS_HOST` | `127.0.0.1` | Bind host. Non-localhost ⇒ requires `JOBOPS_AUTH_TOKEN` (see §10) |
| `JOBOPS_PROJECT_ROOT` | cwd | Where `cv.md` / `config/profile.yml` / `portals.yml` / `modes/` live |
| `JOBOPS_DATA_DIR` | `<root>/data` | SQLite DB + WAL |
| `JOBOPS_OUTPUT_DIR` | `<root>/output` | Rendered artifacts (PDF/tex/docx/report HTML) |
| `JOBOPS_PUBLIC_BASE_URL` | host:port | URL emitted in artifact links (set on remote/Tailscale/LAN) |
| `JOBOPS_TEMPLATE_DIR` | _empty_ | User theme dir; overrides bundled themes of the same name |
| `JOBOPS_DEFAULT_TEMPLATE` | `default` | Theme used by `render_pdf` when no `template` arg given |
| `JOBOPS_AUTH_TOKEN` | _empty_ | Bearer token gating `/mcp`, `/files`, dashboard. **Required** for non-localhost bind |
| `JOBOPS_SAMPLING` | `true` | Use MCP sampling for `api`/batch scoring **if the client advertises it** (most, incl. Claude Desktop, don't → BYO key used); `false` always uses BYO key |
| `JOBOPS_LLM_PROVIDER` | `gemini` | BYO-key path for `api`/batch scoring — used whenever the client lacks sampling (the common case): `gemini` / `deepseek` / `none` |
| `JOBOPS_LLM_MODEL` | _empty_ | Provider model id |
| `GEMINI_API_KEY` / `DEEPSEEK_API_KEY` | _empty_ | Provider credentials — needed for `api`/batch unless the client supports sampling (most don't); `mode="chat"` never needs a key |
| `JOBOPS_VISA_SCORING` | `true` | `false` drops visa from the rubric + hides the visa tools |
| `JOBOPS_SCHEDULER_ENABLED` | `false` | Whether opt-in cron runs at all |

---

## 5. Setup (first run)

```bash
# 1. Scaffold cv.md, config/profile.yml, portals.yml, modes/*.md + the SQLite DB
npx @mohith_das/jobops@latest init        # idempotent; never overwrites edited files

# 2. Edit the three source files — replace every <TODO> placeholder:
#    cv.md            → your experience, projects, skills, education
#    config/profile.yml → identity, target roles, taglines, comp/location
#    portals.yml      → companies + scan filters
#    (optional) modes/*.md → tune rubric / tailoring / tone

# 3. Rebuild the career packet from your now-real cv.md + profile.yml
npx @mohith_das/jobops@latest reseed

# 4. Confirm wiring (Node, Chromium, files, modes, auth, scoring backend, packet freshness)
npx @mohith_das/jobops@latest doctor

# 5. Boot (HTTP). Chromium auto-installs on first run.
npx @mohith_das/jobops@latest start
```

CLI commands: `init`, `start`, `start --stdio`, `reseed`, `templates`, `doctor`, `connect`
(per-client shared-HTTP config: Claude Desktop/Code, opencode, codex, gemini-cli,
LibreChat; flags `--host --port --token`), `status` (query a running server: uptime,
source-of-truth DB + fingerprint, clients seen; flags `--url --token`), `help`, `--version`.

### Claude Desktop (stdio transport)
`~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) /
`%APPDATA%/Claude/...` (Windows):
```jsonc
{
  "mcpServers": {
    "jobops": {
      "command": "npx",
      "args": ["-y", "@mohith_das/jobops@0.8.0", "start", "--stdio"],
      "env": {
        "JOBOPS_PORT": "7891",
        "JOBOPS_PROJECT_ROOT": "/absolute/path/to/your/job-search-dir"
        // optional: JOBOPS_TEMPLATE_DIR, JOBOPS_DEFAULT_TEMPLATE, JOBOPS_VISA_SCORING, ...
      }
    }
  }
}
```
**Pin an explicit version** (`@0.8.0`) so npx doesn't silently reuse a stale cache; bump it
deliberately. After any config edit, **fully quit and reopen** Claude Desktop. `--stdio`
puts MCP on stdin/stdout while the HTTP file server still runs so `/files/*` links resolve.
Run `connect` to print ready-made config blocks.

### LibreChat (streamable-HTTP) — host process
In `librechat.yaml`:
```yaml
mcpServers:
  jobops:
    type: streamable-http
    url: http://127.0.0.1:7891/mcp
    timeout: 60000
```

### LibreChat in Docker
Inside a container `127.0.0.1` is the container, not the host. Use `host.docker.internal`
(Docker Desktop) or a LAN IP, **and** allowlist it (LibreChat blocks private addrs by default):
```yaml
mcpServers:
  jobops:
    type: streamable-http
    url: http://host.docker.internal:7891/mcp
    timeout: 60000
mcpSettings:
  allowedAddresses: ["host.docker.internal:7891"]
```
On Linux, add `extra_hosts: ["host.docker.internal:host-gateway"]` to the LibreChat service,
or use the host's LAN IP and allowlist that. Run `connect` for these blocks.

---

## 6. Custom resume / cover templates

A "theme" is a directory holding any of `resume.tex`, `cover.tex`, `resume.html`,
`cover.html`. Each is a plain template with `{{PLACEHOLDER}}` slots the renderer fills with
the same tailored content used for the bundled `default` theme (see `TEMPLATES.md` in the
repo for the full placeholder contract, e.g. `{{HEADER}}`, `{{EXPERIENCE}}`,
`{{PROJECTS}}`, `{{SKILLS}}`, `{{COVER_BODY}}`).

```bash
mkdir -p ~/job-themes/mytheme        # author resume.tex/cover.tex/resume.html/cover.html
export JOBOPS_TEMPLATE_DIR=~/job-themes
export JOBOPS_DEFAULT_TEMPLATE=mytheme    # or pass template="mytheme" to render_pdf
npx @mohith_das/jobops templates            # lists bundled + user themes; marks the default
```
The loader checks `JOBOPS_TEMPLATE_DIR` first, so a `default/` folder there overrides the
bundled default; brand-new themes are also picked up. A theme missing a placeholder drops
that section gracefully; in `.tex` themes a `%`-commented placeholder
(`% {{SUMMARY_SECTION}}`) drops it too — substitution skips LaTeX comments. A malformed
theme errors with the theme name + file path (no raw
LaTeX backtrace). `.docx` is generated programmatically and does not use themes.

---

## 7. The daily operating workflow

1. **Scan** — `scan_portals` (or let the scheduler poll) pulls new postings into `jobs`.
2. **Rate** — `batch_evaluate` scores the unrated ones; `get_top_jobs` surfaces the best.
3. **Evaluate a specific JD** — paste a URL/JD into `evaluate_job`; read the 6-block report.
4. **Tailor + render** — `generate_materials` then `render_pdf` (PDF/tex/docx) for top picks.
5. **Apply (manually)** — `apply_prefill` opens the page + drafts fields + screenshots; you
   review and submit. Then `update_status` / `mark_ready_to_apply`.
6. **Network** — `find_warm_intros` / `find_founders`; `draft_outreach`; you send; then
   `update_outreach status=sent`. `get_followups_due` + `draft_followup` for nudges.
7. **Interview/offer** — `extract_stories` / `get_story_bank`; `negotiation_brief` for offers.
8. **Maintain** — edit `cv.md`/`profile.yml` as you learn; **reseed**; `doctor` to confirm.

---

## 8. Sampling, elicitation, auth (0.8.x features)

All three are **capability-gated**: the server only uses a feature if the connected client
advertises it; otherwise it falls back to pre-existing paths.

### MCP sampling — scoring without an API key (only if the client supports it)
`batch_evaluate` and `evaluate_job mode="api"` can run on the **connected client's own model**
via **MCP sampling** (same rubric, same strict-JSON contract) — **but only if that client
advertises the `sampling` capability** in its initialize handshake.
- ⚠️ **Most clients don't — including Claude Desktop, as of now** (it advertises only its UI
  extension, never `sampling`). On those, scoring **falls back to the BYO key** — expected and
  correct. The transport is **not** sufficient on its own; it's a per-client capability.
  Current support: modelcontextprotocol.io/clients.
- It engages **automatically if (and only if) a sampling-capable client connects** — no config.
- Selection order: **sampling (only if advertised) → BYO key (`JOBOPS_LLM_PROVIDER` + key) → chat mode**.
- Cost is **client-borne**; `cost_estimate` records sampling calls and flags them $0 server cost.
- **Transport gate (necessary, not sufficient):** sampling is a server→client request, so stdio
  is required (stateless HTTP can't deliver it and never tries) — but a stdio client still must
  advertise `sampling`. `JOBOPS_SAMPLING=false` forces the BYO-key path.
- Run the **`doctor` tool** for the LIVE state: "sampling not advertised by current client →
  using BYO key" vs "sampling available → key optional".

### MCP elicitation — structured input instead of YAML editing
- `update_profile` uses **form-mode elicitation** to collect identity fields + taglines,
  writes `config/profile.yml`, and reseeds. Fallbacks: pass `fields={...}`, or edit the YAML.
- **Sensitive inputs** (a data-export path, credentials) use **URL-mode elicitation**: the
  server hands you a one-time local URL where you enter the value directly — it never passes
  through the chat transcript. `import_linkedin` uses this when `path` is omitted.
- Same transport gate as sampling (stdio); HTTP clients fall back to file/arg paths.

### Auth — protecting the remote / PII surface
The server handles PII (resume PDFs, connections, employer signal). Posture is decided by
bind host + token:

| Bind host | `JOBOPS_AUTH_TOKEN` | Result |
|---|---|---|
| `127.0.0.1` (default) | unset | **Open** — frictionless local use |
| `127.0.0.1` | set | Token required (opt-in even locally) |
| non-localhost (`0.0.0.0`/LAN/Tailscale) | **unset** | **Refuses to boot** (default-deny) |
| non-localhost | set | Token required on every PII route |

When required, `/mcp`, `/files/*`, and `/` demand `Authorization: Bearer <token>`; `401`s
carry a `WWW-Authenticate` header → `/.well-known/oauth-protected-resource` (aligns with the
MCP 2025-06-18 OAuth Resource Server model, static-token form). Always open: `/healthz`.
To expose remotely:
```bash
export JOBOPS_HOST=0.0.0.0
export JOBOPS_AUTH_TOKEN="$(openssl rand -hex 32)"
export JOBOPS_PUBLIC_BASE_URL="https://your-host.example"
```

---

## 9. Hard rules (enforced in code, not just documented)

1. **Visa data never reaches a candidate-facing artifact.** A leakage scan runs inside
   `render_pdf` (on the cover body) and `generate_materials` (on the whole output) *before*
   persistence; a detected leak **fails** the call. Visa data is internal scoring only.
2. **Never invent claims outside the career packet.** Only metrics/claims present in the
   packet (sourced from `cv.md`) are usable; nothing is fabricated.
3. **Human-in-the-loop everywhere.** No tool auto-submits an application or auto-sends a DM —
   everything stops at a draft/preview.
4. **Strict-JSON parsing with visible failure.** Scoring calls record parse errors and leave
   the score NULL — never silent `(0,0,0,0)`.
5. **Serialized writes.** All tracker/application/outreach mutations go through a write lock.
6. **PII never served unauthenticated to a network** — the default-deny boot guard (§8 auth).

**Outreach safety rails** (validated before any DM persists): character caps (typical: warm
600 / founder 300 / follow-up 300 / reply 800), no visa mentions, no "refer me", no emojis,
no exclamation marks, no clichés. A failing draft is returned with the offending rule.

---

## 10. Troubleshooting

- **`EADDRINUSE` on (re)start** — a previous server still holds the port. Find and kill it:
  `lsof -nP -iTCP:7891 -sTCP:LISTEN` then `kill <PID>` (or change `JOBOPS_PORT`). With
  Claude Desktop, fully quit the app so it stops the old stdio child before relaunch.
- **mcp-remote bridge dies with `Unexpected content type: null`** — known upstream bug,
  NOT this server: mcp-remote (≤ 0.1.38) under Node ≥ 26 — its bundled undici
  `EnvHttpProxyAgent` global dispatcher strips response headers from Node's built-in
  fetch. Fix: run the bridge under Node ≤ 24 (absolute path to a Node 24 binary +
  Node-24-installed mcp-remote in the client config). Affects ANY streamable-HTTP server
  behind mcp-remote, which is how to tell it apart from a real server issue.
- **`doctor` says "cv.md was edited after the last reseed"** — your packet is stale. Run
  `reseed` (CLI `npx @mohith_das/jobops reseed`, or the `reseed_career_packet` tool).
- **`doctor` fails on config files / wrong directory** — `doctor`/`start` resolve files from
  `JOBOPS_PROJECT_ROOT` (default = current working dir). Run from your job-search dir, or
  set `JOBOPS_PROJECT_ROOT` to its absolute path (do this in the Claude Desktop env block).
- **Stale version via npx** — `npx` caches by version and reuses it. Pin an explicit version
  in your client config (`@mohith_das/jobops@0.8.0`); to force-refresh a bare invocation,
  `rm -rf ~/.npm/_npx` then `npx @mohith_das/jobops@latest ...`. Confirm with `--version` / `doctor`.
- **Sampling/elicitation "not working"** — they require a **stdio** client (Claude Desktop).
  Over HTTP they gate off by design; configure a BYO key, or use chat mode.
- **Tool list looks short** — visa tools are hidden when `JOBOPS_VISA_SCORING=false`; that's
  expected.
- **Non-localhost bind won't start** — set `JOBOPS_AUTH_TOKEN` (default-deny, §8).

---

## 11. Layout

```
<project-root>/
  cv.md                  # source of truth: experience, projects, skills, education
  config/profile.yml     # source of truth: identity, target roles, taglines, comp/location
  portals.yml            # tracked companies + scan filters
  modes/                 # (optional) editable behaviour files — created by `init`
  data/                  # SQLite DB (jobops.db) + WAL — RUNTIME STATE
  output/                # rendered PDFs / .tex / .docx / report HTML
```

---

## 12. Federation contract v1 (shared with hirebridge + LivingCV)

jobops, hirebridge (central router), and LivingCV (personal relay) implement
the **Canonical Federation Contract v1** — the same auth flow, envelope, and
signature scheme, frozen in `plans_fixes_federation_interop.md`. The three
main invariants:

**Identity** — `candidate_id` = first 32 hex chars of `sha256(lowercase(trim(operator_email)))`.
jobops derives it from `federation_state.hirebridge_email` / `JOBOPS_HIREBRIDGE_EMAIL`.
Same function on every repo so signatures correlate.

**HireBridge device auth (one-time, per node).** jobops generates an ed25519
keypair on first connect and persists it in `federation_state` (cols added
by migration 008; never in the packet):

1. `POST /auth/device`   JSON `{node_type, endpoint_url, public_key}` →
                         `{device_code, user_code, verification_uri, …}`
2. `POST /auth/request`  form-encoded `email=<you>&uc=<user_code>` →
                         HireBridge emails the magic link.
3. `POST /auth/token`    form-encoded `grant_type=urn:ietf:params:oauth:grant-type:device_code&device_code=…`.
                         Pending states return **HTTP 400 + JSON** (not 2xx) — the
                         poller reads the body on every response, including 400s,
                         and switches on `authorization_pending` / `slow_down` /
                         `expired_token` / `access_denied`.

The success body carries `{access_token, node_id, email}` — jobops persists
the token to `.env` and `node_id` to `federation_state`.

**Snapshot broadcast.** `POST /ingest/snapshot` with envelope
`{candidate_id, payload, embedding, signature}`:
- `payload` = public-safe compiled packet + `candidate: {email, livingcv_url}` +
  `capabilities` + `packet_hash` + `packet_version` + `broadcast_at`.
- `signature` = **ed25519** over `JSON.stringify(payload)` bytes (NOT HMAC).
  The same object instance is used for both serialization and signing, so
  V8 preserves key order; the server's `json.RawMessage` keeps the bytes
  intact for verification.
- `embedding[0]` = whole-packet vector (section `__packet__`). HireBridge
  indexes only element 0 — per-section vectors are ignored at storage.
- Dim mismatch refuses the broadcast before sending (no garbage in the index).

**LivingCV packet sync.** MCP-over-SSE, not bare JSON-RPC:
- `SSEClientTransport` against `${JOBOPS_LIVINGCV_URL}/mcp-admin/sse`,
  `Authorization: Bearer ${JOBOPS_LIVINGCV_TOKEN}` on both the SSE GET and
  the message POSTs.
- `JOBOPS_LIVINGCV_TOKEN` is LivingCV's **`mcp.master_key`** (Admin →
  Settings → MCP), **not** a user JWT.
- Tool: `sync_career_packet` with arguments `{packet: <LcvPacket>}` (the
  mapped shape — see `src/core/livingcv_packet_map.ts`).
- Preconditions on the LivingCV side: `mcp.enabled = 1` and
  `mcp.jobops_sync_enabled = 1`. If a sync fails because of those, the error
  message names both flags so the user knows exactly where to look.

**Where the pieces live in this repo:**
- Keypair gen + persistence + RFC 8628 polling + envelope transport → `src/core/hirebridge_client.ts`.
- Snapshot compiler + ed25519 signature + dim guard → `src/core/signal_broadcast.ts`.
- LivingCV packet mapper (`CareerPacketJson → LcvPacket`) → `src/core/livingcv_packet_map.ts`.
- MCP-over-SSE `sync_career_packet` call → `src/core/livingcv_client.ts`.
- Whole-packet embedding in `__packet__` section → `src/core/embeddings.ts`.

---

## 13. Two edit directions (drift is now guarded, not a trap)

The DB `career_packet` is **runtime state**; `cv.md` + `config/profile.yml` (+ the
`modes/career_packet.md` template) are the **file source of truth**. You can edit from
either side, and the server stops one from silently destroying the other:

**Chat-driven (the packet is your edit surface).** `update_career_packet` writes a new
version marked `origin=chat_edit`. A plain `reseed` then **refuses** to rebuild over it —
it warns and asks for `force:true`, so accumulated chat edits are never silently wiped.
`doctor` reports this state as "chat-edited (ahead of cv.md) — expected," not a nag. Use
section edits (`section`+`section_content`) for surgical changes like "change my tagline."
Renders read the chat-edited packet directly: `render_pdf` overlays its Sections 3–8 onto
the cv.md base, so a packet edit shows up in the next render without a sync-back.

**File-driven (cv.md / profile.yml are the source).** Edit the files, then `reseed`:
- Identity, naming, links, **taglines** → `config/profile.yml` (taglines auto-fill Section 2).
- Experience bullets, projects, skills, education → `cv.md`.
- Standing policy that isn't a CV/profile field (name-rendering convention, LaTeX escaping
  rule, custom hard rules) → `modes/career_packet.md` **Section 9** + preamble (reseed
  preserves those; it only regenerates Sections 1–8).

**Reconcile the two.** `sync_packet_to_cv` writes the active packet back into `cv.md` +
`profile.yml` so the files catch up to chat edits — then a `reseed --force` reproduces the
packet instead of clobbering it. Symmetric: `reseed` = cv.md → packet; `sync_packet_to_cv`
= packet → cv.md. Both explicit; neither automatic.

Rule of thumb: chat edits are safe and durable; `reseed` only overwrites them if you pass
`force`. If you want the files to own the content, edit them and `reseed` (or sync-back first).
