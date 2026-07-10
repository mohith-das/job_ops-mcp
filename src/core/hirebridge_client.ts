// HireBridge client — Device Authorization / Magic Link flow + signed snapshot
// broadcast, per the Canonical Federation Contract v1 shared with hirebridge and
// LivingCV. Replaces the JSON-RPC-shaped auth + HMAC-signed ingest from the
// pre-v1 client. Important pieces:
//
//   1. One-shot ed25519 keypair generated on first connect, persisted in
//      `federation_state`, reused for every snapshot signature. The public_key
//      is registered at /auth/device time and trusted thereafter by HireBridge.
//   2. POST /auth/device   — JSON {node_type, endpoint_url, public_key}
//   3. POST /auth/request  — form-encoded {email, uc} → emails the magic link
//   4. POST /auth/token    — form-encoded, RFC 8628 errors come back as HTTP 400
//                            + JSON body. Polling must read the body on EVERY
//                            response (including non-2xx) and act on the
//                            authorization_pending / slow_down / expired_token /
//                            access_denied codes; throwing on 400 aborts the
//                            very first poll and never resolves.
//   5. POST /ingest/snapshot — JSON {candidate_id, payload, embedding, signature}
//      where signature is ed25519 over the exact payload bytes (Node Buffer).
//
// All public surface area of this file matches the contract — no silent
// signatures, no lost body parses, no fallback to HMAC.

import { createHash, generateKeyPairSync } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { getDb, runInWriteLock } from '../db.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DeviceAuthOptions {
  /** Public LivingCV base URL we advertise to HireBridge. Empty string is OK. */
  endpoint_url?: string;
  /** Override the HireBridge base URL. Defaults to env / https://api.hirebridge.io. */
  baseUrl?: string;
}

export interface DeviceAuthResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval: number;
}

export interface TokenSuccess {
  access_token: string;
  node_id: string;
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

export interface FederationIdentity {
  public_key: string;   // 64-char hex of raw ed25519 pubkey bytes
  private_key: string;  // 64-char hex of raw ed25519 privkey seed (32 bytes); sensitive
  node_id: string | null;
}

// ── Keypair persistence ──────────────────────────────────────────────────────

/**
 * Return the persisted ed25519 keypair, generating one if absent. Both fields
 * are raw-byte hex (Node crypto emits 32-byte privkey seeds and 32-byte raw
 * pubkeys for ed25519, so hex strings are 64 chars apiece).
 *
 * The keypair is stored in `federation_state` — never inside the career
 * packet (per the contract).
 */
export function loadOrCreateIdentity(): FederationIdentity {
  const row = getDb()
    .prepare(
      `SELECT hirebridge_public_key, hirebridge_private_key, hirebridge_node_id
       FROM federation_state WHERE id = 1`,
    )
    .get() as any;

  if (row?.hirebridge_public_key && row?.hirebridge_private_key) {
    return {
      public_key:  row.hirebridge_public_key,
      private_key: row.hirebridge_private_key,
      node_id:     row.hirebridge_node_id || null,
    };
  }

  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  // We persist the RAW 32-byte seed/private hex and the raw 32-byte public hex.
  // The contract requires `public_key` to be the 64-char hex form, and the raw
  // seed is exactly what Node's ed25519 JWK `d` field base64url-decodes to —
  // identical to what the matching RFC 8410 PKCS#8 OCTET STRING OCTET STRING
  // payload is. We reassemble the PKCS#8 DER on demand at signing time.
  const pubJwk  = publicKey.export  ({ format: 'jwk' }) as any;
  const privJwk = privateKey.export ({ format: 'jwk' }) as any;
  if (!pubJwk?.x || !privJwk?.d) {
    throw new Error('Failed to export ed25519 keypair as JWK; aborting.');
  }
  const public_key  = Buffer.from(pubJwk.x,  'base64url').toString('hex');
  const private_key = Buffer.from(privJwk.d, 'base64url').toString('hex');
  if (public_key.length !== 64 || private_key.length !== 64) {
    throw new Error(`Unexpected ed25519 JWK lengths: pub=${public_key.length}, priv=${private_key.length}`);
  }

  runInWriteLock(() => {
    getDb()
      .prepare(
        `UPDATE federation_state SET hirebridge_public_key = ?, hirebridge_private_key = ? WHERE id = 1`,
      )
      .run(public_key, private_key);
  });

  return { public_key, private_key, node_id: null };
}

/**
 * Reassemble a PKCS#8 DER-encoded Ed25519 private key from the raw 32-byte
 * seed stored in `federation_state`. Ed25519's RFC 8410 wrapping is:
 *   SEQUENCE { INTEGER 0, SEQUENCE { OID 1.3.101.112 }, OCTET STRING { <seed> } }
 * with a fixed 48-byte DER prefix before the 32-byte seed. This is what
 * `generateKeyPairSync('ed25519').export({type:'pkcs8',format:'der'})` emits,
 * and what Node's `createPrivateKey({format:'der', type:'pkcs8'})` consumes.
 */
export function ed25519RawSeedToPkcs8Der(rawSeedHex: string): Buffer {
  if (rawSeedHex.length !== 64) {
    throw new Error(`ed25519 raw seed must be 64 hex chars, got ${rawSeedHex.length}`);
  }
  const seed = Buffer.from(rawSeedHex, 'hex');
  // RFC 8410 Ed25519 PKCS#8. Matches Node's own export byte-for-byte.
  return Buffer.concat([
    Buffer.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]),
    seed,
  ]);
}

/**
 * Persist `node_id` returned by HireBridge on successful auth (correlation id
 * for audit + future use). Idempotent.
 */
export function persistNodeId(node_id: string): void {
  runInWriteLock(() => {
    getDb()
      .prepare(`UPDATE federation_state SET hirebridge_node_id = ? WHERE id = 1`)
      .run(node_id);
  });
}

/**
 * candidate_id = first 32 hex chars of sha256(lowercase(trim(email))).
 * Per the contract, HireBridge uses this as the canonical identifier and
 * jobops must derive it the same way for signatures to match.
 */
export function candidateIdFor(email: string): string {
  const normalised = String(email || '').trim().toLowerCase();
  return createHash('sha256').update(normalised, 'utf-8').digest('hex').slice(0, 32);
}

// ── Device Auth Flow ──────────────────────────────────────────────────────────

/**
 * POST /auth/device — registers this node and returns a device_code for polling.
 *
 * Body (JSON, per the contract):
 *   { node_type: "jobops", endpoint_url: <string>, public_key: <64-hex> }
 *
 * The HireBridge server ignores any other fields; the `endpoint_url` is the
 * public LivingCV base URL (or "" if not synced yet). The keypair is loaded
 * or generated on demand and persisted in `federation_state` in the same call.
 */
export async function initiateDeviceAuth(
  opts: DeviceAuthOptions = {},
): Promise<DeviceAuthResponse> {
  const baseUrl = pickBaseUrl(opts.baseUrl);
  const identity = loadOrCreateIdentity();

  // endpoint_url defaults to JOBOPS_PUBLIC_BASE_URL (the public LivingCV URL).
  // If unset, send an empty string — HireBridge treats it as "not announced yet".
  const endpointUrl =
    opts.endpoint_url
    ?? (process.env.JOBOPS_PUBLIC_BASE_URL || '').trim();

  const res = await fetch(`${baseUrl}/auth/device`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      node_type: 'jobops',
      endpoint_url: endpointUrl,
      public_key: identity.public_key,
    }),
  });

  const text = await res.text().catch(() => '');
  if (!res.ok) {
    throw new Error(
      `HireBridge /auth/device failed: HTTP ${res.status} ${text.slice(0, 200)}`,
    );
  }
  let json: any;
  try { json = JSON.parse(text); }
  catch { throw new Error(`HireBridge /auth/device returned non-JSON body: ${text.slice(0, 200)}`); }

  if (!json.device_code || !json.verification_uri) {
    throw new Error(
      `HireBridge /auth/device returned malformed body: ${text.slice(0, 200)}`,
    );
  }
  return {
    device_code: json.device_code,
    user_code: json.user_code,
    verification_uri: json.verification_uri,
    verification_uri_complete: json.verification_uri_complete,
    expires_in: json.expires_in ?? 600,
    interval: json.interval ?? 5,
  };
}

/**
 * POST /auth/request — form-encoded {email, uc} → HireBridge emails the
 * magic link containing `verification_uri_complete`. Per the contract the
 * /auth/device endpoint does NOT send email; this one does.
 *
 * Status: 202 → "we queued the link" (best-effort, idempotent).
 *
 * Fallback for users who never receive the email: also print the
 * `verification_uri_complete` returned by /auth/device; they can open it
 * directly.
 */
export async function requestEmailMagicLink(
  email: string,
  userCode: string,
  baseUrl?: string,
): Promise<void> {
  const url = pickBaseUrl(baseUrl);
  const body = new URLSearchParams({ email, uc: userCode }).toString();

  const res = await fetch(`${url}/auth/request`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body,
  });
  // 202 (Accepted) or 204 are the documented happy paths. 4xx indicates a
  // server-side error (rate limit, bad uc). Other 2xx are tolerated but logged.
  if (!res.ok && res.status !== 204) {
    const text = await res.text().catch(() => '');
    throw new Error(
      `HireBridge /auth/request failed: HTTP ${res.status} ${text.slice(0, 200)}`,
    );
  }
}

/**
 * Poll POST /auth/token until success or expiry.
 *
 * Per RFC 8628, the server returns *error* codes as HTTP 400 + a JSON body
 * with {error, ...} — we MUST read the body on every response, including 4xx,
 * and switch on `error` rather than throwing. Throwing on non-2xx would
 * abort the very first poll ("authorization_pending" → 400) and never
 * resolve.
 *
 * Body is form-encoded:
 *   grant_type=urn:ietf:params:oauth:grant-type:device_code&device_code=…
 */
export async function pollForToken(
  deviceCode: string,
  interval: number,
  expiresIn: number,
  baseUrl?: string,
): Promise<TokenSuccess> {
  const url = pickBaseUrl(baseUrl);
  const deadline = Date.now() + expiresIn * 1000;
  let pollIntervalMs = Math.max(1, interval) * 1000;

  while (Date.now() < deadline) {
    await sleep(pollIntervalMs);

    const body = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: deviceCode,
    }).toString();

    let res: Response;
    try {
      res = await fetch(`${url}/auth/token`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body,
      });
    } catch (e: any) {
      // Network error: keep polling until deadline — the user might still click.
      continue;
    }

    // Read the JSON body on EVERY response (success and error alike).
    const text = await res.text().catch(() => '');
    let json: any = null;
    if (text) {
      try { json = JSON.parse(text); } catch { /* not JSON; fall through */ }
    }

    if (res.ok) {
      if (!json || !json.access_token) {
        throw new Error(
          `HireBridge /auth/token success but no access_token: ${text.slice(0, 200)}`,
        );
      }
      return {
        access_token: json.access_token,
        node_id: json.node_id || '',
        email: json.email || '',
        expires_in: json.expires_in ?? 0,
      };
    }

    // Non-2xx. Switch on the RFC 8628 error code in the body.
    const errCode = json?.error;
    switch (errCode) {
      case 'authorization_pending':
        continue;
      case 'slow_down':
        // Honour the interval the server sent; if absent, double the current one.
        pollIntervalMs = json.interval ? Math.max(1, json.interval) * 1000 : pollIntervalMs * 2;
        continue;
      case 'expired_token':
        throw new Error('Magic link expired. Run connect_to_hirebridge again.');
      case 'access_denied':
        throw new Error('Access denied. The magic link was rejected or revoked.');
      default:
        throw new Error(
          `HireBridge /auth/token returned HTTP ${res.status} error=${
            errCode ?? '(no error code)'
          } body=${text.slice(0, 200)}`,
        );
    }
  }

  throw new Error('Timed out waiting for magic link approval.');
}

/**
 * Persist the authenticated creds. Writes both the .env file (for child
 * processes) and the federation_state row (for the dashboard / MCP tools).
 */
export function persistConnection(
  accessToken: string,
  email: string,
  nodeId: string,
  projectRoot: string,
): void {
  writeHireBridgeTokenToEnv(accessToken, email, projectRoot);
  // node_id is sensitive-but-not-secret — keep it in process.env so child
  // processes can also correlate if needed.
  process.env.JOBOPS_HIREBRIDGE_NODE_ID = nodeId;
  updateFederationState(email, nodeId);
}

/**
 * Write HireBridge token + email to .env file.
 * Replaces existing JOBOPS_HIREBRIDGE_TOKEN / JOBOPS_HIREBRIDGE_EMAIL lines
 * if present. Mirrors the shape introduced pre-v1 for back-compat with any
 * docs / scripts that grep for these lines.
 */
export function writeHireBridgeTokenToEnv(token: string, email: string, projectRoot: string): void {
  const envPath = resolve(projectRoot, '.env');
  let content = existsSync(envPath) ? readFileSync(envPath, 'utf-8') : '';

  const tokenLine = `JOBOPS_HIREBRIDGE_TOKEN=${token}`;
  content = content.includes('JOBOPS_HIREBRIDGE_TOKEN=')
    ? content.replace(/^JOBOPS_HIREBRIDGE_TOKEN=.*$/gm, tokenLine)
    : (content.endsWith('\n') || !content ? content : content + '\n') + tokenLine + '\n';

  const emailLine = `JOBOPS_HIREBRIDGE_EMAIL=${email}`;
  content = content.includes('JOBOPS_HIREBRIDGE_EMAIL=')
    ? content.replace(/^JOBOPS_HIREBRIDGE_EMAIL=.*$/gm, emailLine)
    : content + emailLine + '\n';

  writeFileSync(envPath, content, 'utf-8');

  process.env.JOBOPS_HIREBRIDGE_TOKEN = token;
  process.env.JOBOPS_HIREBRIDGE_EMAIL = email;
}

/**
 * Update federation_state with the post-auth connection info. Stamps
 * hirebridge_email, hirebridge_connected=1, and the new hirebridge_node_id.
 */
export async function updateFederationState(email: string, nodeId: string): Promise<void> {
  await runInWriteLock(() => {
    getDb()
      .prepare(
        `UPDATE federation_state SET hirebridge_email = ?, hirebridge_node_id = ?, hirebridge_connected = 1 WHERE id = 1`,
      )
      .run(email, nodeId);
  });
}

// ── Snapshot Broadcast ───────────────────────────────────────────────────────

/**
 * POST /ingest/snapshot with the contract envelope:
 *   { candidate_id, payload, embedding, signature }
 *
 * Signature is ed25519 over the EXACT `payload` bytes — see signal_broadcast.ts
 * for the builder + dim guard. This thin wrapper only handles HTTP + auth.
 */
export async function postSnapshot(
  body: { candidate_id: string; payload: any; embedding: number[][]; signature: string },
  baseUrl?: string,
): Promise<{ ok: boolean; status: number; response?: any; error?: string; fix?: string }> {
  const url = pickBaseUrl(baseUrl);
  const token = (process.env.JOBOPS_HIREBRIDGE_TOKEN ?? '').trim();
  if (!token) {
    return {
      ok: false,
      status: 0,
      error: 'JOBOPS_HIREBRIDGE_TOKEN not set.',
      fix: 'Run `jobops connect_to_hirebridge` to authenticate with HireBridge.',
    };
  }

  const bodyStr = JSON.stringify(body);
  try {
    const res = await fetch(`${url}/ingest/snapshot`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: bodyStr,
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text().catch(() => '');
    let json: any = null;
    if (text) { try { json = JSON.parse(text); } catch { /* not JSON */ } }

    if (res.ok) {
      return { ok: true, status: res.status, response: json ?? text };
    }
    return {
      ok: false,
      status: res.status,
      error: `HTTP ${res.status} ${text.slice(0, 200)}`.trim(),
      fix: res.status === 401
        ? 'HireBridge rejected the bearer token — re-run `jobops connect_to_hirebridge`.'
        : res.status === 404
          ? `HireBridge ${url}/ingest/snapshot returned 404 — wrong base URL?`
          : undefined,
    };
  } catch (e: any) {
    return {
      ok: false,
      status: 0,
      error: `Connection failed: ${e?.message ?? e}`,
      fix: `Ensure HireBridge is reachable at ${url}.`,
    };
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function pickBaseUrl(override?: string): string {
  return (override ?? (process.env.JOBOPS_HIREBRIDGE_URL ?? 'https://api.hirebridge.io')).trim();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
