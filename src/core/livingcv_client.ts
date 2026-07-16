// LivingCV Master Relay client.
//
// Per the Canonical Federation Contract v1:
//   * Transport is MCP-over-SSE (NOT a bare JSON-RPC POST).
//   * Path: `${JOBOPS_LIVINGCV_URL}/mcp-admin/sse` — Caddy on LivingCV rewrites
//     it to the orchestrator's `/api/mcp/sse`, and the server tells us where
//     to POST messages via the standard MCP `endpoint` SSE event.
//   * Auth: `Authorization: Bearer ${JOBOPS_LIVINGCV_TOKEN}` on BOTH the SSE
//     GET and the message POSTs. The token is LivingCV's master-relay key
//     (`mcp.master_key`, shown in LivingCV Admin → Settings → MCP).
//   * Tool: `sync_career_packet { packet: <LcvPacket> }`. Result is the
//     synced packet version (or validation error from LivingCV).
//   * Preconditions on the LivingCV side: `mcp.enabled=1` and
//     `mcp.jobops_sync_enabled=1`. If the call fails because of those, surface
//     them in `fix` so the user knows exactly where to look.
//
// We intentionally do NOT cache a long-lived SSE connection — the SDK opens
// and closes per call. This is simple, isolates failures, and matches how
// the rest of jobops treats stateless HTTP paths.

import { createHash } from 'node:crypto';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

import { getDb, runInWriteLock } from '../db.js';
import { mapCareerPacketToLivingCV, validateLivingCVShape, type LcvPacket } from './livingcv_packet_map.js';
import type { CareerPacketJson } from './career_packet_json.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SyncResult {
  ok: boolean;
  livingcv_url: string;
  packet_version: number;
  content_hash: string;
  response?: any;
  error?: string;
  fix?: string;
}

// ── URL + token resolution ────────────────────────────────────────────────────

/**
 * Resolve the LivingCV base URL the user pointed us at. Unlike before v1 we do
 * NOT default to http://127.0.0.1:7890 (nothing runs there in any topology
 * we're deployed against). Returning null tells the caller to surface a
 * concrete "set JOBOPS_LIVINGCV_URL" error rather than trying a meaningless
 * port.
 */
export function resolveLivingCVBaseUrl(): string | null {
  const raw = (process.env.JOBOPS_LIVINGCV_URL ?? '').trim();
  if (!raw) return null;
  return raw.replace(/\/+$/, '');
}

export function resolveLivingCVToken(): string | null {
  const raw = (process.env.JOBOPS_LIVINGCV_TOKEN ?? '').trim();
  return raw || null;
}

function resolveInternalSyncSecret(): string | null {
  return (process.env.JOBOPS_LIVINGCV_INTERNAL_SECRET ?? '').trim() || null;
}

// ── Sync function ─────────────────────────────────────────────────────────────

/**
 * Push the compiled career packet to LivingCV.
 *
 * Flow: open SSE → call sync_career_packet {packet} → close SSE → record state.
 *
 * @param packet - The compiled career packet (from compileCareerPacketJson)
 * @param _force - Kept for back-compat with the v1 signature; no skip-cache
 *                 semantic on LivingCV side yet (every call validates + writes).
 */
export async function syncToLivingCV(
  packet: CareerPacketJson,
  _force: boolean = false,
  approval?: { approvedByUser: boolean; proposalId: string },
): Promise<SyncResult> {
  const livingcvUrl = resolveLivingCVBaseUrl();
  if (!livingcvUrl) {
    return {
      ok: false,
      livingcv_url: '',
      packet_version: packet.meta.version,
      content_hash: '',
      error: 'JOBOPS_LIVINGCV_URL is not set.',
      fix:
        'Set JOBOPS_LIVINGCV_URL in .env to your deployed LivingCV base URL ' +
        '(e.g. https://jobs.example.com), without the /mcp-admin/sse suffix.',
    };
  }

  const internalSecret = resolveInternalSyncSecret();
  const livingcvToken = resolveLivingCVToken();
  if (!internalSecret && !livingcvToken) {
    return {
      ok: false,
      livingcv_url: livingcvUrl,
      packet_version: packet.meta.version,
      content_hash: '',
      error: 'LivingCV product sync is not provisioned.',
      fix:
        'Provision JOBOPS_LIVINGCV_INTERNAL_SECRET for the integrated product, or configure the legacy MCP token.',
    };
  }

  // Map → validate. We validate locally so we can fix obvious shape errors
  // before opening a network connection (cheaper, less likely to mask issues).
  let lcv: LcvPacket;
  try {
    lcv = validateLivingCVShape(mapCareerPacketToLivingCV(packet));
  } catch (e: any) {
    return {
      ok: false,
      livingcv_url: livingcvUrl,
      packet_version: packet.meta.version,
      content_hash: '',
      error: `Local LivingCV-shape validation failed: ${e?.message ?? e}`,
      fix: 'Open an issue with the failing packet — the mapping should not produce invalid LivingCV shapes.',
    };
  }

  // Content hash for our log + dedup (LivingCV assigns its own version).
  const content_hash = sha256(JSON.stringify(lcv, null, 2));

  let response: any;
  try {
    if (internalSecret) {
      const result = await fetch(`${livingcvUrl}/api/internal/jobops-sync`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-jobops-sync-secret': internalSecret },
        body: JSON.stringify({
          packet: lcv,
          approved_by_user: approval?.approvedByUser === true,
          proposal_id: approval?.proposalId,
        }),
      });
      const payload = await result.json().catch(() => ({}));
      if (!result.ok) throw new Error(`LivingCV internal sync returned ${result.status}: ${JSON.stringify(payload)}`);
      response = payload;
    } else {
    const sseUrl = new URL(`${livingcvUrl}/mcp-admin/sse`);
    const authHeaders = { authorization: `Bearer ${livingcvToken}` };

    const transport = new SSEClientTransport(sseUrl, {
      // The SSE GET is the first request the client makes.
      eventSourceInit: { headers: authHeaders } as any,
      // The message POSTs that follow also need the bearer token.
      requestInit:    { headers: authHeaders } as any,
    });

    const client = new Client(
      { name: 'jobops', version: '0.18.0' },
      { capabilities: {} },
    );
    await client.connect(transport);

    try {
      const result = await client.callTool({
        name: 'sync_career_packet',
        arguments: { packet: lcv },
      });
      // MCP tool results are wrapped: { content: [{type:'text', text:'...'}], ... }
      // Some servers also put structured payloads at the top level. Normalise.
      response = normalizeToolResult(result);
    } finally {
      try { await transport.close(); } catch { /* best-effort */ }
      try { await client.close();   } catch { /* best-effort */ }
    }
    }
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    const fix = describeLivingCVFailure(msg);
    await recordError(livingcvUrl, packet.meta.version, content_hash, msg);
    return {
      ok: false,
      livingcv_url: livingcvUrl,
      packet_version: packet.meta.version,
      content_hash,
      error: `Sync to LivingCV failed: ${msg}`,
      fix,
    };
  }

  await runInWriteLock(() => {
    getDb()
      .prepare(
        `UPDATE federation_state SET livingcv_last_sync = CURRENT_TIMESTAMP, livingcv_last_error = NULL WHERE id = 1`,
      )
      .run();
  });

  return {
    ok: true,
    livingcv_url: livingcvUrl,
    packet_version: packet.meta.version,
    content_hash,
    response,
  };
}

/**
 * Map an MCP error to a helpful fix string. The two most common failure modes
 * LivingCV returns are:
 *   - the server is reachable but jobops_sync_enabled is off, OR
 *   - mcp.enabled is off entirely.
 * Both surface as 401-ish refusals; the fix is to flip the right admin flag.
 */
function describeLivingCVFailure(message: string): string | undefined {
  if (/401|unauthor/i.test(message)) {
    return 'LivingCV rejected the bearer token. Check Admin → Settings → MCP → mcp.enabled = 1 and mcp.master_key matches JOBOPS_LIVINGCV_TOKEN.';
  }
  if (/403|forbid/i.test(message)) {
    return 'LivingCV refused the call. Confirm mcp.jobops_sync_enabled = 1 in LivingCV Admin → Settings → MCP, and the master key has the jobops-sync scope.';
  }
  if (/not.found|404/i.test(message)) {
    return 'LivingCV /mcp-admin/sse returned 404. Is the base URL (JOBOPS_LIVINGCV_URL) correct, and is the orchestrator running?';
  }
  if (/validation|invalid.packet|schema/i.test(message)) {
    return 'LivingCV rejected the packet shape. Open the LivingCV log for the exact zod error and file a jobops issue — the mapper should produce a valid packet.';
  }
  return undefined;
}

/**
 * Pull a structured shape out of the MCP tool-result envelope.
 * Result is `CallToolResult` per MCP spec — most of the time we want the
 * `structuredContent` field, falling back to parsing the first text item.
 */
function normalizeToolResult(result: any): any {
  if (!result) return null;
  if (typeof result === 'object' && 'structuredContent' in result) {
    return (result as any).structuredContent;
  }
  if (Array.isArray((result as any)?.content)) {
    for (const item of (result as any).content) {
      if (item?.type === 'json' && item.json !== undefined) return item.json;
      if (item?.type === 'text' && typeof item.text === 'string') {
        try { return JSON.parse(item.text); } catch { return item.text; }
      }
    }
  }
  return result;
}

async function recordError(url: string, version: number, hash: string, msg: string): Promise<void> {
  await runInWriteLock(() => {
    getDb()
      .prepare(`UPDATE federation_state SET livingcv_last_error = ? WHERE id = 1`)
      .run(msg);
  });
}

function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf-8').digest('hex');
}
