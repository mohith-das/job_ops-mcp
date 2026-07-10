#!/usr/bin/env node
// jobops CLI entry point. Subcommands:
//   init    — scaffold cv.md / config/profile.yml / portals.yml from the .example files,
//             run migrations, prompt for project root. Idempotent (never overwrites).
//   start   — boot MCP + HTTP server. Auto-installs Chromium on first run.
//   doctor  — diagnose Node version, Chromium presence, config files, LLM key.
//   connect — print copy-paste config for every MCP client (Claude Desktop, Claude Code,
//             opencode, codex, gemini-cli, LibreChat) against ONE shared HTTP server.
//   status  — query a running server: uptime, source-of-truth DB, clients seen.

import { existsSync, copyFileSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

const here = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(here, '..');         // install root (where dist/, modes/, templates/, examples live)
const PKG = JSON.parse(readFileSync(resolve(PACKAGE_ROOT, 'package.json'), 'utf-8'));

// ── arg parser (tiny — no deps) ─────────────────────────────────────────────

function parseArgs(argv: string[]): { cmd: string; flags: Map<string, string | boolean>; positional: string[] } {
  const [, , cmd = 'help', ...rest] = argv;
  const flags = new Map<string, string | boolean>();
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith('--')) {
      const [k, ...vparts] = a.slice(2).split('=');
      const v = vparts.length ? vparts.join('=') : (rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[++i] : true);
      flags.set(k, v);
    } else { positional.push(a); }
  }
  return { cmd, flags, positional };
}

// ── color (tty-aware, no deps) ──────────────────────────────────────────────
const COLOR = process.stdout.isTTY;
const c = {
  bold:  (s: string) => COLOR ? `\x1b[1m${s}\x1b[0m`  : s,
  green: (s: string) => COLOR ? `\x1b[32m${s}\x1b[0m` : s,
  red:   (s: string) => COLOR ? `\x1b[31m${s}\x1b[0m` : s,
  yellow:(s: string) => COLOR ? `\x1b[33m${s}\x1b[0m` : s,
  dim:   (s: string) => COLOR ? `\x1b[2m${s}\x1b[0m`  : s,
};
const tick  = () => COLOR ? c.green('✓') : 'OK ';
const cross = () => COLOR ? c.red('✗')   : 'FAIL ';
const warn  = () => COLOR ? c.yellow('!') : 'WARN ';

// ── init ────────────────────────────────────────────────────────────────────

async function cmdInit(flags: Map<string, string | boolean>) {
  const yes = !!flags.get('yes');
  console.log(c.bold(`\njobops init`));
  console.log(c.dim(`package: ${PKG.name}@${PKG.version}`));
  console.log(c.dim(`install root: ${PACKAGE_ROOT}\n`));

  const cwd = process.cwd();
  console.log(`Project root: ${c.bold(cwd)}`);
  console.log(c.dim('(This is where cv.md, config/profile.yml, portals.yml will live. You can move them later — point the server at the new location with JOBOPS_PROJECT_ROOT.)\n'));

  const examples: Array<{ src: string; dst: string; label: string }> = [
    { src: 'cv.example.md',                dst: 'cv.md',                  label: 'CV (markdown)' },
    { src: 'config/profile.example.yml',   dst: 'config/profile.yml',     label: 'profile / targeting' },
    { src: 'portals.example.yml',          dst: 'portals.yml',            label: 'tracked portals + filters' },
  ];

  let scaffolded = 0, kept = 0;
  for (const { src, dst, label } of examples) {
    const srcAbs = resolve(PACKAGE_ROOT, src);
    const dstAbs = resolve(cwd, dst);
    if (!existsSync(srcAbs)) { console.log(`  ${cross()} example missing: ${src}`); continue; }
    if (existsSync(dstAbs)) {
      console.log(`  ${warn()} ${dst} already exists — not overwriting (${label})`);
      kept++;
      continue;
    }
    mkdirSync(dirname(dstAbs), { recursive: true });
    copyFileSync(srcAbs, dstAbs);
    console.log(`  ${tick()} scaffolded ${dst} (${label})`);
    scaffolded++;
  }

  // Scaffold the behavior-shaping mode files into <projectRoot>/modes/ so they're
  // user-editable (like cv.md / profile.yml). Idempotent: an existing (likely edited)
  // copy is never overwritten — we warn instead. The loader prefers these over the
  // bundled defaults (see core/modes.ts).
  const { MODE_FILES } = await import('./core/modes.js');
  const modesSrcDir = resolve(PACKAGE_ROOT, 'modes');
  const modesDstDir = resolve(cwd, 'modes');
  console.log('');
  for (const file of MODE_FILES) {
    const srcAbs = resolve(modesSrcDir, file);
    const dstAbs = resolve(modesDstDir, file);
    if (!existsSync(srcAbs)) { console.log(`  ${cross()} bundled mode missing: modes/${file}`); continue; }
    if (existsSync(dstAbs)) {
      console.log(`  ${warn()} modes/${file} already exists — keeping your edits (not overwriting)`);
      kept++;
      continue;
    }
    mkdirSync(modesDstDir, { recursive: true });
    copyFileSync(srcAbs, dstAbs);
    console.log(`  ${tick()} scaffolded modes/${file}`);
    scaffolded++;
  }

  // Run migrations by importing db.ts — getDb() applies pending migrations on first open.
  // Set JOBOPS_PROJECT_ROOT to cwd BEFORE config.ts gets imported so the data dir lives
  // next to the user's cv.md / profile.yml, not inside the package install.
  process.env.JOBOPS_PROJECT_ROOT = process.env.JOBOPS_PROJECT_ROOT || cwd;
  try {
    const { config: cfg } = await import('./config.js');
    const { getDb } = await import('./db.js');
    getDb();
    const {
      ensureActiveCareerPacket, getActiveCareerPacket,
      loadProjectFiles, packetStatus, seedCareerPacketFromFiles,
    } = await import('./core/profile.js');
    const seed = await ensureActiveCareerPacket();
    console.log(`\n  ${tick()} data dir: ${cfg.dataDir}`);
    console.log(`  ${tick()} SQLite migrations applied`);
    console.log(`  ${tick()} career_packet ${seed.created ? 'seeded' : 'present'} (v${seed.version})`);

    // Stale check: cv.md was edited after the last reseed? Rebuild and tell the user
    // clearly. The previous active row is demoted (history retained).
    const status = packetStatus({ active: getActiveCareerPacket(), cvMd: loadProjectFiles().cvMd });
    if (status === 'cv_edited_since_seed') {
      console.log(`  ${warn()} cv.md was edited after the last reseed.`);
      console.log(`  ${c.dim('→ auto-reseeding now (previous active row demoted, version bumped, history kept)…')}`);
      const r = await seedCareerPacketFromFiles({ mode: 'reseed' });
      console.log(`  ${tick()} reseeded → v${r.version} (${r.sections_with_cv_content}/6 sections populated from cv.md)`);
    } else if (status === 'packet_chat_edited') {
      console.log(`  ${tick()} active packet is chat-edited (ahead of cv.md) — left intact. ${c.dim('reseed will not overwrite it without --force.')}`);
    } else if (status === 'cv_is_example') {
      console.log(`  ${warn()} cv.md still looks like the example template — fill it in, then run ${c.bold('npx @mohith_das/jobops reseed')}.`);
    } else if (status === 'packet_is_template') {
      console.log(`  ${warn()} active packet still has TODO markers. Run ${c.bold('npx @mohith_das/jobops reseed')} to rebuild from cv.md.`);
    }
  } catch (e: any) {
    console.log(`  ${cross()} migration error: ${e?.message ?? e}`);
    process.exit(1);
  }

  console.log(c.bold('\nNext steps:'));
  console.log(`  1. Edit ${c.bold('cv.md')}, ${c.bold('config/profile.yml')}, and ${c.bold('portals.yml')} — replace every <TODO> placeholder.`);
  console.log(`     ${c.dim('Optional: tune the behavior in modes/*.md (rubric, tailoring rules, outreach tone) — your edits win over the bundled defaults.')}`);
  console.log(`  2. Run ${c.bold('npx @mohith_das/jobops doctor')} to confirm everything is wired.`);
  console.log(`  3. Run ${c.bold('npx @mohith_das/jobops start')} to boot the server.`);
  console.log(`  4. Run ${c.bold('npx @mohith_das/jobops connect')} for Claude Desktop config.\n`);

  if (scaffolded === 0 && kept > 0) {
    console.log(c.dim('(All example files already present; init is idempotent — re-run safe.)'));
  }
  void yes;  // reserved for future non-interactive prompts
}

// ── start ───────────────────────────────────────────────────────────────────

async function cmdStart(flags: Map<string, string | boolean>) {
  // Default project root = cwd, so users who ran `init` get their files picked up.
  if (!process.env.JOBOPS_PROJECT_ROOT) process.env.JOBOPS_PROJECT_ROOT = process.cwd();
  const stdio = !!flags.get('stdio');
  const skipBrowserCheck = !!flags.get('skip-chromium-check');
  // In stdio mode we MUST keep stdout clean — `npx playwright install` writes
  // to stdout and would corrupt the JSON-RPC channel. Force-skip the prompt
  // there and let the user run `doctor` first to confirm Chromium is installed.
  if (!skipBrowserCheck && !stdio) await ensureChromium();
  const { bootServer } = await import('./server.js');
  await bootServer({ stdio });
}

async function ensureChromium(): Promise<void> {
  // Detect a previously-installed Chromium by attempting `playwright.chromium.executablePath()`.
  try {
    const { chromium } = await import('playwright');
    const path = chromium.executablePath();
    if (path && existsSync(path)) return;
  } catch { /* fall through to install */ }
  console.log(c.bold('\n[one-time setup]'));
  console.log('Playwright Chromium not found — downloading now (~150MB, one-time).');
  console.log(c.dim('  $ npx playwright install chromium'));
  const res = spawnSync('npx', ['playwright', 'install', 'chromium'], { stdio: 'inherit' });
  if (res.status !== 0) {
    console.error(c.red('Chromium install failed. Run `npx playwright install chromium` manually and re-try.'));
    process.exit(1);
  }
  console.log(c.green('Chromium ready.\n'));
}

// ── doctor ──────────────────────────────────────────────────────────────────

async function cmdDoctor() {
  console.log(c.bold(`\njobops doctor\n`));
  const { runDoctorChecks } = await import('./core/doctor.js');
  const report = await runDoctorChecks({ context: 'cold' });

  const glyph: Record<string, string> = {
    pass: tick(), warn: warn(), fail: cross(),
    info: COLOR ? c.dim('·') : '- ',
  };
  for (const chk of report.checks) {
    console.log(`  ${glyph[chk.status]} ${chk.detail}`);
    if (chk.fix) console.log(`         ${c.dim(`Fix: ${chk.fix}`)}`);
  }

  console.log('');
  if (!report.ok) { console.log(c.red(report.summary)); process.exit(1); }
  console.log(c.green(report.summary + '\n'));
}

// ── connect ─────────────────────────────────────────────────────────────────

async function cmdConnect(flags: Map<string, string | boolean>) {
  // When JOBOPS_PUBLIC_BASE_URL is set (remote host / Tailscale), use it for every
  // config block so the URL the user pastes actually reaches the server from other
  // devices. Falls back to host:port for local use.
  const port = String(flags.get('port') ?? process.env.JOBOPS_PORT ?? '7891');
  const host = String(flags.get('host') ?? process.env.JOBOPS_HOST ?? '127.0.0.1');
  const { config: cfg } = await import('./config.js');
  const url = cfg.publicBaseUrlIsExplicit ? `${cfg.publicBaseUrl}/mcp` : `http://${host}:${port}/mcp`;
  const token = (typeof flags.get('token') === 'string' ? String(flags.get('token')) : cfg.authToken) || null;
  const authHeaders = token ? { Authorization: `Bearer ${token}` } : undefined;
  const isLocal = !cfg.publicBaseUrlIsExplicit && ['127.0.0.1', 'localhost', '::1'].includes(host);
  // Host-resolvable from inside a Docker container (LibreChat default deploy shape).
  // host.docker.internal works out-of-the-box on Docker Desktop (macOS/Windows) and on
  // Linux when the compose file sets `extra_hosts: ["host.docker.internal:host-gateway"]`.
  const dockerHost = 'host.docker.internal';
  const dockerUrl  = `http://${dockerHost}:${port}/mcp`;

  console.log(c.bold(`\njobops connect — one server, every client\n`));
  console.log(`Recommended topology: ${c.bold('ONE long-running server = ONE source of truth.')}`);
  console.log(`  Start it once:           ${c.bold('npx @mohith_das/jobops start')}   ${c.dim('(HTTP mode — serves many concurrent clients)')}`);
  console.log(`  Every client connects to: ${c.bold(url)}`);
  console.log(c.dim(
    '  Work done in ANY client (materials, tracker, contacts, packet edits) is instantly\n' +
    '  visible in ALL others — switch clients freely (e.g. when one is rate-limited)\n' +
    '  without losing state. Run it locally, or on an always-on host over Tailscale.\n'));

  if (token) {
    console.log(`Auth: ${c.bold('JOBOPS_AUTH_TOKEN is set')} — the configs below include the bearer token.`);
  } else if (isLocal) {
    console.log(`Auth: localhost, no token — fine for same-machine clients.`);
    console.log(c.dim(
      '  Sharing the server beyond localhost (Tailscale / LAN / always-on host)? You MUST set\n' +
      '  JOBOPS_AUTH_TOKEN — the server refuses to boot on a non-localhost bind without it,\n' +
      '  because it serves PII (resume, contacts, H1B data) to every connected endpoint.\n' +
      '  Generate one:  export JOBOPS_AUTH_TOKEN="$(openssl rand -hex 32)"\n' +
      '  then re-run `connect` — every config below will include it.'));
  } else {
    console.log(c.yellow(
      'Auth: non-localhost endpoint with NO token in this shell — the server will not boot\n' +
      'like this. Set JOBOPS_AUTH_TOKEN (export JOBOPS_AUTH_TOKEN="$(openssl rand -hex 32)")\n' +
      'and re-run `connect` so the configs include it.'));
  }

  // ── Claude Code ────────────────────────────────────────────────────────────
  console.log(c.bold('\n── Claude Code ──'));
  const ccHeader = token ? ` --header "Authorization: Bearer ${token}"` : '';
  console.log(`One command:\n  ${c.bold(`claude mcp add --transport http jobops ${url}${ccHeader}`)}`);
  console.log(c.dim('Or per-project .mcp.json (commit-able; --scope project writes this):'));
  console.log(JSON.stringify({
    mcpServers: { 'jobops': { type: 'http', url, ...(authHeaders ? { headers: authHeaders } : {}) } },
  }, null, 2));

  // ── Claude Desktop (shared server) ─────────────────────────────────────────
  console.log(c.bold('\n── Claude Desktop — connect to the SHARED server (mcp-remote bridge) ──'));
  console.log(c.dim('macOS:   ~/Library/Application Support/Claude/claude_desktop_config.json'));
  console.log(c.dim('Windows: %APPDATA%/Claude/claude_desktop_config.json'));
  console.log(c.dim(
    'Claude Desktop config files only launch stdio servers, so bridge stdio→HTTP with\n' +
    'mcp-remote — Desktop talks stdio to the bridge; the bridge talks to the ONE shared server.\n' +
    '(Alternative on paid plans: Settings → Connectors → "Add custom connector" with the URL.)\n'));
  console.log(c.yellow(
    'KNOWN ISSUE: mcp-remote (<= 0.1.38) fails under Node >= 26 with "Unexpected content\n' +
    'type: null" — its bundled undici EnvHttpProxyAgent global dispatcher strips response\n' +
    'headers from Node\'s built-in fetch. The server is NOT at fault. Until fixed upstream,\n' +
    'run the bridge under Node <= 24, e.g. swap "command": "npx" for an absolute path to a\n' +
    'Node 24 binary and point args at a Node-24-installed mcp-remote.\n'));
  console.log(JSON.stringify({
    mcpServers: {
      'jobops': {
        command: 'npx',
        args: ['-y', 'mcp-remote', url, ...(token ? ['--header', `Authorization: Bearer ${token}`] : [])],
      },
    },
  }, null, 2));

  // ── opencode ───────────────────────────────────────────────────────────────
  console.log(c.bold('\n── opencode — opencode.json ──'));
  console.log(JSON.stringify({
    $schema: 'https://opencode.ai/config.json',
    mcp: {
      'jobops': { type: 'remote', url, enabled: true, ...(authHeaders ? { headers: authHeaders } : {}) },
    },
  }, null, 2));

  // ── codex ──────────────────────────────────────────────────────────────────
  console.log(c.bold('\n── codex — ~/.codex/config.toml ──'));
  console.log(c.dim(token
    ? 'codex reads the bearer token from an env var (bearer_token_env_var) — keep JOBOPS_AUTH_TOKEN exported in the shell that launches codex.'
    : 'No token set — add bearer_token_env_var = "JOBOPS_AUTH_TOKEN" when you enable auth.'));
  console.log([
    `[mcp_servers.jobops]`,
    `url = "${url}"`,
    ...(token ? [`bearer_token_env_var = "JOBOPS_AUTH_TOKEN"`] : []),
  ].join('\n'));
  console.log(c.dim('Older codex builds without streamable-HTTP support can bridge instead\n' +
    '(same mcp-remote Node <= 24 caveat as the Claude Desktop section):\n' +
    `  [mcp_servers.jobops]\n  command = "npx"\n  args = ["-y", "mcp-remote", "${url}"${token ? `, "--header", "Authorization: Bearer ${token}"` : ''}]`));

  // ── gemini-cli ─────────────────────────────────────────────────────────────
  console.log(c.bold('\n── gemini-cli — ~/.gemini/settings.json (or .gemini/settings.json per project) ──'));
  console.log(JSON.stringify({
    mcpServers: { 'jobops': { httpUrl: url, ...(authHeaders ? { headers: authHeaders } : {}) } },
  }, null, 2));

  // ── LibreChat ──────────────────────────────────────────────────────────────
  // LibreChat's MCP transport for HTTP endpoints is `type: streamable-http`
  // (NOT `sse` — that's a separate legacy transport). Add to `librechat.yaml`
  // under `mcpServers:`. Docs: librechat.ai/docs/configuration/librechat_yaml/object_structure/mcp_servers
  console.log(c.bold('\n── LibreChat — librechat.yaml (host-process deploy) ──'));
  console.log(c.dim('Add under top-level `mcpServers:` in your librechat.yaml, then restart LibreChat.\n'));
  console.log(yamlBlock({
    mcpServers: {
      'jobops': {
        type:    'streamable-http',
        url,
        timeout: 60000,
        ...(authHeaders ? { headers: authHeaders } : {}),
      },
    },
  }));

  console.log(c.bold('\n── LibreChat in Docker — librechat.yaml + SSRF allowlist ──'));
  console.log(c.dim(
    'Inside a container, 127.0.0.1 points at the CONTAINER, not your host. Swap to ' +
    'host.docker.internal (Docker Desktop) or a LAN IP (Linux + extra_hosts).\n' +
    'LibreChat ALSO blocks private/internal addresses by default — you must allowlist ' +
    'them under `mcpSettings.allowedAddresses`. Both blocks below go into librechat.yaml:\n',
  ));
  console.log(yamlBlock({
    mcpServers: {
      'jobops': {
        type:    'streamable-http',
        url:     dockerUrl,
        timeout: 60000,
        ...(authHeaders ? { headers: authHeaders } : {}),
      },
    },
    mcpSettings: {
      allowedAddresses: [`${dockerHost}:${port}`],
    },
  }));
  console.log(c.dim(
    '\nLinux note: if `host.docker.internal` does not resolve, either add\n' +
    '  extra_hosts:\n' +
    '    - "host.docker.internal:host-gateway"\n' +
    'under the LibreChat service in your docker-compose.yml, or swap the URL for your\n' +
    "host's LAN IP and allowlist that IP:port instead.",
  ));

  // ── Generic ────────────────────────────────────────────────────────────────
  console.log(c.bold('\n── Any other MCP client (streamable-HTTP, stateless) ──'));
  console.log(JSON.stringify({
    name:      'jobops',
    transport: 'streamable-http',
    url,
    ...(authHeaders ? { headers: authHeaders } : {}),
  }, null, 2));

  // ── stdio (single-client alternative) ──────────────────────────────────────
  console.log(c.bold('\n── stdio mode — single-client alternative (NOT shared) ──'));
  console.log(c.dim(
    'This launches a PRIVATE server inside the client instead of connecting to the shared\n' +
    'one. Tradeoffs: (a) state is only shared with other clients if they point at the same\n' +
    'project root / DB file — and even then they are separate processes; (b) a shared HTTP\n' +
    'server already running on the same port causes EADDRINUSE — give a stdio instance its\n' +
    'own JOBOPS_PORT. Prefer the mcp-remote bridge above for shared mode. Claude Desktop\n' +
    'stdio config (claude_desktop_config.json):\n'));
  console.log(JSON.stringify({
    mcpServers: {
      'jobops': {
        command: 'npx',
        args:    ['-y', PKG.name, 'start', '--stdio'],
        env: {
          JOBOPS_PORT: port,
          JOBOPS_HOST: host,
          JOBOPS_PROJECT_ROOT: process.cwd(),
        },
      },
    },
  }, null, 2));

  console.log(c.dim(`\nVerify any client is hitting the shared instance:  npx @mohith_das/jobops status${token ? ' --token <token>' : ''}\n`));
}

// ── status ──────────────────────────────────────────────────────────────────
// Queries a RUNNING server over HTTP — answers "is it up, which DB is the source of
// truth, and which clients have connected?" so a multi-client setup can be verified.

async function cmdStatus(flags: Map<string, string | boolean>) {
  const { config: cfg } = await import('./config.js');
  const flagUrl = flags.get('url');
  const base = (typeof flagUrl === 'string' ? flagUrl : (cfg.publicBaseUrlIsExplicit ? cfg.publicBaseUrl : cfg.listenUrl)).replace(/\/+$/, '');
  const flagToken = flags.get('token');
  const token = (typeof flagToken === 'string' ? flagToken : cfg.authToken) || null;

  console.log(c.bold(`\njobops status — ${base}\n`));

  let health: any;
  try {
    const r = await fetch(`${base}/healthz`);
    health = await r.json();
  } catch (e: any) {
    console.log(`${cross()} No server reachable at ${base} (${e?.cause?.code ?? e?.message ?? e})`);
    console.log(c.dim('   Start the shared server with:  npx @mohith_das/jobops start'));
    console.log(c.dim('   Or point this check elsewhere: npx @mohith_das/jobops status --url http://host:7891\n'));
    process.exit(1);
  }
  console.log(`${tick()} Server reachable (auth: ${health.auth})`);

  const headers: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};
  const r = await fetch(`${base}/api/status`, { headers });
  if (r.status === 401) {
    console.log(`${cross()} /api/status requires the bearer token (server runs with auth enabled).`);
    console.log(c.dim('   Pass it:  npx @mohith_das/jobops status --token <token>   (or export JOBOPS_AUTH_TOKEN)\n'));
    process.exit(1);
  }
  if (!r.ok) {
    console.log(`${cross()} /api/status returned HTTP ${r.status} — is this an older jobops (< 0.13)?\n`);
    process.exit(1);
  }
  const s = await r.json();

  console.log(`${tick()} ${s.package}@${s.version} — pid ${s.pid}, up ${formatUptimeCli(s.uptime_s)}, transport: ${s.transport_mode}`);
  console.log(`${tick()} Source of truth DB: ${c.bold(s.db_path)}  ${c.dim(`[fingerprint ${s.db_fingerprint}]`)}`);
  console.log(c.dim('   Every client connected to this URL reads + writes THIS database — work done in'));
  console.log(c.dim('   one client appears in all. Same fingerprint on two checks = same source of truth.'));
  console.log(`${tick()} Project root: ${s.project_root}`);
  console.log(`${tick()} MCP requests handled since boot: ${s.mcp_requests_total}`);
  if (Array.isArray(s.clients_seen) && s.clients_seen.length) {
    console.log(`${tick()} Clients seen since boot (${s.clients_seen.length}):`);
    for (const cl of s.clients_seen) {
      console.log(`     · ${cl.name}@${cl.version}  ${c.dim(`from ${cl.remote} — last seen ${cl.last_seen}, ${cl.initializes} initialize(s)`)}`);
    }
  } else {
    console.log(`${warn()} No MCP clients have connected since boot.`);
  }
  console.log('');
}

function formatUptimeCli(s: number): string {
  if (s < 90) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 90) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

// ── tiny YAML serializer (object → block-style YAML, two-space indent) ──────
// Just enough for `mcpServers` + `mcpSettings.allowedAddresses` shapes — no deps.
function yamlBlock(o: unknown, indent = 0): string {
  const pad = '  '.repeat(indent);
  if (o === null || o === undefined) return `${pad}~`;
  if (typeof o === 'string')         return /^[\w./:@#$%^&*()+=,?!{}\[\]-]+$/.test(o) ? o : JSON.stringify(o);
  if (typeof o === 'number' || typeof o === 'boolean') return String(o);
  if (Array.isArray(o)) {
    if (o.length === 0) return '[]';
    return o.map(v => `${pad}- ${yamlBlock(v, indent + 1).replace(/^\s+/, '')}`).join('\n');
  }
  if (typeof o === 'object') {
    const entries = Object.entries(o as Record<string, unknown>);
    if (entries.length === 0) return '{}';
    return entries.map(([k, v]) => {
      const isObj = v && typeof v === 'object' && !Array.isArray(v);
      const isArr = Array.isArray(v);
      if (isObj || isArr) {
        const child = yamlBlock(v, indent + 1);
        return `${pad}${k}:\n${child}`;
      }
      return `${pad}${k}: ${yamlBlock(v, indent + 1)}`;
    }).join('\n');
  }
  return JSON.stringify(o);
}

// ── templates ───────────────────────────────────────────────────────────────

async function cmdTemplates() {
  if (!process.env.JOBOPS_PROJECT_ROOT) process.env.JOBOPS_PROJECT_ROOT = process.cwd();
  console.log(c.bold('\njobops templates\n'));
  const { config: cfg } = await import('./config.js');
  const { listThemes, effectiveDefaultTemplate } = await import('./core/templates.js');

  const themes  = listThemes();
  const def     = effectiveDefaultTemplate();
  const userDir = cfg.userTemplateDir;

  console.log(c.dim(`default theme: ${c.bold(def)}  ${process.env.JOBOPS_DEFAULT_TEMPLATE ? '(from JOBOPS_DEFAULT_TEMPLATE)' : '(built-in default)'}`));
  console.log(c.dim(`bundled themes dir: ${cfg.installDir}/templates/themes`));
  console.log(c.dim(`user themes dir:    ${userDir ?? '(unset — set JOBOPS_TEMPLATE_DIR to add custom themes)'}\n`));

  if (themes.length === 0) {
    console.log(c.red('No themes found.'));
    return;
  }

  for (const t of themes) {
    const tag       = t.source === 'user' ? c.bold(c.yellow('[user]')) : c.dim('[bundled]');
    const isDefault = t.name === def ? c.green(' (default)') : '';
    const files     = Object.keys(t.files).sort().join(', ');
    console.log(`  ${tag}  ${c.bold(t.name)}${isDefault}`);
    console.log(`           ${c.dim(t.dir)}`);
    console.log(`           ${c.dim(`files: ${files}`)}\n`);
  }

  if (userDir) {
    // Surface any name collision so the user understands which one wins.
    const userNames    = themes.filter(t => t.source === 'user').map(t => t.name);
    const bundledNames = themes.filter(t => t.source === 'bundled').map(t => t.name);
    const shadows = userNames.filter(n => bundledNames.includes(n));
    if (shadows.length) {
      console.log(c.dim(`Note: user theme(s) ${shadows.join(', ')} would shadow a bundled theme of the same name. Listed once above with [user].\n`));
    }
  }
  console.log(c.dim(`Use a theme: pass template="<name>" to render_pdf, or set JOBOPS_DEFAULT_TEMPLATE.`));
  console.log(c.dim(`Author a new theme: see TEMPLATES.md (placeholder contract).`));
  console.log('');
}

// ── reseed ──────────────────────────────────────────────────────────────────

async function cmdReseed(flags: Map<string, string | boolean>) {
  if (!process.env.JOBOPS_PROJECT_ROOT) process.env.JOBOPS_PROJECT_ROOT = process.cwd();
  console.log(c.bold('\njobops reseed\n'));
  console.log(c.dim('Rebuilds the active career_packet from the current cv.md + config/profile.yml.'));
  console.log(c.dim('Bumps version; the previous active row is demoted (history kept).\n'));

  const { loadProjectFiles, cvHasRealContent, seedCareerPacketFromFiles, packetPreview } = await import('./core/profile.js');
  const { cvMd, profile } = loadProjectFiles();

  if (!profile && !flags.get('force')) {
    console.error(`  ${cross()} config/profile.yml not found. Run ${c.bold('npx @mohith_das/jobops init')} first, or pass --force.`);
    process.exit(1);
  }
  if (!cvHasRealContent(cvMd) && !flags.get('force')) {
    console.error(`  ${warn()} cv.md is missing or looks like the <TODO> example template.`);
    console.error(`  ${c.dim('Fill it in first, then re-run.')}`);
    console.error(`  ${c.dim('Or pass --force to reseed anyway (identity-only — most sections stay as <TODO>).')}`);
    process.exit(1);
  }

  const force = !!flags.get('force');
  const r = await seedCareerPacketFromFiles({ mode: 'reseed', force });
  if (r.blocked) {
    console.error(`  ${warn()} ${c.bold('reseed refused — no changes made.')}`);
    console.error(`  ${r.blocked_reason}`);
    console.error('');
    console.error(`  ${c.dim('→ Re-run with')} ${c.bold('--force')} ${c.dim('to rebuild from cv.md anyway (overwrites chat edits),')}`);
    console.error(`  ${c.dim('  or run the')} ${c.bold('sync_packet_to_cv')} ${c.dim('tool first to write your edits back into cv.md.')}`);
    process.exit(1);
  }
  console.log(`  ${tick()} active career_packet → version ${c.bold(`v${r.version}`)} (${r.bytes} bytes)${force ? c.dim(' [forced]') : ''}`);
  console.log(`  ${tick()} ${r.sections_with_cv_content}/6 sections populated from cv.md (sections 3-8)`);
  console.log('');
  console.log(c.dim('Preview (first ~400 chars):'));
  console.log(c.dim('─'.repeat(64)));
  console.log(packetPreview(r.preview, 600));
  console.log(c.dim('─'.repeat(64)));
  console.log('');
}

// ── compile-packet ──────────────────────────────────────────────────────────

async function cmdCompilePacket(flags: Map<string, string | boolean>) {
  if (!process.env.JOBOPS_PROJECT_ROOT) process.env.JOBOPS_PROJECT_ROOT = process.cwd();
  console.log(c.bold('\njobops compile-packet\n'));
  console.log(c.dim('Compiles cv.md + profile.yml + story_bank into a canonical career-packet.json'));
  console.log(c.dim('(JSON Resume superset with Lightcast Open Skills IDs and evidence claims).\n'));

  const lightcastMode = flags.get('skip-lightcast') ? 'skip' : 'llm';
  if (lightcastMode === 'skip') {
    console.log(c.dim('  Lightcast mapping: skipped (--skip-lightcast flag)\n'));
  } else {
    console.log(c.dim('  Lightcast mapping: enabled (using configured LLM)\n'));
  }

  try {
    const { compileCareerPacketJson } = await import('./core/career_packet_json.js');
    const result = await compileCareerPacketJson({ lightcastMode });

    const skillsCount = result.content.skills.reduce((sum, cat) => sum + cat.items.length, 0);
    const evidenceCount = result.content.evidence.length;
    const workCount = result.content.work.length;
    const projectsCount = result.content.projects.length;

    console.log(`  ${tick()} career_packet_json → version ${c.bold(`v${result.version}`)}`);
    console.log(`  ${tick()} content hash: ${c.dim(result.content_hash.slice(0, 16))}...`);
    console.log(`  ${tick()} Lightcast mapped: ${result.content.meta.lightcast_mapped ? c.green('yes') : c.dim('no')}`);
    console.log(`  ${tick()} file: ${c.bold(result.file_path)}`);
    console.log('');
    console.log(`  Stats:`);
    console.log(`    · ${workCount} work experiences`);
    console.log(`    · ${projectsCount} projects`);
    console.log(`    · ${skillsCount} skills`);
    console.log(`    · ${evidenceCount} evidence claims (from story_bank)`);
    console.log('');
    console.log(c.dim('  Next: run `jobops sync` to push to LivingCV, or use the sync_to_livingcv MCP tool.'));
    console.log('');
  } catch (e: any) {
    console.error(`  ${cross()} Failed to compile career packet: ${e?.message ?? e}`);
    process.exit(1);
  }
}

// ── sync ────────────────────────────────────────────────────────────────────

async function cmdSync(flags: Map<string, string | boolean>) {
  if (!process.env.JOBOPS_PROJECT_ROOT) process.env.JOBOPS_PROJECT_ROOT = process.cwd();
  console.log(c.bold('\njobops sync\n'));
  console.log(c.dim('Syncs the compiled career-packet.json to your LivingCV instance.\n'));

  const force = !!flags.get('force');
  if (force) {
    console.log(c.dim('  Force sync enabled (will sync even if content unchanged).\n'));
  }

  try {
    const { getDb } = await import('./db.js');
    const { syncToLivingCV } = await import('./core/livingcv_client.js');

    // Check for active career_packet_json
    const packetRow = getDb()
      .prepare(`SELECT content FROM career_packet_json WHERE is_active = 1`)
      .get() as any;

    if (!packetRow) {
      console.error(`  ${cross()} No compiled career packet found.`);
      console.error(`  ${c.dim('Run')} ${c.bold('jobops compile-packet')} ${c.dim('first to compile cv.md + profile.yml + story_bank.')}`);
      process.exit(1);
    }

    const packet = JSON.parse(packetRow.content);
    console.log(c.dim(`  Compiling sync for packet v${packet.meta.version}...`));

    const result = await syncToLivingCV(packet, force);

    if (result.ok) {
      console.log(`  ${tick()} ${c.green('Synced to LivingCV')}`);
      console.log(`  ${tick()} URL: ${c.bold(result.livingcv_url)}`);
      console.log(`  ${tick()} Packet version: ${c.bold(`v${result.packet_version}`)}`);
      console.log(`  ${tick()} Content hash: ${c.dim(result.content_hash.slice(0, 16))}...`);
      console.log('');
      console.log(c.dim('  Next: run `jobops broadcast` to push signal to HireBridge (after connecting).'));
      console.log('');
    } else {
      console.error(`  ${cross()} ${c.red('Sync failed')}`);
      console.error(`  ${c.dim('Error:')} ${result.error}`);
      if (result.fix) {
        console.error(`  ${c.dim('Fix:')} ${result.fix}`);
      }
      process.exit(1);
    }
  } catch (e: any) {
    console.error(`  ${cross()} Failed to sync: ${e?.message ?? e}`);
    process.exit(1);
  }
}

// ── connect_to_hirebridge ───────────────────────────────────────────────────

async function cmdConnectToHireBridge(flags: Map<string, string | boolean>) {
  if (!process.env.JOBOPS_PROJECT_ROOT) process.env.JOBOPS_PROJECT_ROOT = process.cwd();
  console.log(c.bold('\njobops connect_to_hirebridge\n'));
  console.log(c.dim('Authenticate with HireBridge via magic link.\n'));

  try {
    const { initiateDeviceAuth, requestEmailMagicLink, pollForToken, persistConnection, loadOrCreateIdentity } = await import('./core/hirebridge_client.js');
    const { createInterface } = await import('node:readline/promises');
    const { stdin, stdout } = await import('node:process');

    // Get email from flag or prompt
    let email = typeof flags.get('email') === 'string' ? String(flags.get('email')) : '';
    if (!email) {
      const rl = createInterface({ input: stdin, output: stdout });
      email = await rl.question('Enter your email: ');
      rl.close();
    }

    if (!email || !email.includes('@')) {
      console.error(`  ${cross()} Invalid email address.`);
      process.exit(1);
    }

    console.log(`\n  ${c.dim('Generating ed25519 identity for this node...')}`);
    const identity = loadOrCreateIdentity();
    console.log(`  ${c.dim('Public key:')} ${c.dim(identity.public_key.slice(0, 16))}... (64-char hex, sent to HireBridge)`);

    console.log(`\n  ${c.dim('Requesting device code from HireBridge...')}`);

    // Initiate device auth — sends {node_type, endpoint_url, public_key}
    const deviceAuth = await initiateDeviceAuth();

    console.log(`  ${tick()} Device code issued (expires in ${deviceAuth.expires_in}s)`);
    console.log(`  ${c.dim('User code:')} ${c.bold(deviceAuth.user_code)}`);
    console.log(`  ${c.dim('Verification page:')} ${c.bold(deviceAuth.verification_uri)}`);

    // Ask HireBridge to email the magic link. We also print the complete URI
    // as a fallback so users without email access can still approve.
    try {
      await requestEmailMagicLink(email, deviceAuth.user_code);
      console.log(`  ${tick()} ${c.green('Magic link emailed to')} ${c.bold(email)}`);
    } catch (e: any) {
      console.log(`  ${warn()} ${c.yellow('Could not email magic link')} — ${e?.message ?? e}`);
      console.log(`  ${c.dim('Use the verification URL below instead (open it in any browser):')}`);
    }
    if (deviceAuth.verification_uri_complete) {
      console.log(`  ${c.dim('Direct approval URL:')} ${c.bold(deviceAuth.verification_uri_complete)}`);
    }

    console.log(`\n  ${c.dim('Waiting for approval...')} ${c.dim(`(polling every ${deviceAuth.interval}s)`)}\n`);

    // Poll for token — handles RFC 8628 400-body codes (authorization_pending / slow_down / ...).
    const tokenResponse = await pollForToken(
      deviceAuth.device_code,
      deviceAuth.interval,
      deviceAuth.expires_in,
    );

    // Persist token + email + node_id to .env + federation_state.
    persistConnection(tokenResponse.access_token, email, tokenResponse.node_id, process.env.JOBOPS_PROJECT_ROOT!);

    console.log(`  ${tick()} ${c.green('Connected to HireBridge as')} ${c.bold(email)}`);
    console.log(`  ${tick()} Token saved to .env (JOBOPS_HIREBRIDGE_TOKEN)`);
    if (tokenResponse.node_id) {
      console.log(`  ${tick()} Node id: ${c.dim(tokenResponse.node_id)}`);
    }
    console.log('');
    console.log(c.dim('  Next: run `jobops broadcast` to push signal to HireBridge.'));
    console.log('');
  } catch (e: any) {
    console.error(`  ${cross()} ${c.red('Authentication failed')}`);
    console.error(`  ${c.dim('Error:')} ${e?.message ?? e}`);
    process.exit(1);
  }
}

// ── broadcast ───────────────────────────────────────────────────────────────

async function cmdBroadcast(flags: Map<string, string | boolean>) {
  if (!process.env.JOBOPS_PROJECT_ROOT) process.env.JOBOPS_PROJECT_ROOT = process.cwd();
  console.log(c.bold('\njobops broadcast\n'));
  console.log(c.dim('Broadcasts a signed signal snapshot (embeddings + capabilities) to HireBridge.\n'));

  try {
    const { broadcastSignal } = await import('./core/signal_broadcast.js');

    console.log(c.dim('  Compiling signal snapshot...'));

    const result = await broadcastSignal();

    if (result.ok) {
      console.log(`  ${tick()} ${c.green('Signal broadcast to HireBridge')}`);
      console.log(`  ${tick()} Snapshot hash: ${c.dim(result.snapshot_hash.slice(0, 16))}...`);
      console.log('');
      console.log(c.dim('  Your signal is now visible to the HireBridge router for opportunity matching.'));
      console.log('');
    } else {
      console.error(`  ${cross()} ${c.red('Broadcast failed')}`);
      console.error(`  ${c.dim('Error:')} ${result.error}`);
      if (result.fix) {
        console.error(`  ${c.dim('Fix:')} ${result.fix}`);
      }
      process.exit(1);
    }
  } catch (e: any) {
    console.error(`  ${cross()} Failed to broadcast: ${e?.message ?? e}`);
    process.exit(1);
  }
}

// ── update ──────────────────────────────────────────────────────────────────

async function cmdUpdate(flags: Map<string, string | boolean>) {
  console.log(c.bold('\njobops update\n'));
  console.log(c.dim('Checking npm registry for updates...\n'));

  try {
    const { checkForUpdate } = await import('./core/updater.js');
    const result = await checkForUpdate();

    if (result.updateAvailable) {
      console.log(`  ${warn()} ${c.yellow('Update available')}`);
      console.log(`  ${c.dim('Current:')} v${result.current}`);
      console.log(`  ${c.dim('Latest:')}  v${result.latest}`);
      console.log('');
      console.log(`  ${c.bold('Run:')} ${c.green(result.updateCommand)}`);
      if (result.releaseNotes) {
        console.log('');
        console.log(c.dim('  Release notes:'));
        console.log(c.dim(result.releaseNotes.slice(0, 500)));
      }
      console.log('');
    } else {
      console.log(`  ${tick()} ${c.green('jobops is up to date')} (v${result.current})`);
      console.log('');
    }
  } catch (e: any) {
    console.error(`  ${cross()} Failed to check for updates: ${e?.message ?? e}`);
    process.exit(1);
  }
}

// ── help ────────────────────────────────────────────────────────────────────

function cmdHelp() {
  console.log(`
${c.bold('jobops')} — self-hosted MCP server for an end-to-end job search pipeline.

USAGE
  npx @mohith_das/jobops <command> [flags]

COMMANDS
  init              Scaffold cv.md / config/profile.yml / portals.yml from examples
                    and run SQLite migrations. Idempotent.
  start             Boot the MCP + HTTP server. Auto-installs Chromium on first run.
  start --stdio     Same server, but MCP rides stdin/stdout (for Claude Desktop).
                    HTTP file server still runs on the port so /files/* links work.
  reseed            Rebuild the active career_packet from the current cv.md +
                    config/profile.yml. Run this after editing cv.md.
  compile-packet    Compile cv.md + profile.yml + story_bank into a canonical
                    career-packet.json (JSON Resume superset with Lightcast IDs).
                    Flags: --skip-lightcast (skip skill ID mapping).
  sync              Sync the compiled career-packet.json to your LivingCV instance.
                    Flags: --force (sync even if content unchanged).
  connect_to_hirebridge
                    Authenticate with HireBridge via magic link. Prompts for email,
                    sends magic link, waits for approval, saves token to .env.
  broadcast         Broadcast signal snapshot (embeddings + capabilities) to HireBridge.
                    Requires: compile-packet, generate_embeddings, connect_to_hirebridge.
  update            Check npm registry for jobops updates. Reports the update command
                    if a newer version is available. Does NOT auto-update.
  templates         List available resume/cover themes (bundled + user dir).
  doctor            Diagnose Node version, Chromium, config files, LLM key.
  connect           Print copy-paste config for EVERY client (Claude Desktop, Claude
                    Code, opencode, codex, gemini-cli, LibreChat) pointing at the ONE
                    shared HTTP server. Flags: --host --port --token.
  status            Check a RUNNING server: uptime, source-of-truth DB + fingerprint,
                    clients seen. Flags: --url --token. Verifies all clients share
                    one instance.
  help              Show this message.

ENV
  JOBOPS_PORT                 default 7891
  JOBOPS_HOST                 default 127.0.0.1
  JOBOPS_PROJECT_ROOT         where cv.md / config/profile.yml / portals.yml live
                               default: current working dir
  JOBOPS_DATA_DIR             SQLite location; default <install>/data
  JOBOPS_VISA_SCORING         true | false (default true) — disables visa surface entirely
  JOBOPS_TEMPLATE_DIR         user-owned dir holding additional themes (overrides bundled)
  JOBOPS_DEFAULT_TEMPLATE     theme name when render_pdf has no template arg (default "default")
  JOBOPS_LLM_PROVIDER         gemini | deepseek | none  (api/batch tools only)
  GEMINI_API_KEY / DEEPSEEK_API_KEY

LEARN MORE
  README: ${PKG.homepage || 'https://github.com/<you>/jobops'}
`);
}

// ── main ────────────────────────────────────────────────────────────────────

async function main() {
  // Load .env from project root BEFORE any env-var reading. Shell exports win over
  // .env file values (loadDotEnvIntoProcessEnv only sets keys not already in process.env).
  // This must run before legacy aliasing so .env values take precedence over MCP_JSA_* vars.
  const { loadDotEnvIntoProcessEnv } = await import('./core/env_loader.js');
  const earlyProjectRoot = process.env.JOBOPS_PROJECT_ROOT || process.cwd();
  loadDotEnvIntoProcessEnv(earlyProjectRoot);

  // Map legacy MCP_JSA_* env vars onto JOBOPS_* before any subcommand reads them.
  // (config.ts does this too, but several subcommands read process.env directly
  // without importing config — so do it here at the entry point as well.)
  const { applyLegacyEnvAliases } = await import('./core/legacy_env.js');
  applyLegacyEnvAliases();

  const { cmd, flags } = parseArgs(process.argv);
  try {
    switch (cmd) {
      case 'init':    await cmdInit(flags);    break;
      case 'start':   await cmdStart(flags);   break;
      case 'doctor':  await cmdDoctor();       break;
      case 'connect': await cmdConnect(flags); break;
      case 'status':  await cmdStatus(flags);  break;
      case 'reseed':    await cmdReseed(flags);   break;
      case 'compile-packet': await cmdCompilePacket(flags); break;
      case 'sync':    await cmdSync(flags);       break;
      case 'connect_to_hirebridge': await cmdConnectToHireBridge(flags); break;
      case 'broadcast': await cmdBroadcast(flags); break;
      case 'update':  await cmdUpdate(flags);     break;
      case 'templates': await cmdTemplates();     break;
      case '--version': case '-v': case 'version': console.log(PKG.version); break;
      case 'help':    case '--help': case '-h': default: cmdHelp(); break;
    }
  } catch (e: any) {
    console.error(c.red(`\n[fatal] ${e?.message ?? e}`));
    process.exit(1);
  }
  // Suppress unused-import warning for spawn (reserved for future).
  void spawn; void createInterface; void input; void output;
}

main();
