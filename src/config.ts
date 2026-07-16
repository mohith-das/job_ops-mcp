// Centralized config — every other module imports from here so env-var changes are obvious.
import { existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveAuthPolicy, type AuthPolicy } from './core/auth.js';
import { applyLegacyEnvAliases } from './core/legacy_env.js';
import { loadDotEnvIntoProcessEnv } from './core/env_loader.js';

// Load .env from project root BEFORE any env-var reading. Shell exports win over
// .env file values (loadDotEnvIntoProcessEnv only sets keys not already in process.env).
// This must run before legacy aliasing so .env values take precedence over MCP_JSA_* vars.
const _earlyProjectRoot = process.env.JOBOPS_PROJECT_ROOT
  ? (isAbsolute(process.env.JOBOPS_PROJECT_ROOT)
      ? process.env.JOBOPS_PROJECT_ROOT
      : resolve(process.cwd(), process.env.JOBOPS_PROJECT_ROOT))
  : process.cwd();
loadDotEnvIntoProcessEnv(_earlyProjectRoot);

// Map any still-set legacy MCP_JSA_* env vars onto their JOBOPS_* names BEFORE any
// read below. Keeps pre-rename configs working (with a deprecation warning).
applyLegacyEnvAliases();

const here = dirname(fileURLToPath(import.meta.url));
const INSTALL_DIR = resolve(here, '..'); // dist/ → install root

function abs(p: string, base: string): string {
  return isAbsolute(p) ? p : resolve(base, p);
}

function envNum(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function envBool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (!v) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

export interface AppConfig {
  installDir:   string;
  projectRoot:  string;   // where cv.md, config/profile.yml, portals.yml live
  dataDir:      string;
  outputDir:    string;
  /**
   * Where behavior-shaping mode files are READ from by default. Mirrors
   * `bundledModesDir` for back-compat — most callers should go through the
   * loader in `core/modes.ts`, which checks `userModesDir` (project root)
   * first and falls back here. Kept so any caller that imported `modesDir`
   * keeps resolving to the bundled defaults.
   */
  modesDir:     string;
  /** Bundled (read-only) mode files shipped inside the package install. */
  bundledModesDir: string;
  /**
   * User-editable mode files under `<projectRoot>/modes/`. `init` scaffolds the
   * bundled defaults into here; the loader prefers a file here over the bundled
   * one. The directory may not exist (older project roots) — callers must guard.
   */
  userModesDir: string;
  templatesDir: string;
  fontsDir:     string;
  dbPath:       string;
  port:         number;
  host:         string;
  /**
   * Where this process actually binds. ALWAYS http://${host}:${port}. Used by the
   * boot banner and `app.listen()`. NOT used to construct artifact links — that's
   * `publicBaseUrl`.
   */
  listenUrl:    string;
  /**
   * The URL emitted in every artifact link (resume / cover / report / tracker /
   * apply_prefill screenshot). Defaults to `listenUrl` when JOBOPS_PUBLIC_BASE_URL
   * is unset, so behaviour is unchanged for local-only users. When set, every link
   * uses the provided URL instead of 127.0.0.1 — fixes the case where the server
   * runs on a remote host (e.g. over Tailscale) and links need to be reachable
   * from other devices.
   */
  publicBaseUrl: string;
  /** True when JOBOPS_PUBLIC_BASE_URL was explicitly set + parsed OK. */
  publicBaseUrlIsExplicit: boolean;
  /**
   * Legacy alias kept so any caller that imported `config.baseUrl` keeps working.
   * Mirrors `publicBaseUrl`. New code should use the link helpers in
   * `core/links.ts` (`fileUrl`, `trackerUrl`) rather than reading this directly.
   */
  baseUrl:      string;
  schedulerEnabled: boolean;
  llmProvider:  string;
  llmModel:     string | null;
  /**
   * When true (default), evaluators score visa_fit and the formula is
   *   round(0.5 * resume + 0.3 * taste + 0.2 * visa).
   * When false, visa_fit is dropped from the rubric, weights renormalize to
   *   round(0.6 * resume + 0.4 * taste), the visa_* tools are hidden from
   *   tools/list, and visa columns are stripped from tool responses.
   * Useful for users who don't need visa signal (US citizens / non-US users / etc.).
   */
  visaScoringEnabled: boolean;
  /**
   * Optional user-owned directory holding additional theme dirs (one per theme,
   * matching the structure of `<install>/templates/themes/`). The loader
   * searches here FIRST, so a `default/` subdirectory in here overrides the
   * bundled default. Themes that only exist here are also available. When
   * unset, only bundled themes are visible.
   */
  userTemplateDir: string | null;
  /**
   * Name of the theme used when render_pdf is called without an explicit
   * `template` argument. Defaults to "default". If the configured value is
   * missing on disk the renderer falls back to "default" with a stderr warning.
   */
  defaultTemplate: string;
  /**
   * Operator-provided bearer token (JOBOPS_AUTH_TOKEN). Required to expose the
   * server beyond localhost — see `authPolicy`. Null when unset.
   */
  authToken: string | null;
  /**
   * Resolved auth posture for the current bind host + token. When `mode === 'deny'`
   * the server refuses to boot (default-deny for remote PII exposure).
   */
  authPolicy: AuthPolicy;
  /**
   * When true (default), api-path scoring (batch_evaluate, evaluate_job api mode)
   * prefers MCP sampling — asking the connected client's model for completions, so
   * no separate Gemini/DeepSeek key is needed. Falls back to the BYO-key provider
   * when the client doesn't advertise sampling. Set JOBOPS_SAMPLING=false to force
   * the BYO-key path even when sampling is available.
   */
   samplingEnabled: boolean;
  /**
   * LivingCV Master Relay base URL for career packet sync.
   * Default: http://127.0.0.1:7890 (local LivingCV instance).
   */
  livingcvBaseUrl: string;
  /**
   * Bearer token for LivingCV Master Relay authentication.
   * Null when unset — sync_to_livingcv will error with instructions to set it.
   */
  livingcvToken: string | null;
  /**
   * HireBridge central router base URL for signal broadcast.
   * Default: https://api.hirebridge.io
   */
  hirebridgeBaseUrl: string;
  /**
   * Bearer token for HireBridge authentication (set by connect_to_hirebridge).
   * Null when unset — broadcast_signal will error with instructions to connect.
   */
  hirebridgeToken: string | null;
  /**
   * Email associated with the HireBridge connection.
   * Set by connect_to_hirebridge alongside the token.
   */
  hirebridgeEmail: string | null;
  /**
   * Embedding provider for edge vector generation.
   * Options: 'local' (all-MiniLM-L6-v2 via @xenova/transformers), 'openai', 'voyage', 'none'.
   * Default: 'local'
   */
  embeddingProvider: string;
  /**
   * Embedding model name. Default: 'all-MiniLM-L6-v2' for local provider.
   */
  embeddingModel: string;
  githubUsername: string | null;
  githubToken: string | null;
  githubIncludeForks: boolean;
  githubIncludeArchived: boolean;
  githubAutoSyncCv: boolean;
  githubAutoSyncLivingcv: boolean;
}

export function loadConfig(): AppConfig {
  const installDir  = INSTALL_DIR;
  // Project root defaults to CWD, NOT installDir — for npx users this means cv.md,
  // profile.yml, portals.yml, the SQLite DB, and output/ all live next to each other
  // in the user's working directory. installDir stays read-only.
  const projectRoot = process.env.JOBOPS_PROJECT_ROOT
    ? abs(process.env.JOBOPS_PROJECT_ROOT, process.cwd())
    : process.cwd();
  const dataDir   = abs(process.env.JOBOPS_DATA_DIR   || './data',   projectRoot);
  const outputDir = abs(process.env.JOBOPS_OUTPUT_DIR || './output', projectRoot);
  // templates/fonts ship with the package — always read from installDir.
  // modes also ship bundled, but `init` scaffolds an editable copy into
  // <projectRoot>/modes/ and the loader prefers that copy (see core/modes.ts).
  const bundledModesDir = resolve(installDir, 'modes');
  const userModesDir    = resolve(projectRoot, 'modes');
  const modesDir     = bundledModesDir;   // back-compat alias → bundled defaults
  const templatesDir = resolve(installDir, 'templates');
  const fontsDir     = resolve(installDir, 'fonts');
  // Default DB is jobops.db. Back-compat: if it's absent but the pre-rename
  // mcp-jsa.db still exists in the data dir, keep using the legacy file (no silent
  // empty DB). The user can rename it to jobops.db at their convenience.
  const legacyDbPath = resolve(dataDir, 'mcp-jsa.db');
  let dbPath = resolve(dataDir, 'jobops.db');
  if (!existsSync(dbPath) && existsSync(legacyDbPath)) {
    dbPath = legacyDbPath;
    // eslint-disable-next-line no-console
    console.error('[db] DEPRECATED: using legacy database file mcp-jsa.db. Rename it (and its -wal/-shm sidecars) to jobops.db at your convenience; the server will keep using the legacy file until you do.');
  }

  for (const dir of [dataDir, outputDir]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  const host = process.env.JOBOPS_HOST || '127.0.0.1';
  const port = envNum('JOBOPS_PORT', 7891);
  const listenUrl = `http://${host}:${port}`;
  const { publicBaseUrl, publicBaseUrlIsExplicit } = resolvePublicBaseUrl(listenUrl);

  const authToken  = (process.env.JOBOPS_AUTH_TOKEN ?? '').trim() || null;
  const authPolicy = resolveAuthPolicy({ host, token: authToken });

  return {
    installDir,
    projectRoot,
    dataDir,
    outputDir,
    modesDir,
    bundledModesDir,
    userModesDir,
    templatesDir,
    fontsDir,
    dbPath,
    port,
    host,
    listenUrl,
    publicBaseUrl,
    publicBaseUrlIsExplicit,
    baseUrl: publicBaseUrl,   // back-compat alias
    schedulerEnabled:   envBool('JOBOPS_SCHEDULER_ENABLED', false),
    llmProvider:        process.env.JOBOPS_LLM_PROVIDER || 'none',
    llmModel:           process.env.JOBOPS_LLM_MODEL || null,
    visaScoringEnabled: envBool('JOBOPS_VISA_SCORING', true),
    userTemplateDir:    process.env.JOBOPS_TEMPLATE_DIR
                          ? abs(process.env.JOBOPS_TEMPLATE_DIR, process.cwd())
                          : null,
    defaultTemplate:    (process.env.JOBOPS_DEFAULT_TEMPLATE || 'default').trim() || 'default',
    authToken,
    authPolicy,
    samplingEnabled:    envBool('JOBOPS_SAMPLING', true),
    livingcvBaseUrl:    (process.env.JOBOPS_LIVINGCV_URL || 'http://127.0.0.1:7890').trim(),
    livingcvToken:      (process.env.JOBOPS_LIVINGCV_TOKEN ?? '').trim() || null,
    hirebridgeBaseUrl:  (process.env.JOBOPS_HIREBRIDGE_URL || 'https://api.hirebridge.io').trim(),
    hirebridgeToken:    (process.env.JOBOPS_HIREBRIDGE_TOKEN ?? '').trim() || null,
    hirebridgeEmail:    (process.env.JOBOPS_HIREBRIDGE_EMAIL ?? '').trim() || null,
    embeddingProvider:  (process.env.JOBOPS_EMBEDDING_PROVIDER || 'local').trim(),
    embeddingModel:     (process.env.JOBOPS_EMBEDDING_MODEL || 'all-MiniLM-L6-v2').trim(),
    githubUsername:      (process.env.JOBOPS_GITHUB_USERNAME ?? '').trim() || null,
    githubToken:         (process.env.JOBOPS_GITHUB_TOKEN ?? '').trim() || null,
    githubIncludeForks:  envBool('JOBOPS_GITHUB_INCLUDE_FORKS', true),
    githubIncludeArchived: envBool('JOBOPS_GITHUB_INCLUDE_ARCHIVED', false),
    githubAutoSyncCv:    envBool('JOBOPS_GITHUB_AUTO_SYNC_CV', true),
    githubAutoSyncLivingcv: envBool('JOBOPS_GITHUB_AUTO_SYNC_LIVINGCV', true),
  };
}

/**
 * Validate + normalize JOBOPS_PUBLIC_BASE_URL. Falls back to listenUrl on any
 * malformed input (with a stderr warning). Strips trailing slashes.
 *
 * Exported so the unit tests can hit it without booting the server.
 */
export function resolvePublicBaseUrl(listenUrl: string): { publicBaseUrl: string; publicBaseUrlIsExplicit: boolean } {
  const raw = process.env.JOBOPS_PUBLIC_BASE_URL?.trim();
  if (!raw) return { publicBaseUrl: listenUrl, publicBaseUrlIsExplicit: false };
  let parsed: URL;
  try { parsed = new URL(raw); }
  catch {
    // eslint-disable-next-line no-console
    console.error(`[config] WARN: JOBOPS_PUBLIC_BASE_URL "${raw}" is not a well-formed URL — falling back to ${listenUrl}. Set it to e.g. "http://my-host:7891" or "https://jobs.example.ts.net".`);
    return { publicBaseUrl: listenUrl, publicBaseUrlIsExplicit: false };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    // eslint-disable-next-line no-console
    console.error(`[config] WARN: JOBOPS_PUBLIC_BASE_URL "${raw}" uses protocol "${parsed.protocol}" — only http: and https: are supported. Falling back to ${listenUrl}.`);
    return { publicBaseUrl: listenUrl, publicBaseUrlIsExplicit: false };
  }
  // Reconstruct origin + optional pathname, stripping trailing slash. Drop any
  // query/hash since the server emits paths under /files/ etc.
  const pathname = parsed.pathname.replace(/\/+$/, '');
  const cleaned  = `${parsed.protocol}//${parsed.host}${pathname}`;
  return { publicBaseUrl: cleaned, publicBaseUrlIsExplicit: true };
}

export const config = loadConfig();
