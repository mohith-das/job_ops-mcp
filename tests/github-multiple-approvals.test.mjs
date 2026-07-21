import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let sandbox;
let db;
let profile;
let github;
let proposals;
const repos = [
  ['alpha-project', 101],
  ['beta-project', 102],
  ['gamma-project', 103],
  ['delta-project', 104],
].map(([name, id]) => ({
  id, name, full_name: `candidate/${name}`,
  html_url: `https://github.com/candidate/${name}`,
  description: `Evidence for ${name}`,
  private: false, visibility: 'public', fork: false, archived: false,
  default_branch: 'main', pushed_at: '2026-07-15T00:00:00Z', topics: [], homepage: null,
}));

before(async () => {
  sandbox = mkdtempSync(join(tmpdir(), 'jobops-github-multi-'));
  process.env.JOBOPS_DATA_DIR = sandbox;
  process.env.JOBOPS_OUTPUT_DIR = join(sandbox, 'output');
  process.env.JOBOPS_PROJECT_ROOT = sandbox;
  process.env.JOBOPS_GITHUB_USERNAME = 'candidate';
  process.env.JOBOPS_LIVINGCV_URL = 'http://livingcv.internal';
  process.env.JOBOPS_LIVINGCV_INTERNAL_SECRET = 'test-product-secret';
  mkdirSync(join(sandbox, 'config'), { recursive: true });
  writeFileSync(join(sandbox, 'config', 'profile.yml'),
    'candidate:\n  full_name: Candidate\n  email: candidate@example.com\n', 'utf8');
  writeFileSync(join(sandbox, 'cv.md'), `# CV — Candidate
## Work Experience
### Example — Engineer
Remote · 2022 – Present
- Built reliable public software
## Projects & Open Source
- **Existing** — Existing project
## Skills
- **Languages:** TypeScript
## Education
- **BS Computer Science** — Example University (2022)
`, 'utf8');

  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url === 'http://livingcv.internal/api/internal/jobops-sync') {
      return Response.json({ stored: true, approved: true, published: 1 });
    }
    if (url.includes('/users/candidate/repos?')) return Response.json(repos);
    const branchRepo = repos.find(repo => url.endsWith(`/repos/${repo.full_name}/branches/main`));
    if (branchRepo) return Response.json({ commit: { sha: `sha-${branchRepo.id}` } });
    const rawRepo = repos.find(repo => url.includes(`/${repo.full_name}/`) && url.endsWith('/README.md'));
    if (rawRepo) return new Response(`# ${rawRepo.name}\nPublic project evidence.`, { status: 200 });
    if (url.includes('raw.githubusercontent.com')) return new Response('', { status: 404 });
    throw new Error(`unexpected fetch: ${url}`);
  };

  db = (await import('../dist/db.js')).getDb();
  profile = await import('../dist/core/profile.js');
  github = await import('../dist/core/github_sync.js');
  await profile.seedCareerPacketFromFiles({ mode: 'reseed', force: true });
  const scan = await github.runGithubSync('multi-approval-test');
  assert.equal(scan.proposals_created, 4);
  proposals = new Map(
    github.listGithubProposals('pending').map(proposal => [proposal.evidence.repository, proposal]),
  );
});

after(() => {
  delete globalThis.fetch;
  delete process.env.JOBOPS_LIVINGCV_URL;
  delete process.env.JOBOPS_LIVINGCV_INTERNAL_SECRET;
  if (sandbox) rmSync(sandbox, { recursive: true, force: true });
});

function statusOf(id) {
  return db.prepare('SELECT status FROM github_cv_proposals WHERE id=?').get(id).status;
}

test('invalid evidence leaves the proposal pending and retryable', async () => {
  const proposal = proposals.get('candidate/beta-project');
  db.prepare('UPDATE github_cv_proposals SET evidence_json=? WHERE id=?').run('{invalid', proposal.id);
  try {
    await assert.rejects(github.reviewGithubProposal(proposal.id, 'approve'), /JSON|Unexpected/i);
    assert.equal(statusOf(proposal.id), 'pending');
  } finally {
    db.prepare('UPDATE github_cv_proposals SET evidence_json=? WHERE id=?')
      .run(JSON.stringify(proposal.evidence), proposal.id);
  }
});

test('invalid edited content leaves the proposal pending and retryable', async () => {
  const proposal = proposals.get('candidate/alpha-project');
  await assert.rejects(
    github.reviewGithubProposal(proposal.id, 'approve', '# Proposal\n## Projects\n- Missing repository URL'),
    /retain the approved repository URL/i,
  );
  assert.equal(statusOf(proposal.id), 'pending');
});

test('packet insert failure rolls back the active packet and leaves the proposal retryable', async () => {
  const proposal = proposals.get('candidate/gamma-project');
  const before = profile.getActiveCareerPacket();
  db.exec(`
    CREATE TRIGGER fail_github_packet_insert
    BEFORE INSERT ON career_packet
    WHEN NEW.origin = 'github_sync'
    BEGIN
      SELECT RAISE(ABORT, 'forced packet insert failure');
    END
  `);
  try {
    await assert.rejects(github.reviewGithubProposal(proposal.id, 'approve'), /forced packet insert failure/);
  } finally {
    db.exec('DROP TRIGGER fail_github_packet_insert');
  }
  const afterFailure = profile.getActiveCareerPacket();
  assert.equal(afterFailure.id, before.id);
  assert.equal(afterFailure.version, before.version);
  assert.equal(afterFailure.content, before.content);
  assert.equal(statusOf(proposal.id), 'pending');
});

test('approvals rebase onto the latest packet and preserve prior approvals and manual edits', async () => {
  const {
    editPacketSection, getActiveCareerPacket, writeChatEditedPacket,
  } = profile;
  const { reviewGithubProposal } = github;

  const active = getActiveCareerPacket();
  await writeChatEditedPacket(
    editPacketSection(active.content, '5', '- **Languages:** TypeScript, Rust\n- **Manual marker:** preserved'),
    'manual edit after GitHub scan',
  );

  // Reverse order proves proposals do not depend on the order they were created.
  await reviewGithubProposal(proposals.get('candidate/beta-project').id, 'approve');
  await reviewGithubProposal(proposals.get('candidate/alpha-project').id, 'approve');

  // Concurrent approvals prove the latest-packet read and version write are atomic.
  await Promise.all([
    reviewGithubProposal(proposals.get('candidate/gamma-project').id, 'approve'),
    reviewGithubProposal(proposals.get('candidate/delta-project').id, 'approve'),
  ]);

  const finalPacket = getActiveCareerPacket().content;
  assert.match(finalPacket, /Manual marker:.*preserved/);
  for (const repo of repos) {
    assert.match(finalPacket, new RegExp(repo.html_url.replace(/[.*+?^$()|[\]\\]/g, '\\$&')));
    assert.equal(finalPacket.split(repo.html_url).length - 1, 1, `${repo.name} should appear once`);
  }

  const cv = readFileSync(join(sandbox, 'cv.md'), 'utf8');
  for (const repo of repos) assert.match(cv, new RegExp(repo.html_url.replace(/[.*+?^$()|[\]\\]/g, '\\$&')));
});
