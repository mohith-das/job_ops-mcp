// Canonical Federation Contract v1 — snapshot envelope + signature tests.
//
// Verifies that `buildSnapshot()` produces an envelope whose ed25519 signature
// covers the EXACT transmitted payload bytes AND verifies against the
// persisted public_key (using Node's crypto.verify). Then end-to-end with the
// in-process mock HireBridge /ingest/snapshot server, asserting the wire
// body matches the same byte sequence the server sees.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createPublicKey, verify as cryptoVerify } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let sandbox;
before(async () => {
  sandbox = mkdtempSync(join(tmpdir(), 'jobops-snap-sig-'));
  process.env.JOBOPS_DATA_DIR     = sandbox;
  process.env.JOBOPS_OUTPUT_DIR   = join(sandbox, 'output');
  process.env.JOBOPS_PROJECT_ROOT = sandbox;

  writeFileSync(join(sandbox, 'cv.md'), '# CV — Test\n\n## Skills\n- TypeScript\n');
  mkdirSync(join(sandbox, 'config'), { recursive: true });
  writeFileSync(join(sandbox, 'config', 'profile.yml'),
    'candidate:\n  full_name: Test User\n  email: test@example.com\n');
  process.env.JOBOPS_HIREBRIDGE_EMAIL = 'Test@Example.com';  // mixed-case to test normalisation

  const { getDb } = await import('../dist/db.js');
  getDb();
  const { compileCareerPacketJson } = await import('../dist/core/career_packet_json.js');
  await compileCareerPacketJson({ lightcastMode: 'skip' });
  const { embedPacket, resetEmbedderCache } = await import('../dist/core/embeddings.js');
  // Force a deterministic, fixed-dim stub embedder so we don't need a 90MB model.
  const origProvider = process.env.JOBOPS_EMBEDDING_PROVIDER;
  process.env.JOBOPS_EMBEDDING_PROVIDER = 'none';
  resetEmbedderCache();
  // Inject a fake embedding row directly for the unit tests — keeps the test
  // deterministic and offline. The broadcast path uses section '__packet__'.
  const { runInWriteLock } = await import('../dist/db.js');
  runInWriteLock(() => {
    const packetRow = getDb()
      .prepare(`SELECT content_hash FROM career_packet_json WHERE is_active = 1`).get();
    if (packetRow) {
      const fake = Array.from({ length: 4 }, (_, i) => 0.1 + i * 0.01); // 4-dim placeholder
      getDb()
        .prepare(`INSERT OR REPLACE INTO embeddings_cache (id, packet_hash, section, embedding, model, dim) VALUES (?, ?, '__packet__', ?, 'test-stub', 4)`)
        .run('test-embed-id', packetRow.content_hash, JSON.stringify(fake));
    }
  });
  if (origProvider !== undefined) process.env.JOBOPS_EMBEDDING_PROVIDER = origProvider;
  resetEmbedderCache();

  // Generate a keypair so we have a known public_key to verify against.
  const { loadOrCreateIdentity } = await import('../dist/core/hirebridge_client.js');
  loadOrCreateIdentity();
  // Stamp a fake email + node_id (buildSnapshot reads these from the row).
  const { runInWriteLock: w } = await import('../dist/db.js');
  w(() => {
    getDb()
      .prepare(`UPDATE federation_state SET hirebridge_email = ?, hirebridge_node_id = ? WHERE id = 1`)
      .run('test@example.com', 'node-test-xyz');
  });
});
after(() => { if (sandbox) rmSync(sandbox, { recursive: true, force: true }); });

test('candidateIdFor = first 32 hex chars of sha256(lowercase(trim(email)))', async () => {
  const { candidateIdFor } = await import('../dist/core/hirebridge_client.js');
  const id1 = candidateIdFor('  Test@Example.COM  ');
  const id2 = candidateIdFor('test@example.com');
  assert.equal(id1, id2);
  assert.equal(id1.length, 32);
  assert.equal(id1, createHash('sha256').update('test@example.com', 'utf-8').digest('hex').slice(0, 32));
});

test('buildSnapshot produces candidate_id, embedding[0]=whole-packet, signature verifies against public_key', async () => {
  const { buildSnapshot } = await import('../dist/core/signal_broadcast.js');
  const { loadOrCreateIdentity } = await import('../dist/core/hirebridge_client.js');
  const env = await buildSnapshot();
  // Sanity: shape.
  assert.equal(env.candidate_id.length, 32);
  assert.ok(Array.isArray(env.embedding) && env.embedding.length >= 1);
  assert.equal(typeof env.signature, 'string');
  assert.match(env.signature, /^[0-9a-f]+$/);
  // The signature MUST verify against the persisted public_key over the EXACT
  // transmitted payload bytes. Build a SPKI public key from the JWK x field.
  const identity = loadOrCreateIdentity();
  const pubJwk = {
    kty: 'OKP', crv: 'Ed25519', alg: 'EdDSA', use: 'sig',
    x: Buffer.from(identity.public_key, 'hex').toString('base64url'),
  };
  const pubKeyObj = createPublicKey({ key: pubJwk, format: 'jwk' });
  const payloadBytes = Buffer.from(JSON.stringify(env.payload), 'utf-8');
  const sigBytes = Buffer.from(env.signature, 'hex');
  const ok = cryptoVerify(null, payloadBytes, pubKeyObj, sigBytes);
  assert.equal(ok, true, 'signature must verify with the persisted public_key');
});

test('signature is bound to the exact payload — mutating any byte invalidates it', async () => {
  const { buildSnapshot } = await import('../dist/core/signal_broadcast.js');
  const { loadOrCreateIdentity } = await import('../dist/core/hirebridge_client.js');
  const env = await buildSnapshot();
  const identity = loadOrCreateIdentity();
  const pubJwk = {
    kty: 'OKP', crv: 'Ed25519', alg: 'EdDSA', use: 'sig',
    x: Buffer.from(identity.public_key, 'hex').toString('base64url'),
  };
  const pubKeyObj = createPublicKey({ key: pubJwk, format: 'jwk' });

  // Build a tampered copy of the payload.
  const tampered = JSON.parse(JSON.stringify(env.payload));
  tampered.capabilities = tampered.capabilities || [];
  tampered.capabilities.push({ competency: 'injected', evidence_count: 1, story_ids: ['x'] });
  const tamperedBytes = Buffer.from(JSON.stringify(tampered), 'utf-8');
  const sigBytes = Buffer.from(env.signature, 'hex');
  const ok = cryptoVerify(null, tamperedBytes, pubKeyObj, sigBytes);
  assert.equal(ok, false, 'mutating payload bytes MUST break the signature');
});

test('postSnapshot sends the envelope to /ingest/snapshot and bearer auth header', async () => {
  process.env.JOBOPS_HIREBRIDGE_TOKEN = 'hb-bearer-token';
  const { postSnapshot } = await import('../dist/core/hirebridge_client.js');

  let received;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c.toString('utf-8'); });
    req.on('end', () => {
      received = {
        url:    req.url,
        method: req.method,
        auth:   req.headers.authorization,
        ct:     req.headers['content-type'],
        body,
      };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'accepted', matched: 0 }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;

  try {
    const { buildSnapshot } = await import('../dist/core/signal_broadcast.js');
    const env = await buildSnapshot();
    const post = await postSnapshot(env, url);
    assert.equal(post.ok, true, `expected ok, got ${JSON.stringify(post)}`);
    assert.equal(received.url, '/ingest/snapshot');
    assert.equal(received.method, 'POST');
    assert.equal(received.auth, 'Bearer hb-bearer-token');
    assert.match(received.ct, /application\/json/);
    // The body the SERVER received should be byte-identical to JSON.stringify(env).
    assert.equal(received.body, JSON.stringify(env));
  } finally {
    await new Promise((r) => server.close(() => r()));
    delete process.env.JOBOPS_HIREBRIDGE_TOKEN;
  }
});

test('loadOrCreateIdentity produces 64-char hex keys, stable across calls', async () => {
  const { loadOrCreateIdentity, ed25519RawSeedToPkcs8Der } = await import('../dist/core/hirebridge_client.js');
  // Generate if not yet present.
  const a = loadOrCreateIdentity();
  const b = loadOrCreateIdentity();
  assert.equal(a.public_key,  b.public_key,  'public_key stable across calls');
  assert.equal(a.private_key, b.private_key, 'private_key stable across calls');
  assert.equal(a.public_key.length,  64);
  assert.equal(a.private_key.length, 64);
  // The stored seed must round-trip into a working PKCS#8 DER (otherwise signing fails).
  const der = ed25519RawSeedToPkcs8Der(a.private_key);
  assert.equal(der.length, 48, 'fixed-size Ed25519 PKCS#8 DER is 48 bytes (16 prefix + 32 seed)');
  const { createPrivateKey, sign: signCrypto, verify: verifyCrypto } = await import('node:crypto');
  const pk = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  const pubJwk = {
    kty: 'OKP', crv: 'Ed25519', alg: 'EdDSA', use: 'sig',
    x: Buffer.from(a.public_key, 'hex').toString('base64url'),
  };
  const { createPublicKey } = await import('node:crypto');
  const pub = createPublicKey({ key: pubJwk, format: 'jwk' });
  const sig = signCrypto(null, Buffer.from('round trip'), pk);
  assert.equal(verifyCrypto(null, Buffer.from('round trip'), pub, sig), true);
});
