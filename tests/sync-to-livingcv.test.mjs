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

test('syncToLivingCV returns error when no token configured', async () => {
  const origToken = process.env.JOBOPS_LIVINGCV_TOKEN;
  delete process.env.JOBOPS_LIVINGCV_TOKEN;

  try {
    const { syncToLivingCV } = await import('../dist/core/livingcv_client.js');

    const packet = {
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
    };

    const result = await syncToLivingCV(packet);
    assert.equal(result.ok, false);
    assert.match(result.error, /JOBOPS_LIVINGCV_TOKEN not set/);
    assert.ok(result.fix);
  } finally {
    if (origToken) {
      process.env.JOBOPS_LIVINGCV_TOKEN = origToken;
    }
  }
});

test('syncToLivingCV returns error when LivingCV is unreachable', async () => {
  const origToken = process.env.JOBOPS_LIVINGCV_TOKEN;
  const origUrl = process.env.JOBOPS_LIVINGCV_URL;
  process.env.JOBOPS_LIVINGCV_TOKEN = 'test-token';
  process.env.JOBOPS_LIVINGCV_URL = 'http://127.0.0.1:99999'; // unreachable port

  try {
    const { syncToLivingCV } = await import('../dist/core/livingcv_client.js');

    const packet = {
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
    };

    const result = await syncToLivingCV(packet);
    assert.equal(result.ok, false);
    assert.match(result.error, /Connection failed/);
    assert.ok(result.fix);
  } finally {
    if (origToken) {
      process.env.JOBOPS_LIVINGCV_TOKEN = origToken;
    } else {
      delete process.env.JOBOPS_LIVINGCV_TOKEN;
    }
    if (origUrl) {
      process.env.JOBOPS_LIVINGCV_URL = origUrl;
    } else {
      delete process.env.JOBOPS_LIVINGCV_URL;
    }
  }
});
