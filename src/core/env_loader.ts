// Minimal .env loader for jobops.
//
// Reads <projectRoot>/.env (if it exists), parses KEY=VALUE lines, and sets
// process.env[key] ONLY IF the key is not already set. Shell exports win over
// .env file values — same precedence rule as legacy_env.ts.
//
// This is NOT a full dotenv replacement — it's just enough to load tokens that
// the user wrote to .env (e.g. by running `jobops connect_to_hirebridge`).
// Comments (#) and blank lines are skipped. Handles KEY="value with spaces".

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Load .env from the given project root into process.env.
 * Only sets keys that are NOT already in process.env (shell exports win).
 * Returns the list of keys that were actually set (for logging/testing).
 */
export function loadDotEnvIntoProcessEnv(projectRoot: string): string[] {
  const envPath = resolve(projectRoot, '.env');
  if (!existsSync(envPath)) return [];

  const content = readFileSync(envPath, 'utf-8');
  const lines = content.split('\n');
  const set: string[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    // Skip empty lines and comments
    if (!line || line.startsWith('#')) continue;

    // Parse KEY=VALUE (with optional quotes around value)
    const eqIdx = line.indexOf('=');
    if (eqIdx === -1) continue;

    const key = line.slice(0, eqIdx).trim();
    let value = line.slice(eqIdx + 1).trim();

    // Strip surrounding quotes (double or single)
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    // Only set if not already in process.env (shell exports win)
    if (key && !(key in process.env)) {
      process.env[key] = value;
      set.push(key);
    }
  }

  return set;
}
