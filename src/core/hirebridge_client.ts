// HireBridge client — Device Authorization / Magic Link flow.
//
// Implements the client side of HireBridge's device auth flow:
//   1. POST /auth/device with email → get device_code + verification_uri
//   2. User clicks magic link in email
//   3. Poll POST /auth/token with device_code until approved
//   4. Save access_token to .env as JOBOPS_HIREBRIDGE_TOKEN
//
// Also provides broadcastSignal() for Feature 5 (signal broadcast).

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { getDb, runInWriteLock } from '../db.js';
import { fetchWithTimeout } from './providers/http.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DeviceAuthResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

export interface TokenResponse {
  access_token: string;
  email: string;
  expires_in: number;
}

export interface BroadcastResult {
  ok: boolean;
  snapshot_hash: string;
  response?: any;
  error?: string;
  fix?: string;
}

// ── Device Auth Flow ──────────────────────────────────────────────────────────

/**
 * Initiate device authorization flow.
 * POST /auth/device with email → returns device_code + verification_uri.
 */
export async function initiateDeviceAuth(
  email: string,
  baseUrl?: string,
): Promise<DeviceAuthResponse> {
  const hirebridgeUrl = baseUrl || (process.env.JOBOPS_HIREBRIDGE_URL || 'https://api.hirebridge.io').trim();

  const res = await fetchWithTimeout(`${hirebridgeUrl}/auth/device`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
    timeoutMs: 15000,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HireBridge /auth/device failed: HTTP ${res.status} ${text.slice(0, 200)}`);
  }

  const json = await res.json();
  if (!json.device_code || !json.verification_uri) {
    throw new Error(`HireBridge /auth/device returned malformed response: ${JSON.stringify(json).slice(0, 200)}`);
  }

  return {
    device_code: json.device_code,
    user_code: json.user_code,
    verification_uri: json.verification_uri,
    expires_in: json.expires_in ?? 600,
    interval: json.interval ?? 5,
  };
}

/**
 * Poll for token after user clicks magic link.
 * POST /auth/token with device_code → returns access_token when approved.
 *
 * Polls every `interval` seconds until approved, expired, or denied.
 */
export async function pollForToken(
  deviceCode: string,
  interval: number,
  expiresIn: number,
  baseUrl?: string,
): Promise<TokenResponse> {
  const hirebridgeUrl = baseUrl || (process.env.JOBOPS_HIREBRIDGE_URL || 'https://api.hirebridge.io').trim();
  const deadline = Date.now() + expiresIn * 1000;
  let pollInterval = interval * 1000;

  while (Date.now() < deadline) {
    await sleep(pollInterval);

    const res = await fetchWithTimeout(`${hirebridgeUrl}/auth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        device_code: deviceCode,
        grant_type: 'device_code',
      }),
      timeoutMs: 15000,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`HireBridge /auth/token failed: HTTP ${res.status} ${text.slice(0, 200)}`);
    }

    const json = await res.json();

    // Check for error responses
    if (json.error) {
      switch (json.error) {
        case 'authorization_pending':
          // Keep polling
          continue;
        case 'slow_down':
          // Double the poll interval
          pollInterval *= 2;
          continue;
        case 'expired_token':
          throw new Error('Magic link expired. Run connect_to_hirebridge again.');
        case 'access_denied':
          throw new Error('Access denied. The magic link was rejected or revoked.');
        default:
          throw new Error(`HireBridge auth error: ${json.error}`);
      }
    }

    // Success
    if (!json.access_token) {
      throw new Error(`HireBridge /auth/token returned malformed response: ${JSON.stringify(json).slice(0, 200)}`);
    }

    return {
      access_token: json.access_token,
      email: json.email || '',
      expires_in: json.expires_in ?? 0,
    };
  }

  throw new Error('Timed out waiting for magic link approval.');
}

/**
 * Write HireBridge token + email to .env file.
 * Replaces existing JOBOPS_HIREBRIDGE_TOKEN / JOBOPS_HIREBRIDGE_EMAIL lines if present.
 */
export function writeHireBridgeTokenToEnv(token: string, email: string, projectRoot: string): void {
  const envPath = resolve(projectRoot, '.env');
  let content = existsSync(envPath) ? readFileSync(envPath, 'utf-8') : '';

  // Replace or append JOBOPS_HIREBRIDGE_TOKEN
  const tokenLine = `JOBOPS_HIREBRIDGE_TOKEN=${token}`;
  if (content.includes('JOBOPS_HIREBRIDGE_TOKEN=')) {
    content = content.replace(/JOBOPS_HIREBRIDGE_TOKEN=.*/g, tokenLine);
  } else {
    content += (content.endsWith('\n') ? '' : '\n') + tokenLine + '\n';
  }

  // Replace or append JOBOPS_HIREBRIDGE_EMAIL
  const emailLine = `JOBOPS_HIREBRIDGE_EMAIL=${email}`;
  if (content.includes('JOBOPS_HIREBRIDGE_EMAIL=')) {
    content = content.replace(/JOBOPS_HIREBRIDGE_EMAIL=.*/g, emailLine);
  } else {
    content += (content.endsWith('\n') ? '' : '\n') + emailLine + '\n';
  }

  writeFileSync(envPath, content, 'utf-8');

  // Also set in process.env for the current process
  process.env.JOBOPS_HIREBRIDGE_TOKEN = token;
  process.env.JOBOPS_HIREBRIDGE_EMAIL = email;
}

/**
 * Update federation_state with HireBridge connection info.
 */
export async function updateFederationState(email: string): Promise<void> {
  await runInWriteLock(() => {
    getDb()
      .prepare(`UPDATE federation_state SET hirebridge_email = ?, hirebridge_connected = 1 WHERE id = 1`)
      .run(email);
  });
}

// ── Signal Broadcast ──────────────────────────────────────────────────────────

/**
 * Broadcast a signal snapshot to HireBridge.
 * POST /signal/ingest with the snapshot + bearer token.
 */
export async function broadcastSignalToHireBridge(
  snapshot: any,
  baseUrl?: string,
): Promise<BroadcastResult> {
  const hirebridgeUrl = baseUrl || (process.env.JOBOPS_HIREBRIDGE_URL || 'https://api.hirebridge.io').trim();
  const token = (process.env.JOBOPS_HIREBRIDGE_TOKEN ?? '').trim();

  if (!token) {
    return {
      ok: false,
      snapshot_hash: '',
      error: 'JOBOPS_HIREBRIDGE_TOKEN not set.',
      fix: 'Run `jobops connect_to_hirebridge` to authenticate with HireBridge.',
    };
  }

  const snapshotStr = JSON.stringify(snapshot, null, 2);
  const snapshot_hash = createHash('sha256').update(snapshotStr, 'utf-8').digest('hex');

  try {
    const res = await fetchWithTimeout(`${hirebridgeUrl}/signal/ingest`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: snapshotStr,
      timeoutMs: 30000,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return {
        ok: false,
        snapshot_hash,
        error: `HTTP ${res.status}: ${text.slice(0, 200)}`,
      };
    }

    const json = await res.json();

    return {
      ok: true,
      snapshot_hash,
      response: json,
    };
  } catch (e: any) {
    const errorMsg = `Connection failed: ${e?.message ?? e}`;

    return {
      ok: false,
      snapshot_hash,
      error: errorMsg,
      fix: `Ensure HireBridge is reachable at ${hirebridgeUrl}.`,
    };
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
