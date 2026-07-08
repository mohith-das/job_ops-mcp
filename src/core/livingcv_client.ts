// LivingCV Master Relay HTTP client.
//
// Pushes the compiled career-packet.json to a local LivingCV instance via JSON-RPC
// to its /mcp HTTP endpoint. Authenticates using LivingCV's Master Relay bearer token.
//
// The sync uses the `sync_career_packet` tool name (matching the exact tool name
// LivingCV Master Relay exposes).

import { createHash } from 'node:crypto';

import { getDb, runInWriteLock } from '../db.js';
import { fetchWithTimeout } from './providers/http.js';
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

// ── Sync function ─────────────────────────────────────────────────────────────

/**
 * Sync the compiled career-packet.json to LivingCV via JSON-RPC.
 *
 * Posts a `tools/call` request to `${livingcvBaseUrl}/mcp` with:
 *   - tool name: `sync_career_packet`
 *   - arguments: `{ content: "<stringified career-packet.json>" }`
 *   - Authorization: Bearer <livingcvToken>
 *
 * Updates federation_state.livingcv_last_sync on success, livingcv_last_error on failure.
 *
 * @param packet - The compiled career packet (from compileCareerPacketJson)
 * @param force - If true, sync even if content_hash matches last sync
 * @returns SyncResult with ok, response, error details
 */
export async function syncToLivingCV(
  packet: CareerPacketJson,
  force: boolean = false,
): Promise<SyncResult> {
  // Read from process.env directly (not config) so tests can change it at runtime
  const livingcvUrl = (process.env.JOBOPS_LIVINGCV_URL || 'http://127.0.0.1:7890').trim();
  const livingcvToken = (process.env.JOBOPS_LIVINGCV_TOKEN ?? '').trim() || null;

  // Check for token
  if (!livingcvToken) {
    return {
      ok: false,
      livingcv_url: livingcvUrl,
      packet_version: packet.meta.version,
      content_hash: '',
      error: 'JOBOPS_LIVINGCV_TOKEN not set.',
      fix: 'Set JOBOPS_LIVINGCV_TOKEN in .env or export it. This is the bearer token for your LivingCV Master Relay instance.',
    };
  }

  // Compute content hash
  const contentStr = JSON.stringify(packet, null, 2);
  const content_hash = createHash('sha256').update(contentStr, 'utf-8').digest('hex');

  // Build JSON-RPC request
  const rpcRequest = {
    jsonrpc: '2.0',
    method: 'tools/call',
    params: {
      name: 'sync_career_packet',
      arguments: {
        content: contentStr,
      },
    },
    id: 1,
  };

  // POST to LivingCV /mcp endpoint
  try {
    const res = await fetchWithTimeout(`${livingcvUrl}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${livingcvToken}`,
      },
      body: JSON.stringify(rpcRequest),
      timeoutMs: 30000, // 30s timeout for large packets
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const errorMsg = `HTTP ${res.status}: ${text.slice(0, 200)}`;

      // Update federation state with error
      await runInWriteLock(() => {
        getDb()
          .prepare(`UPDATE federation_state SET livingcv_last_error = ? WHERE id = 1`)
          .run(errorMsg);
      });

      let fix: string | undefined;
      if (res.status === 401) {
        fix = 'Invalid or expired JOBOPS_LIVINGCV_TOKEN. Check your LivingCV Master Relay config.';
      } else if (res.status === 404) {
        fix = `LivingCV /mcp endpoint not found at ${livingcvUrl}/mcp. Is LivingCV running?`;
      }

      return {
        ok: false,
        livingcv_url: livingcvUrl,
        packet_version: packet.meta.version,
        content_hash,
        error: errorMsg,
        fix,
      };
    }

    // Parse response
    const json = await res.json();

    // Check for JSON-RPC error
    if (json.error) {
      const errorMsg = `JSON-RPC error: ${json.error.message || JSON.stringify(json.error)}`;
      await runInWriteLock(() => {
        getDb()
          .prepare(`UPDATE federation_state SET livingcv_last_error = ? WHERE id = 1`)
          .run(errorMsg);
      });

      return {
        ok: false,
        livingcv_url: livingcvUrl,
        packet_version: packet.meta.version,
        content_hash,
        response: json,
        error: errorMsg,
      };
    }

    // Success — update federation state
    await runInWriteLock(() => {
      getDb()
        .prepare(`UPDATE federation_state SET livingcv_last_sync = CURRENT_TIMESTAMP, livingcv_last_error = NULL WHERE id = 1`)
        .run();
    });

    return {
      ok: true,
      livingcv_url: livingcvUrl,
      packet_version: packet.meta.version,
      content_hash,
      response: json.result,
    };
  } catch (e: any) {
    const errorMsg = `Connection failed: ${e?.message ?? e}`;

    // Update federation state with error
    await runInWriteLock(() => {
      getDb()
        .prepare(`UPDATE federation_state SET livingcv_last_error = ? WHERE id = 1`)
        .run(errorMsg);
    });

    return {
      ok: false,
      livingcv_url: livingcvUrl,
      packet_version: packet.meta.version,
      content_hash,
      error: errorMsg,
      fix: `Ensure LivingCV is running at ${livingcvUrl}. Check JOBOPS_LIVINGCV_URL in .env.`,
    };
  }
}
