// Signal broadcast — compiles and pushes a signed snapshot to HireBridge.
//
// Implements the Canonical Federation Contract v1 envelope:
//   POST /ingest/snapshot   {candidate_id, payload, embedding, signature}
//     payload       = public-safe compiled career packet + candidate +
//                     capabilities + packet_hash + packet_version + broadcast_at
//     embedding[0]  = WHOLE-PACKET vector (the only one HireBridge indexes)
//     signature     = ed25519 over the exact `payload` bytes
//
// Failure modes the prior implementation introduced:
//   * Sent its own jobops-signal-1.0 envelope — HireBridge rejects it (no
//     candidate_id). Now uses the contract shape HireBridge's SnapshotInput
//     accepts: {candidate_id, payload, embedding, signature}.
//   * Signed with HMAC-SHA256 keyed by the bearer token — server-side verify
//     is ed25519 against the public_key registered at /auth/device. The
//     keypair is generated once and persisted in `federation_state`.
//   * Always included section vectors as embedding[0]; HireBridge's repo
//     indexes only embedding[0], so we now put the whole-packet vector first.

import { createHash, createPrivateKey, sign as signCrypto } from 'node:crypto';

import { getDb, runInWriteLock } from '../db.js';
import { getEmbedder } from './embeddings.js';
import {
  candidateIdFor,
  ed25519RawSeedToPkcs8Der,
  loadOrCreateIdentity,
  postSnapshot,
  type BroadcastResult as ClientBroadcastResult,
} from './hirebridge_client.js';

// ── Types ─────────────────────────────────────────────────────────────────────

/** Public-safe compiled career packet — what `get_career_packet_json` returns. */
export interface PublicCareerPacket {
  schema?: string;
  meta?: Record<string, unknown>;
  basics?: Record<string, unknown>;
  target_roles?: Record<string, unknown>;
  taglines?: Record<string, unknown>;
  work?: unknown[];
  projects?: unknown[];
  education?: unknown[];
  skills?: unknown[];
  evidence?: unknown[];
  compensation?: Record<string, unknown>;
  narrative?: Record<string, unknown>;
}

export interface SnapshotPayload {
  candidate: { email: string; livingcv_url: string };
  career_packet: PublicCareerPacket;
  capabilities: Array<{ competency: string; evidence_count: number; story_ids: string[] }>;
  packet_hash: string;
  packet_version: number;
  broadcast_at: string;
}

export interface SnapshotInput {
  candidate_id: string;
  payload: SnapshotPayload;
  /** embedding[0] MUST be the whole-packet vector. */
  embedding: number[][];
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
 * Compile + sign + POST the snapshot to HireBridge.
 *
 * Steps:
 *   1. Resolve candidate_id from the HireBridge-connected email.
 *   2. Load the public-safe career packet (or seed it from the active
 *      career_packet_json row).
 *   3. Embed the full packet text (section '__packet__' — first row).
 *   4. Aggregate capabilities from story_bank competency_tags.
 *   5. Build payload + envelope, sign payload bytes with ed25519, POST.
 *   6. Log to broadcast_log; update federation_state timestamps.
 */
export async function broadcastSignal(): Promise<BroadcastResult> {
  let snapshotHash = '';
  try {
    const db = getDb();

    // Get active career packet row (JSON blob) — drives packet_hash + version
    // AND is what recruiters retrieve via search_talent, so it must be the
    // public-safe compiled packet (no raw stories/PII beyond identity).
    const packetRow = db
      .prepare(`SELECT version, content FROM career_packet_json WHERE is_active = 1`)
      .get() as any;
    if (!packetRow) {
      return {
        ok: false,
        snapshot_hash: '',
        error: 'No compiled career packet found.',
        fix: 'Run `jobops compile-packet` first (or call compile_career_packet).',
      };
    }

    let packet: PublicCareerPacket;
    try { packet = JSON.parse(packetRow.content); }
    catch {
      return { ok: false, snapshot_hash: '', error: 'Active career_packet_json has malformed content.' };
    }

    // Get cached embeddings. The first row (ordered by id ASC or our explicit
    // __packet__ section) must be the whole-packet vector.
    const embeddingsRows = db
      .prepare(
        `SELECT section, embedding, dim
         FROM embeddings_cache
         WHERE packet_hash = (SELECT content_hash FROM career_packet_json WHERE is_active = 1)
         ORDER BY (section = '__packet__') DESC, id ASC`,
      )
      .all() as any[];
    if (embeddingsRows.length === 0) {
      return {
        ok: false,
        snapshot_hash: '',
        error: 'No cached embeddings found for the active packet.',
        fix: 'Run `jobops compile-packet` then `generate_embeddings` first.',
      };
    }

    const embedder = getEmbedder();
    const expectedDimRow = db
      .prepare(`SELECT hirebridge_expected_dim FROM federation_state WHERE id = 1`)
      .get() as any;
    const expectedDim: number = expectedDimRow?.hirebridge_expected_dim ?? 384;

    // Dim gate: refuse to send a snapshot that would fail to embed on the server.
    const firstVecDim = (embeddingsRows[0].embedding as string).length === 0
      ? 0
      : (JSON.parse(embeddingsRows[0].embedding) as number[]).length;
    if (firstVecDim !== expectedDim) {
      return {
        ok: false,
        snapshot_hash: '',
        error:
          `Embedding dim mismatch: provider produced ${firstVecDim}-dim (model=${embedder.name}/${embedder.model}), ` +
          `HireBridge expects ${expectedDim}-dim.`,
        fix:
          'Set JOBOPS_EMBEDDING_MODEL to a model whose dim matches HB_EMBED_DIM ' +
          `(e.g. all-MiniLM-L6-v2 → 384 for the local provider), ` +
          'or run HireBridge with a matching HB_EMBED_DIM.',
      };
    }

    const embedding: number[][] = embeddingsRows.map((r) => JSON.parse(r.embedding));

    // Aggregate capabilities from story_bank competency_tags.
    const capabilityMap = new Map<string, { count: number; story_ids: string[] }>();
    const storyRows = db
      .prepare(`SELECT id, competency_tags FROM story_bank WHERE competency_tags IS NOT NULL`)
      .all() as any[];
    for (const row of storyRows) {
      const tags: string[] = JSON.parse(row.competency_tags);
      for (const tag of tags) {
        const cur = capabilityMap.get(tag) || { count: 0, story_ids: [] };
        cur.count += 1;
        cur.story_ids.push(row.id);
        capabilityMap.set(tag, cur);
      }
    }
    const capabilities = Array.from(capabilityMap.entries()).map(([competency, data]) => ({
      competency,
      evidence_count: data.count,
      story_ids: data.story_ids,
    }));

    // Identity / contact surface.
    const state = db
      .prepare(
        `SELECT hirebridge_email, hirebridge_public_key, hirebridge_private_key, hirebridge_node_id
         FROM federation_state WHERE id = 1`,
      )
      .get() as any;

    const email = state?.hirebridge_email
      || process.env.JOBOPS_HIREBRIDGE_EMAIL
      || '';
    const livingcvUrl = (process.env.JOBOPS_LIVINGCV_URL || '').trim();

    if (!email) {
      return {
        ok: false,
        snapshot_hash: '',
        error: 'No HireBridge email recorded.',
        fix: 'Run `jobops connect_to_hirebridge` first.',
      };
    }

    const packetHashRow = db
      .prepare(`SELECT content_hash FROM career_packet_json WHERE is_active = 1`)
      .get() as any;
    const packetHash = packetHashRow?.content_hash || '';

    const payload: SnapshotPayload = {
      candidate: { email, livingcv_url: livingcvUrl },
      career_packet: packet,
      capabilities,
      packet_hash: packetHash,
      packet_version: packetRow.version,
      broadcast_at: new Date().toISOString(),
    };

    // Sign the EXACT JSON bytes we transmit for `payload` — server uses
    // json.RawMessage so byte-identical serialization matters. We pre-stringify
    // once, sign that Buffer, then assemble the envelope around it (so the
    // payload field in the wire body is byte-identical to what was signed).
    const signature = signPayloadBytes(payload, state?.hirebridge_private_key);

    const envelope: SnapshotInput = {
      candidate_id: candidateIdFor(email),
      payload,
      embedding,
      signature,
    };

    const wireBody = JSON.stringify(envelope);
    snapshotHash = createHash('sha256').update(wireBody, 'utf-8').digest('hex');

    const post = await postSnapshot(envelope);

    if (post.ok) {
      await runInWriteLock(() => {
        getDb()
          .prepare(
            `UPDATE federation_state SET hirebridge_last_broadcast = CURRENT_TIMESTAMP, hirebridge_last_error = NULL WHERE id = 1`,
          )
          .run();
      });
      await runInWriteLock(() => {
        getDb()
          .prepare(
            `INSERT INTO broadcast_log (id, snapshot_hash, hirebridge_response, status) VALUES (?, ?, ?, 'sent')`,
          )
          .run(
            createHash('sha256').update(snapshotHash + Date.now()).digest('hex').slice(0, 32),
            snapshotHash,
            JSON.stringify(post.response ?? {}),
          );
      });
      return {
        ok: true,
        snapshot_hash: snapshotHash,
        response: post.response,
      };
    }

    await runInWriteLock(() => {
      getDb()
        .prepare(`UPDATE federation_state SET hirebridge_last_error = ? WHERE id = 1`)
        .run(post.error ?? `HTTP ${post.status}`);
    });
    await runInWriteLock(() => {
      getDb()
        .prepare(
          `INSERT INTO broadcast_log (id, snapshot_hash, error, status) VALUES (?, ?, ?, 'error')`,
        )
      .run(
        createHash('sha256').update(snapshotHash + Date.now()).digest('hex').slice(0, 32),
        snapshotHash,
        post.error ?? `HTTP ${post.status}`,
      );
    });
    return { ok: false, snapshot_hash: snapshotHash, error: post.error, fix: post.fix };
  } catch (e: any) {
    return {
      ok: false,
      snapshot_hash: snapshotHash,
      error: e?.message ?? String(e),
      fix: e?.message?.includes('compile') || e?.message?.includes('embedding')
        ? 'Run compile_career_packet and generate_embeddings first.'
        : undefined,
    };
  }
}

/**
 * Build the envelope WITHOUT posting — used by the unit tests to verify the
 * signature independently with the persisted public_key.
 */
export async function buildSnapshot(): Promise<SnapshotInput> {
  const db = getDb();
  const packetRow = db
    .prepare(`SELECT version, content, content_hash FROM career_packet_json WHERE is_active = 1`)
    .get() as any;
  if (!packetRow) throw new Error('No compiled career packet found.');
  const packet: PublicCareerPacket = JSON.parse(packetRow.content);

  const embeddingsRows = db
    .prepare(
      `SELECT section, embedding
       FROM embeddings_cache
       WHERE packet_hash = ?
       ORDER BY (section = '__packet__') DESC, id ASC`,
    )
    .all(packetRow.content_hash) as any[];
  if (embeddingsRows.length === 0) throw new Error('No cached embeddings for active packet.');

  const state = db
    .prepare(
      `SELECT hirebridge_email, hirebridge_private_key FROM federation_state WHERE id = 1`,
    )
    .get() as any;

  const email = state?.hirebridge_email || process.env.JOBOPS_HIREBRIDGE_EMAIL || '';
  if (!email) throw new Error('No HireBridge email recorded.');

  const capabilities: SnapshotPayload['capabilities'] = [];
  const storyRows = db
    .prepare(`SELECT id, competency_tags FROM story_bank WHERE competency_tags IS NOT NULL`)
    .all() as any[];
  const cap = new Map<string, { count: number; story_ids: string[] }>();
  for (const row of storyRows) {
    for (const tag of (JSON.parse(row.competency_tags) as string[])) {
      const cur = cap.get(tag) || { count: 0, story_ids: [] };
      cur.count += 1;
      cur.story_ids.push(row.id);
      cap.set(tag, cur);
    }
  }
  for (const [competency, data] of cap.entries()) {
    capabilities.push({ competency, evidence_count: data.count, story_ids: data.story_ids });
  }

  const livingcvUrl = (process.env.JOBOPS_LIVINGCV_URL || '').trim();
  const payload: SnapshotPayload = {
    candidate: { email, livingcv_url: livingcvUrl },
    career_packet: packet,
    capabilities,
    packet_hash: packetRow.content_hash,
    packet_version: packetRow.version,
    broadcast_at: '2025-01-01T00:00:00.000Z',  // fixed for tests
  };
  const signature = signPayloadBytes(payload, state?.hirebridge_private_key);
  return {
    candidate_id: candidateIdFor(email),
    payload,
    embedding: embeddingsRows.map((r) => JSON.parse(r.embedding)),
    signature,
  };
}

// ── Signing ───────────────────────────────────────────────────────────────────

/**
 * ed25519 signature over the exact JSON bytes of `payload` (no whitespace,
 * key order preserved). The wire body embeds the same payload object
 * directly, so V8 + Go's json.RawMessage on the server produce byte-identical
 * representations and verification succeeds.
 *
 * privateKeyHex must be 64 chars (raw 32-byte ed25519 seed). When omitted
 * (e.g. tests), the persisted keypair is loaded.
 */
export function signPayloadBytes(payload: SnapshotPayload, privateKeyHex?: string): string {
  const hex = privateKeyHex ?? loadOrCreateIdentity().private_key;
  // We persist the raw 32-byte seed in hex (matches the public_key format
  // per the contract). Node needs the full PKCS#8 DER wrapper to instantiate
  // a sign-able KeyObject — reassemble it from the fixed RFC 8410 prefix.
  const der = ed25519RawSeedToPkcs8Der(hex);
  const keyObj = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  // sign(null, ...) → uses the key's algorithm → ed25519 for an ed25519 key.
  return signCrypto(null, Buffer.from(JSON.stringify(payload), 'utf-8'), keyObj).toString('hex');
}

// Re-export so the MCP tool surface stays identical to v1 callers.
export type { ClientBroadcastResult };

// Back-compat shim for any callers that imported the v1 builder. Returns the
// new envelope's payload + envelope wrapped so older test imports keep working.
export async function compileSignalSnapshot(): Promise<SnapshotInput> {
  return buildSnapshot();
}
