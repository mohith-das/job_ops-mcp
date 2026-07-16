import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let sandbox, livingcvPacket;
const repo = {
  id: 42, name: 'public-project', full_name: 'candidate/public-project',
  html_url: 'https://github.com/candidate/public-project', description: 'A public evidence project',
  private: false, visibility: 'public', fork: false, archived: false,
  default_branch: 'main', pushed_at: '2026-07-15T00:00:00Z', topics: ['ai'], homepage: null,
};

before(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'jobops-github-flow-'));
  process.env.JOBOPS_DATA_DIR = sandbox;
  process.env.JOBOPS_OUTPUT_DIR = join(sandbox, 'output');
  process.env.JOBOPS_PROJECT_ROOT = sandbox;
  process.env.JOBOPS_GITHUB_USERNAME = 'candidate';
  process.env.JOBOPS_LIVINGCV_URL = 'http://livingcv.internal';
  process.env.JOBOPS_LIVINGCV_INTERNAL_SECRET = 'test-product-secret';
  mkdirSync(join(sandbox, 'config'), { recursive: true });
  writeFileSync(join(sandbox, 'config', 'profile.yml'), 'candidate:\n  full_name: Candidate\n  email: candidate@example.com\n', 'utf8');
  writeFileSync(join(sandbox, 'cv.md'), `# CV — Candidate
## Work Experience
### Example — Engineer
Remote · 2022 – Present
- Built reliable public software used by engineering teams
- Shipped production services with measurable operational improvements
- Maintained automated tests and deployment documentation
## Projects & Open Source
- **Existing** — Existing project
## Skills
- **Languages:** TypeScript, Python
## Education
- **BS Computer Science** — Example University (2022)
`, 'utf8');

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url === 'http://livingcv.internal/api/internal/jobops-sync') {
      livingcvPacket = JSON.parse(init.body);
      return Response.json({ stored: true, approved: true, published: 1 });
    }
    if (url.includes('/users/candidate/repos?')) return Response.json([repo]);
    if (url.endsWith('/repos/candidate/public-project/branches/main')) return Response.json({ commit: { sha: 'abc123' } });
    if (url.includes('raw.githubusercontent.com') && url.endsWith('/README.md')) {
      return new Response('# Public Project\nBuilds a documented AI evaluation service with TypeScript.', { status: 200 });
    }
    if (url.includes('raw.githubusercontent.com')) return new Response('', { status: 404 });
    throw new Error(`unexpected fetch: ${url}`);
  };
});

after(() => {
  delete globalThis.fetch;
  delete process.env.JOBOPS_LIVINGCV_URL;
  delete process.env.JOBOPS_LIVINGCV_INTERNAL_SECRET;
  if (sandbox) rmSync(sandbox, { recursive: true, force: true });
});

test('sync creates one proposal, is idempotent, and approval versions packet plus cv.md', async () => {
  const { getDb } = await import('../dist/db.js');
  const { seedCareerPacketFromFiles, getActiveCareerPacket } = await import('../dist/core/profile.js');
  const { runGithubSync, listGithubProposals } = await import('../dist/core/github_sync.js');
  const { approveGithubProposalTool } = await import('../dist/mcp/tools/github_sync.js');
  getDb();
  await seedCareerPacketFromFiles({ mode: 'reseed', force: true });

  const first = await runGithubSync('test');
  assert.equal(first.proposals_created, 1);
  const proposal = listGithubProposals('pending')[0];
  assert.equal(proposal.evidence.repository, repo.full_name);

  const second = await runGithubSync('test');
  assert.equal(second.proposals_created, 0);

  const approvalResult = await approveGithubProposalTool.handler({ proposal_id: proposal.id });
  const approved = approvalResult.structuredContent;
  assert.equal(approved.status, 'approved');
  assert.equal(approved.cv_synced, true);
  assert.equal(approved.livingcv_synced, true);
  assert.equal(livingcvPacket.approved_by_user, true);
  assert.equal(livingcvPacket.proposal_id, proposal.id);
  assert.equal(getActiveCareerPacket().origin, 'github_sync');
  assert.match(readFileSync(join(sandbox, 'cv.md'), 'utf8'), /public project/i);
});
