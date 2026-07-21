// Feature 2: Local Sync to LivingCV
//   Tests for syncToLivingCV.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';

let sandbox;
before(async () => {
  sandbox = mkdtempSync(join(tmpdir(), 'jobops-sync-'));
  process.env.JOBOPS_DATA_DIR = sandbox;
  process.env.JOBOPS_OUTPUT_DIR = join(sandbox, 'output');
  process.env.JOBOPS_PROJECT_ROOT = sandbox;

  // Create minimal cv.md
  const cvContent = `# CV — Test User

**Location:** San Francisco, CA
**Email:** test@example.com

## Work Experience

### TestCorp — Senior Engineer
Remote · Jan 2020 – Present

- Built scalable systems

## Skills

- **Languages:** Python, TypeScript
`;
  writeFileSync(join(sandbox, 'cv.md'), cvContent);

  // Create minimal profile.yml
  mkdirSync(join(sandbox, 'config'), { recursive: true });
  const profileContent = `candidate:
  full_name: Test User
  email: test@example.com
`;
  writeFileSync(join(sandbox, 'config', 'profile.yml'), profileContent);

  // Initialize DB
  const { getDb } = await import('../dist/db.js');
  getDb();
});

after(() => {
  if (sandbox) rmSync(sandbox, { recursive: true, force: true });
});

// ── syncToLivingCV ────────────────────────────────────────────────────────────

const minimalPacket = () => ({
  schema: 'jobops-federation-1.0',
  meta: { version: 1, generated_at: new Date().toISOString(), source_cv_hash: null, source_packet_version: null, lightcast_mapped: false },
  basics: { name: 'Test', email: '', phone: '', location: { city: '', country: '', timezone: '' }, linkedin: '', github: '', portfolio: '', summary: '', headline: '' },
  target_roles: { primary: [], archetypes: [] },
  taglines: {},
  work: [],
  projects: [],
  education: [],
  skills: [],
  evidence: [],
  compensation: { target_range: '', currency: 'USD', minimum: '', location_flexibility: '' },
  narrative: { superpowers: [], likes: [], dislikes: [], proof_points: [] },
});

test('syncToLivingCV returns error when no URL configured (contract v1: URL is unset by default)', async () => {
  const origToken = process.env.JOBOPS_LIVINGCV_TOKEN;
  const origUrl   = process.env.JOBOPS_LIVINGCV_URL;
  delete process.env.JOBOPS_LIVINGCV_TOKEN;
  delete process.env.JOBOPS_LIVINGCV_URL;

  try {
    const { syncToLivingCV } = await import('../dist/core/livingcv_client.js');
    const result = await syncToLivingCV(minimalPacket());
    assert.equal(result.ok, false);
    assert.match(result.error, /JOBOPS_LIVINGCV_URL is not set/);
    assert.ok(result.fix);
    assert.match(result.fix, /JOBOPS_LIVINGCV_URL/);
  } finally {
    if (origToken !== undefined) process.env.JOBOPS_LIVINGCV_TOKEN = origToken;
    if (origUrl   !== undefined) process.env.JOBOPS_LIVINGCV_URL   = origUrl;
  }
});

test('syncToLivingCV returns error when neither product sync nor legacy MCP is provisioned', async () => {
  const origToken = process.env.JOBOPS_LIVINGCV_TOKEN;
  const origUrl   = process.env.JOBOPS_LIVINGCV_URL;
  delete process.env.JOBOPS_LIVINGCV_TOKEN;
  delete process.env.JOBOPS_LIVINGCV_INTERNAL_SECRET;
  process.env.JOBOPS_LIVINGCV_URL = 'http://127.0.0.1:7891';  // URL is set, token is the missing piece

  try {
    const { syncToLivingCV } = await import('../dist/core/livingcv_client.js');
    const result = await syncToLivingCV(minimalPacket());
    assert.equal(result.ok, false);
    assert.match(result.error, /product sync is not provisioned/);
    assert.ok(result.fix);
    assert.match(result.fix, /INTERNAL_SECRET|legacy MCP/i);
  } finally {
    if (origToken !== undefined) process.env.JOBOPS_LIVINGCV_TOKEN = origToken;
    else                          delete process.env.JOBOPS_LIVINGCV_TOKEN;
    if (origUrl   !== undefined) process.env.JOBOPS_LIVINGCV_URL = origUrl;
    else                          delete process.env.JOBOPS_LIVINGCV_URL;
  }
});

test('integrated product sync forwards the unified user approval without an MCP key', async () => {
  const originalFetch = globalThis.fetch;
  const origToken = process.env.JOBOPS_LIVINGCV_TOKEN;
  const origSecret = process.env.JOBOPS_LIVINGCV_INTERNAL_SECRET;
  const origUrl = process.env.JOBOPS_LIVINGCV_URL;
  delete process.env.JOBOPS_LIVINGCV_TOKEN;
  process.env.JOBOPS_LIVINGCV_INTERNAL_SECRET = 'service-provisioned-secret';
  process.env.JOBOPS_LIVINGCV_URL = 'http://livingcv.internal';
  let received;
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), 'http://livingcv.internal/api/internal/jobops-sync');
    assert.equal(init.headers['x-jobops-sync-secret'], 'service-provisioned-secret');
    received = JSON.parse(init.body);
    return Response.json({ stored: true, approved: true, published: 1 });
  };
  try {
    const { syncToLivingCV } = await import('../dist/core/livingcv_client.js');
    const result = await syncToLivingCV(minimalPacket(), false, { approvedByUser: true, proposalId: 'proposal-123' });
    assert.equal(result.ok, true);
    assert.equal(received.approved_by_user, true);
    assert.equal(received.proposal_id, 'proposal-123');
    assert.equal(received.packet.identity.fullName, 'Test');
  } finally {
    globalThis.fetch = originalFetch;
    if (origToken === undefined) delete process.env.JOBOPS_LIVINGCV_TOKEN; else process.env.JOBOPS_LIVINGCV_TOKEN = origToken;
    if (origSecret === undefined) delete process.env.JOBOPS_LIVINGCV_INTERNAL_SECRET; else process.env.JOBOPS_LIVINGCV_INTERNAL_SECRET = origSecret;
    if (origUrl === undefined) delete process.env.JOBOPS_LIVINGCV_URL; else process.env.JOBOPS_LIVINGCV_URL = origUrl;
  }
});

test('integrated product sync times out, aborts the request, and remains retryable', async () => {
  const origToken = process.env.JOBOPS_LIVINGCV_TOKEN;
  const origSecret = process.env.JOBOPS_LIVINGCV_INTERNAL_SECRET;
  const origUrl = process.env.JOBOPS_LIVINGCV_URL;
  const origTimeout = process.env.JOBOPS_LIVINGCV_TIMEOUT_MS;
  let connectionClosed = false;
  const stalled = createServer((_req, res) => {
    res.on('close', () => { connectionClosed = true; });
    // Deliberately never complete the response.
  });
  await new Promise((resolve) => stalled.listen(0, '127.0.0.1', resolve));

  delete process.env.JOBOPS_LIVINGCV_TOKEN;
  process.env.JOBOPS_LIVINGCV_INTERNAL_SECRET = 'service-provisioned-secret';
  process.env.JOBOPS_LIVINGCV_URL = `http://127.0.0.1:${stalled.address().port}`;
  process.env.JOBOPS_LIVINGCV_TIMEOUT_MS = '100';

  try {
    const { syncToLivingCV } = await import('../dist/core/livingcv_client.js');
    const started = Date.now();
    const result = await syncToLivingCV(minimalPacket());
    assert.equal(result.ok, false);
    assert.match(result.error, /LivingCV internal sync timed out after 100ms/);
    assert.match(result.fix, /did not respond in time/i);
    assert.ok(Date.now() - started < 2_000, 'timeout should return promptly');
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(connectionClosed, true, 'AbortController should close the stalled HTTP request');
  } finally {
    stalled.closeAllConnections();
    await new Promise((resolve) => stalled.close(resolve));
    if (origToken === undefined) delete process.env.JOBOPS_LIVINGCV_TOKEN; else process.env.JOBOPS_LIVINGCV_TOKEN = origToken;
    if (origSecret === undefined) delete process.env.JOBOPS_LIVINGCV_INTERNAL_SECRET; else process.env.JOBOPS_LIVINGCV_INTERNAL_SECRET = origSecret;
    if (origUrl === undefined) delete process.env.JOBOPS_LIVINGCV_URL; else process.env.JOBOPS_LIVINGCV_URL = origUrl;
    if (origTimeout === undefined) delete process.env.JOBOPS_LIVINGCV_TIMEOUT_MS; else process.env.JOBOPS_LIVINGCV_TIMEOUT_MS = origTimeout;
  }
});

test('syncToLivingCV returns error when LivingCV is unreachable', async () => {
  const origToken = process.env.JOBOPS_LIVINGCV_TOKEN;
  const origUrl   = process.env.JOBOPS_LIVINGCV_URL;
  process.env.JOBOPS_LIVINGCV_TOKEN = 'test-token';
  // Use a valid URL syntax but a port the OS refuses to connect to (closed on the test box).
  // 7891 is jobops's own port; if the test box has no instance running, ECONNREFUSED is raised.
  process.env.JOBOPS_LIVINGCV_URL = 'http://127.0.0.1:7891';

  try {
    const { syncToLivingCV } = await import('../dist/core/livingcv_client.js');
    const result = await syncToLivingCV(minimalPacket());
    assert.equal(result.ok, false);
    assert.match(result.error, /(Sync to LivingCV failed|Connection failed|ECONNREFUSED|fetch failed|getaddrinfo)/);
    assert.ok(result.fix);
  } finally {
    if (origToken !== undefined) process.env.JOBOPS_LIVINGCV_TOKEN = origToken;
    else                          delete process.env.JOBOPS_LIVINGCV_TOKEN;
    if (origUrl   !== undefined) process.env.JOBOPS_LIVINGCV_URL = origUrl;
    else                          delete process.env.JOBOPS_LIVINGCV_URL;
  }
});

test('syncToLivingCV times out and releases a stalled SSE connection', async () => {
  const origToken = process.env.JOBOPS_LIVINGCV_TOKEN;
  const origUrl = process.env.JOBOPS_LIVINGCV_URL;
  const origTimeout = process.env.JOBOPS_LIVINGCV_TIMEOUT_MS;
  const stalled = createServer((_req, _res) => {
    // Deliberately never send the SSE response headers or endpoint event.
  });
  await new Promise((resolve) => stalled.listen(0, '127.0.0.1', resolve));

  process.env.JOBOPS_LIVINGCV_TOKEN = 'test-token';
  process.env.JOBOPS_LIVINGCV_URL = `http://127.0.0.1:${stalled.address().port}`;
  process.env.JOBOPS_LIVINGCV_TIMEOUT_MS = '100';

  try {
    const { syncToLivingCV } = await import('../dist/core/livingcv_client.js');
    const started = Date.now();
    const result = await syncToLivingCV(minimalPacket());
    assert.equal(result.ok, false);
    assert.match(result.error, /LivingCV connection timed out after 100ms/);
    assert.match(result.fix, /did not respond in time/i);
    assert.ok(Date.now() - started < 2_000, 'timeout should return promptly');
  } finally {
    stalled.closeAllConnections();
    await new Promise((resolve) => stalled.close(resolve));
    if (origToken === undefined) delete process.env.JOBOPS_LIVINGCV_TOKEN; else process.env.JOBOPS_LIVINGCV_TOKEN = origToken;
    if (origUrl === undefined) delete process.env.JOBOPS_LIVINGCV_URL; else process.env.JOBOPS_LIVINGCV_URL = origUrl;
    if (origTimeout === undefined) delete process.env.JOBOPS_LIVINGCV_TIMEOUT_MS; else process.env.JOBOPS_LIVINGCV_TIMEOUT_MS = origTimeout;
  }
});
