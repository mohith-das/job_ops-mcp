// Feature 2: Local Sync to LivingCV
//   Tests for syncToLivingCV.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

test('syncToLivingCV returns error when no token configured', async () => {
  const origToken = process.env.JOBOPS_LIVINGCV_TOKEN;
  const origUrl   = process.env.JOBOPS_LIVINGCV_URL;
  delete process.env.JOBOPS_LIVINGCV_TOKEN;
  process.env.JOBOPS_LIVINGCV_URL = 'http://127.0.0.1:7891';  // URL is set, token is the missing piece

  try {
    const { syncToLivingCV } = await import('../dist/core/livingcv_client.js');
    const result = await syncToLivingCV(minimalPacket());
    assert.equal(result.ok, false);
    assert.match(result.error, /JOBOPS_LIVINGCV_TOKEN is not set/);
    assert.ok(result.fix);
    assert.match(result.fix, /master-relay|master_relay|masterKey|master_key|mcp\.master_key/i);
  } finally {
    if (origToken !== undefined) process.env.JOBOPS_LIVINGCV_TOKEN = origToken;
    else                          delete process.env.JOBOPS_LIVINGCV_TOKEN;
    if (origUrl   !== undefined) process.env.JOBOPS_LIVINGCV_URL = origUrl;
    else                          delete process.env.JOBOPS_LIVINGCV_URL;
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
