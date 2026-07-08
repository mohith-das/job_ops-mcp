// MCP tools for signal broadcast and federation status.
//
// broadcast_signal — compiles and broadcasts a signed snapshot to HireBridge.
// get_federation_status — returns federation state (sync times, connection status).

import { defineTool, okResult, errResult } from '../define.js';
import { broadcastSignal } from '../../core/signal_broadcast.js';
import { getDb } from '../../db.js';

// ── broadcast_signal ──────────────────────────────────────────────────────────

export const broadcastSignalTool = defineTool({
  name: 'broadcast_signal',
  title: 'Broadcast signal snapshot to HireBridge',
  description:
    'Compile and broadcast a signed snapshot of embeddings + capabilities to HireBridge. ' +
    'The snapshot includes cached embeddings, evidence-based capabilities (from story_bank), ' +
    'and the LivingCV URL. Signed with HMAC-SHA256 using the HireBridge token. ' +
    'Requires: compiled career packet (compile_career_packet), cached embeddings (generate_embeddings), ' +
    'and HireBridge authentication (connect_to_hirebridge).',
  mutates: true,
  inputSchema: {},
  handler: async () => {
    const result = await broadcastSignal();

    if (result.ok) {
      return okResult({
        broadcast: true,
        snapshot_hash: result.snapshot_hash,
        hirebridge_response: result.response,
        note: 'Signal snapshot broadcast to HireBridge successfully.',
      });
    } else {
      return errResult(
        `Failed to broadcast signal: ${result.error}` +
        (result.fix ? `\n\nFix: ${result.fix}` : ''),
      );
    }
  },
});

// ── get_federation_status ─────────────────────────────────────────────────────

export const getFederationStatusTool = defineTool({
  name: 'get_federation_status',
  title: 'Get federation status',
  description:
    'Returns the current federation state: LivingCV sync time, HireBridge broadcast time, ' +
    'HireBridge connection status, and counts of cached embeddings and broadcast history. ' +
    'Read-only.',
  mutates: false,
  inputSchema: {},
  handler: async () => {
    const db = getDb();

    // Get federation state
    const state = db
      .prepare(`SELECT * FROM federation_state WHERE id = 1`)
      .get() as any;

    // Count cached embeddings
    const embeddingCount = db
      .prepare(`SELECT COUNT(*) AS count FROM embeddings_cache`)
      .get() as any;

    // Count broadcasts
    const broadcastCount = db
      .prepare(`SELECT COUNT(*) AS count FROM broadcast_log`)
      .get() as any;

    // Get last broadcast
    const lastBroadcast = db
      .prepare(`SELECT snapshot_hash, status, created_at FROM broadcast_log ORDER BY created_at DESC LIMIT 1`)
      .get() as any;

    return okResult({
      livingcv: {
        last_sync: state?.livingcv_last_sync || null,
        last_error: state?.livingcv_last_error || null,
      },
      hirebridge: {
        connected: !!state?.hirebridge_connected,
        email: state?.hirebridge_email || null,
        last_broadcast: state?.hirebridge_last_broadcast || null,
        last_error: state?.hirebridge_last_error || null,
      },
      embeddings_cached: embeddingCount?.count ?? 0,
      broadcasts_total: broadcastCount?.count ?? 0,
      last_broadcast: lastBroadcast
        ? {
            snapshot_hash: lastBroadcast.snapshot_hash,
            status: lastBroadcast.status,
            created_at: lastBroadcast.created_at,
          }
        : null,
    });
  },
});
