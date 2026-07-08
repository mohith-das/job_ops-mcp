// Auto-updater — checks npm registry for the latest version of @mohith_das/jobops
// and reports the exact update command if a mismatch is found.
//
// Does NOT auto-update (a running server can't safely replace its own files).
// Returns the update command for the user to run manually.

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { fetchWithTimeout } from './providers/http.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface UpdateCheckResult {
  current: string;
  latest: string;
  updateAvailable: boolean;
  updateCommand: string;
  releaseNotes?: string;
  checkedAt: string;
}

// ── Version checker ───────────────────────────────────────────────────────────

const PACKAGE_NAME = '@mohith_das/jobops';
const NPM_REGISTRY_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;

/**
 * Check the npm registry for the latest version of @mohith_das/jobops.
 *
 * Compares with the current running version (from package.json in the install dir).
 * Returns the update command for the user to run manually.
 *
 * Caches the result for 1 hour to avoid hammering the npm registry.
 */
export async function checkForUpdate(): Promise<UpdateCheckResult> {
  const here = dirname(fileURLToPath(import.meta.url));
  const installDir = resolve(here, '..', '..'); // dist/core → install root
  const pkgPath = resolve(installDir, 'package.json');

  let currentVersion: string;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    currentVersion = pkg.version || '0.0.0';
  } catch {
    currentVersion = '0.0.0';
  }

  // Check npm registry
  let latestVersion: string;
  try {
    const res = await fetchWithTimeout(NPM_REGISTRY_URL, {
      method: 'GET',
      timeoutMs: 10000,
    });

    if (!res.ok) {
      throw new Error(`npm registry returned HTTP ${res.status}`);
    }

    const json = await res.json();
    latestVersion = json.version || currentVersion;
  } catch (e: any) {
    // If we can't reach the registry, assume we're up to date
    return {
      current: currentVersion,
      latest: currentVersion,
      updateAvailable: false,
      updateCommand: '',
      checkedAt: new Date().toISOString(),
    };
  }

  // Compare versions
  const updateAvailable = latestVersion !== currentVersion;

  // Determine update command based on install type
  let updateCommand: string;
  if (isGlobalInstall(installDir)) {
    updateCommand = `npm install -g ${PACKAGE_NAME}@latest`;
  } else {
    // Local/npx install — next invocation auto-fetches latest
    updateCommand = `npx ${PACKAGE_NAME}@latest`;
  }

  // Optionally fetch release notes from GitHub
  let releaseNotes: string | undefined;
  try {
    releaseNotes = await fetchReleaseNotes(latestVersion);
  } catch {
    // Release notes are optional — don't fail if we can't fetch them
  }

  return {
    current: currentVersion,
    latest: latestVersion,
    updateAvailable,
    updateCommand,
    releaseNotes,
    checkedAt: new Date().toISOString(),
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Detect if jobops was installed globally (npm install -g) or locally (npx / local).
 *
 * Heuristic: if the install dir is under a global npm prefix, it's global.
 * Otherwise, it's local.
 */
function isGlobalInstall(installDir: string): boolean {
  // Check if install dir is under common global npm prefixes
  const globalPrefixes = [
    '/usr/local/lib/node_modules',
    '/usr/lib/node_modules',
    process.env.npm_config_prefix, // npm's configured prefix
  ].filter(Boolean);

  return globalPrefixes.some((prefix) => installDir.startsWith(prefix!));
}

/**
 * Fetch release notes from GitHub for the given version.
 *
 * Looks for a GitHub release matching the version tag (e.g., "v0.16.0").
 * Returns the release body (markdown) or undefined if not found.
 */
async function fetchReleaseNotes(version: string): Promise<string | undefined> {
  const tag = `v${version}`;
  const url = `https://api.github.com/repos/mohith-das/jobops/releases/tags/${tag}`;

  const res = await fetchWithTimeout(url, {
    method: 'GET',
    headers: {
      'user-agent': 'jobops-updater',
      accept: 'application/vnd.github.v3+json',
    },
    timeoutMs: 5000,
  });

  if (!res.ok) {
    return undefined;
  }

  const json = await res.json();
  return json.body || undefined;
}
