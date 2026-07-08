// Feature 1: Canonical Career Packet Sync
//   Tests for compileCareerPacketJson + mapSkillsToLightcast.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let sandbox;
before(async () => {
  sandbox = mkdtempSync(join(tmpdir(), 'jobops-career-packet-'));
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
- Led team of 5 engineers

## Projects & Open Source

- **TestProject** — A test project description

## Education

- **BS Computer Science**, Test University — Graduated with honors (2019)

## Skills

- **Languages:** Python, TypeScript, Go
- **Frameworks:** React, Node.js
`;
  writeFileSync(join(sandbox, 'cv.md'), cvContent);

  // Create minimal profile.yml
  mkdirSync(join(sandbox, 'config'), { recursive: true });
  const profileContent = `candidate:
  full_name: Test User
  email: test@example.com
  phone: "+1234567890"
  location: San Francisco, CA
  linkedin: linkedin.com/in/testuser
  github: github.com/testuser

target_roles:
  primary:
    - Senior Software Engineer
  archetypes:
    - name: AI/ML Engineer
      level: Senior
      fit: primary

taglines:
  "AI/ML Engineer": "builds intelligent systems"

narrative:
  headline: Test headline
  superpowers:
    - leadership
    - technical depth
  likes:
    - clean code
  dislikes:
    - legacy systems
  proof_points:
    - name: Test Project
      url: https://example.com
      hero_metric: 10x improvement

compensation:
  target_range: "$150K-$200K"
  currency: USD
  minimum: "$140K"
  location_flexibility: Remote preferred
`;
  writeFileSync(join(sandbox, 'config', 'profile.yml'), profileContent);

  // Initialize DB
  const { getDb } = await import('../dist/db.js');
  getDb();
});

after(() => {
  if (sandbox) rmSync(sandbox, { recursive: true, force: true });
});

// ── compileCareerPacketJson ──────────────────────────────────────────────────

test('compileCareerPacketJson produces valid JSON Resume superset', async () => {
  const { compileCareerPacketJson } = await import('../dist/core/career_packet_json.js');

  const result = await compileCareerPacketJson({ lightcastMode: 'skip' });

  // Check structure
  assert.equal(result.content.schema, 'jobops-federation-1.0');
  assert.ok(result.content.meta.version >= 1);
  assert.ok(result.content.meta.generated_at);
  assert.ok(result.content_hash);
  assert.ok(result.file_path.endsWith('career-packet.json'));

  // Check basics
  assert.equal(result.content.basics.name, 'Test User');
  assert.equal(result.content.basics.email, 'test@example.com');
  assert.equal(result.content.basics.location.city, 'San Francisco, CA');

  // Check target_roles
  assert.deepEqual(result.content.target_roles.primary, ['Senior Software Engineer']);
  assert.equal(result.content.target_roles.archetypes[0].name, 'AI/ML Engineer');

  // Check work
  assert.ok(result.content.work.length >= 1);
  assert.equal(result.content.work[0].company, 'TestCorp');
  assert.equal(result.content.work[0].position, 'Senior Engineer');
  assert.ok(result.content.work[0].bullets.length >= 1);

  // Check skills
  assert.ok(result.content.skills.length >= 1);
  const langCat = result.content.skills.find(s => s.category === 'Languages');
  assert.ok(langCat);
  assert.ok(langCat.items.length >= 3);

  // Check file was written
  const fileContent = readFileSync(result.file_path, 'utf-8');
  const parsed = JSON.parse(fileContent);
  assert.equal(parsed.schema, 'jobops-federation-1.0');
});

test('compileCareerPacketJson with lightcastMode=skip leaves skills unmapped', async () => {
  const { compileCareerPacketJson } = await import('../dist/core/career_packet_json.js');

  const result = await compileCareerPacketJson({ lightcastMode: 'skip' });

  // Skills should have lightcast_id: null
  for (const cat of result.content.skills) {
    for (const item of cat.items) {
      assert.equal(item.lightcast_id, null);
      assert.equal(item.confidence, 0);
    }
  }
  assert.equal(result.content.meta.lightcast_mapped, false);
});

test('compileCareerPacketJson includes evidence from story_bank', async () => {
  const { getDb, runInWriteLock } = await import('../dist/db.js');
  const { randomUUID } = await import('node:crypto');

  // Insert a test story
  await runInWriteLock(() => {
    getDb().prepare(`
      INSERT INTO story_bank (id, job_id, story_text, reflection, competency_tags)
      VALUES (?, NULL, ?, ?, ?)
    `).run(
      randomUUID(),
      'Led migration of legacy system to modern architecture',
      'This taught me the importance of incremental migration',
      JSON.stringify(['leadership', 'systems design']),
    );
  });

  const { compileCareerPacketJson } = await import('../dist/core/career_packet_json.js');
  const result = await compileCareerPacketJson({ lightcastMode: 'skip' });

  // Evidence should include the story
  assert.ok(result.content.evidence.length >= 1);
  const story = result.content.evidence.find(e => e.story_text.includes('legacy system'));
  assert.ok(story);
  assert.deepEqual(story.competency_tags, ['leadership', 'systems design']);
});

// ── mapSkillsToLightcast ─────────────────────────────────────────────────────

test('mapSkillsToLightcast returns unmapped when no LLM available', async () => {
  // Ensure no LLM is configured
  const origProvider = process.env.JOBOPS_LLM_PROVIDER;
  process.env.JOBOPS_LLM_PROVIDER = 'none';

  try {
    const { mapSkillsToLightcast } = await import('../dist/core/lightcast.js');
    const result = await mapSkillsToLightcast(['Python', 'TypeScript']);

    assert.equal(result.length, 2);
    for (const mapping of result) {
      assert.equal(mapping.lightcast_id, null);
      assert.equal(mapping.confidence, 0);
    }
  } finally {
    if (origProvider) {
      process.env.JOBOPS_LLM_PROVIDER = origProvider;
    } else {
      delete process.env.JOBOPS_LLM_PROVIDER;
    }
  }
});

test('mapSkillsToLightcast handles empty input', async () => {
  const { mapSkillsToLightcast } = await import('../dist/core/lightcast.js');
  const result = await mapSkillsToLightcast([]);
  assert.deepEqual(result, []);
});
