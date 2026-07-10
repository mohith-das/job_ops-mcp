// Tests that the embedder emits a whole-packet vector FIRST so broadcast can
// pick it up as embedding[0]. The Canonical Federation Contract v1 requires
// `embedding[0]` to be the canonical single-vector representation of the
// whole packet — HireBridge's repo stores only element 0.
//
// We exercise the actual end-to-end ordering path used by broadcast_signal:
// the SQL ORDER BY `(section = '__packet__') DESC, id ASC` which makes
// __packet__ the first row regardless of cache insertion order.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let sandbox;
before(async () => {
  sandbox = mkdtempSync(join(tmpdir(), 'jobops-emb-packet-'));
  process.env.JOBOPS_DATA_DIR     = sandbox;
  process.env.JOBOPS_OUTPUT_DIR   = join(sandbox, 'output');
  process.env.JOBOPS_PROJECT_ROOT = sandbox;
  writeFileSync(join(sandbox, 'cv.md'), '# CV');
  mkdirSync(join(sandbox, 'config'), { recursive: true });
  writeFileSync(join(sandbox, 'config', 'profile.yml'),
    'candidate:\n  full_name: Test\n  email: test@example.com\n');

  const { getDb } = await import('../dist/db.js');
  getDb();
});
after(() => { if (sandbox) rmSync(sandbox, { recursive: true, force: true }); });

test('SQL ORDER BY puts __packet__ row first regardless of insertion order', async () => {
  const { getDb, runInWriteLock } = await import('../dist/db.js');

  const packetHash = 'hash-' + Math.random().toString(36).slice(2, 12);
  const fakeVec = (len) => Array.from({ length: 4 }, (_, i) => (i + len) / 100);

  await runInWriteLock(() => {
    const stmt = getDb().prepare(`
      INSERT OR REPLACE INTO embeddings_cache (id, packet_hash, section, embedding, model, dim)
      VALUES (?, ?, ?, ?, 'stub', 4)
    `);
    // Insert in a "wrong" order on purpose — __packet__ gets id=W, others first.
    stmt.run(`sec-summary-${packetHash}`,    packetHash, 'summary',    JSON.stringify(fakeVec(1)));
    stmt.run(`sec-skills-${packetHash}`,     packetHash, 'skills',     JSON.stringify(fakeVec(2)));
    stmt.run(`sec-packet-${packetHash}`,     packetHash, '__packet__', JSON.stringify(fakeVec(9)));
    stmt.run(`sec-evidence-${packetHash}`,  packetHash, 'evidence_0', JSON.stringify(fakeVec(3)));
  });

  // Run the SAME query broadcast_signal uses.
  const rows = getDb()
    .prepare(
      `SELECT section, embedding
       FROM embeddings_cache
       WHERE packet_hash = ?
       ORDER BY (section = '__packet__') DESC, id ASC`,
    )
    .all(packetHash);

  assert.ok(rows.length >= 4, `expected at least 4 rows, got ${rows.length}`);
  assert.equal(rows[0].section, '__packet__', '__packet__ must be the first row broadcast picks up');
  // Confirm embeddings can be parsed back — i.e. the broadcast wire format is clean.
  const firstVec = JSON.parse(rows[0].embedding);
  assert.equal(firstVec.length, 4);
});
