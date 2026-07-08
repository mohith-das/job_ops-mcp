// Feature 3: Edge Embedding Generation
//   Tests for embedPacket + getEmbedder.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let sandbox;
before(async () => {
  sandbox = mkdtempSync(join(tmpdir(), 'jobops-embeddings-'));
  process.env.JOBOPS_DATA_DIR = sandbox;
  process.env.JOBOPS_OUTPUT_DIR = join(sandbox, 'output');
  process.env.JOBOPS_PROJECT_ROOT = sandbox;

  // Create minimal cv.md
  const cvContent = `# CV — Test User

**Location:** San Francisco, CA
**Email:** test@example.com

## Professional Summary
Test professional summary.

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

// ── getEmbedder ───────────────────────────────────────────────────────────────

test('getEmbedder returns NoneEmbedder when provider is "none"', async () => {
  const origProvider = process.env.JOBOPS_EMBEDDING_PROVIDER;
  process.env.JOBOPS_EMBEDDING_PROVIDER = 'none';

  try {
    const { getEmbedder, resetEmbedderCache } = await import('../dist/core/embeddings.js');
    resetEmbedderCache();
    const embedder = getEmbedder();
    assert.equal(embedder.name, 'none');
    assert.equal(embedder.dim, 0);
  } finally {
    if (origProvider) {
      process.env.JOBOPS_EMBEDDING_PROVIDER = origProvider;
    } else {
      delete process.env.JOBOPS_EMBEDDING_PROVIDER;
    }
  }
});

test('getEmbedder returns LocalEmbedder when provider is "local"', async () => {
  const origProvider = process.env.JOBOPS_EMBEDDING_PROVIDER;
  process.env.JOBOPS_EMBEDDING_PROVIDER = 'local';

  try {
    const { getEmbedder, resetEmbedderCache } = await import('../dist/core/embeddings.js');
    resetEmbedderCache();
    const embedder = getEmbedder();
    assert.equal(embedder.name, 'local');
    assert.equal(embedder.dim, 384);
  } finally {
    if (origProvider) {
      process.env.JOBOPS_EMBEDDING_PROVIDER = origProvider;
    } else {
      delete process.env.JOBOPS_EMBEDDING_PROVIDER;
    }
  }
});

test('NoneEmbedder throws on embed()', async () => {
  const origProvider = process.env.JOBOPS_EMBEDDING_PROVIDER;
  process.env.JOBOPS_EMBEDDING_PROVIDER = 'none';

  try {
    const { getEmbedder, resetEmbedderCache } = await import('../dist/core/embeddings.js');
    resetEmbedderCache();
    const embedder = getEmbedder();
    await assert.rejects(() => embedder.embed(['test']), /No embedding provider configured/);
  } finally {
    if (origProvider) {
      process.env.JOBOPS_EMBEDDING_PROVIDER = origProvider;
    } else {
      delete process.env.JOBOPS_EMBEDDING_PROVIDER;
    }
  }
});

// ── embedPacket ───────────────────────────────────────────────────────────────

test('embedPacket throws when no embedding provider configured', async () => {
  const origProvider = process.env.JOBOPS_EMBEDDING_PROVIDER;
  process.env.JOBOPS_EMBEDDING_PROVIDER = 'none';

  try {
    const { embedPacket, resetEmbedderCache } = await import('../dist/core/embeddings.js');
    resetEmbedderCache();

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

    await assert.rejects(() => embedPacket(packet), /No embedding provider configured/);
  } finally {
    if (origProvider) {
      process.env.JOBOPS_EMBEDDING_PROVIDER = origProvider;
    } else {
      delete process.env.JOBOPS_EMBEDDING_PROVIDER;
    }
  }
});
