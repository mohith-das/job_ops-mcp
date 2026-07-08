// Signal broadcast — compiles and pushes a signed snapshot to HireBridge.
//
// The snapshot includes:
//   - Cached embeddings (from embeddings_cache)
//   - Evidence-based capabilities (from story_bank competency_tags)
//   - LivingCV URL (where the canonical packet lives)
//   - Packet hash + version
//
// The snapshot is signed with an HMAC using the HireBridge token as the key,
// proving it came from the authenticated user without exposing the token.

import { createHash, createHmac } from 'node:crypto';

import { getDb, runInWriteLock } from '../db.js';
import { broadcastSignalToHireBridge } from './hirebridge_client.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SignalSnapshot {
  schema: 'jobops-signal-1.0';
  candidate: {
    email: string;
    livingcv_url: string;
  };
  packet_hash: string;
  packet_version: number;
  embeddings: {
    model: string;
    dim: number;
    sections: Array<{
      section: string;
      embedding: number[];
    }>;
  };
  capabilities: Array<{
    competency: string;
    evidence_count: number;
    story_ids: string[];
  }>;
  broadcast_at: string;
  signature: string;
}

export interface BroadcastResult {
  ok: boolean;
  snapshot_hash: string;
  response?: any;
  error?: string;
  fix?: string;
}

// ── Snapshot compiler ─────────────────────────────────────────────────────────

/**
 * Compile a signal snapshot from local data.
 *
 * Reads:
 *   - career_packet_json (active row) → packet_hash, version
 *   - embeddings_cache → cached embeddings for this packet
 *   - story_bank → competency_tags aggregated into capabilities
 *   - federation_state → hirebridge_email
 *   - config → livingcvBaseUrl
 *
 * Signs the snapshot with HMAC-SHA256 using the HireBridge token as the key.
 */
export async function compileSignalSnapshot(): Promise<SignalSnapshot> {
  const db = getDb();

  // Get active career packet
  const packetRow = db
    .prepare(`SELECT content_hash, version FROM career_packet_json WHERE is_active = 1`)
    .get() as any;

  if (!packetRow) {
    throw new Error('No compiled career packet found. Run compile_career_packet first.');
  }

  // Get cached embeddings
  const embeddingRows = db
    .prepare(`SELECT section, embedding, model, dim FROM embeddings_cache WHERE packet_hash = ?`)
    .all(packetRow.content_hash) as any[];

  if (embeddingRows.length === 0) {
    throw new Error('No cached embeddings found. Run generate_embeddings first.');
  }

  const embeddings = {
    model: embeddingRows[0].model,
    dim: embeddingRows[0].dim,
    sections: embeddingRows.map((r) => ({
      section: r.section,
      embedding: JSON.parse(r.embedding),
    })),
  };

  // Aggregate capabilities from story_bank
  const capabilityMap = new Map<string, { count: number; story_ids: string[] }>();
  const storyRows = db
    .prepare(`SELECT id, competency_tags FROM story_bank WHERE competency_tags IS NOT NULL`)
    .all() as any[];

  for (const row of storyRows) {
    const tags: string[] = JSON.parse(row.competency_tags);
    for (const tag of tags) {
      const existing = capabilityMap.get(tag) || { count: 0, story_ids: [] };
      existing.count++;
      existing.story_ids.push(row.id);
      capabilityMap.set(tag, existing);
    }
  }

  const capabilities = Array.from(capabilityMap.entries()).map(([competency, data]) => ({
    competency,
    evidence_count: data.count,
    story_ids: data.story_ids,
  }));

  // Get HireBridge email
  const state = db
    .prepare(`SELECT hirebridge_email FROM federation_state WHERE id = 1`)
    .get() as any;

  const email = state?.hirebridge_email || process.env.JOBOPS_HIREBRIDGE_EMAIL || '';
  const livingcvUrl = (process.env.JOBOPS_LIVINGCV_URL || 'http://127.0.0.1:7890').trim();

  // Build snapshot
  const snapshot: SignalSnapshot = {
    schema: 'jobops-signal-1.0',
    candidate: {
      email,
      livingcv_url: livingcvUrl,
    },
    packet_hash: packetRow.content_hash,
    packet_version: packetRow.version,
    embeddings,
    capabilities,
    broadcast_at: new Date().toISOString(),
    signature: '', // filled below
  };

  // Sign the snapshot
  const token = (process.env.JOBOPS_HIREBRIDGE_TOKEN ?? '').trim();
  if (!token) {
    throw new Error('JOBOPS_HIREBRIDGE_TOKEN not set. Run connect_to_hirebridge first.');
  }

  // Canonical JSON (sorted keys, no whitespace) for signing
  const canonical = JSON.stringify(snapshot, Object.keys(snapshot).sort());
  snapshot.signature = createHmac('sha256', token).update(canonical).digest('hex');

  return snapshot;
}

// ── Broadcast function ────────────────────────────────────────────────────────

/**
 * Compile and broadcast a signal snapshot to HireBridge.
 *
 * Returns BroadcastResult with ok, snapshot_hash, response, error, fix.
 */
export async function broadcastSignal(): Promise<BroadcastResult> {
  try {
    const snapshot = await compileSignalSnapshot();
    const snapshotStr = JSON.stringify(snapshot, null, 2);
    const snapshot_hash = createHash('sha256').update(snapshotStr, 'utf-8').digest('hex');

    const result = await broadcastSignalToHireBridge(snapshot);

    if (result.ok) {
      // Update federation state
      await runInWriteLock(() => {
        getDb()
          .prepare(`UPDATE federation_state SET hirebridge_last_broadcast = CURRENT_TIMESTAMP, hirebridge_last_error = NULL WHERE id = 1`)
          .run();
      });

      // Log to broadcast_log
      await runInWriteLock(() => {
        getDb()
          .prepare(`INSERT INTO broadcast_log (id, snapshot_hash, hirebridge_response, status) VALUES (?, ?, ?, 'sent')`)
          .run(
            createHash('sha256').update(snapshot_hash + Date.now()).digest('hex').slice(0, 32),
            snapshot_hash,
            JSON.stringify(result.response),
          );
      });

      return {
        ok: true,
        snapshot_hash,
        response: result.response,
      };
    } else {
      // Update federation state with error
      await runInWriteLock(() => {
        getDb()
          .prepare(`UPDATE federation_state SET hirebridge_last_error = ? WHERE id = 1`)
          .run(result.error);
      });

      // Log to broadcast_log
      await runInWriteLock(() => {
        getDb()
          .prepare(`INSERT INTO broadcast_log (id, snapshot_hash, error, status) VALUES (?, ?, ?, 'error')`)
          .run(
            createHash('sha256').update(snapshot_hash + Date.now()).digest('hex').slice(0, 32),
            snapshot_hash,
            result.error,
          );
      });

      return {
        ok: false,
        snapshot_hash,
        error: result.error,
        fix: result.fix,
      };
    }
  } catch (e: any) {
    return {
      ok: false,
      snapshot_hash: '',
      error: e?.message ?? String(e),
      fix: e?.message?.includes('compile') ? 'Run compile_career_packet and generate_embeddings first.' : undefined,
    };
  }
}
