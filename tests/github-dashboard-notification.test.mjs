import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let sandbox, server, base, getDb;
const proposalId = '11111111-1111-4111-8111-111111111111';

before(async () => {
  sandbox = mkdtempSync(join(tmpdir(), 'jobops-github-dashboard-'));
  process.env.JOBOPS_DATA_DIR = sandbox;
  process.env.JOBOPS_OUTPUT_DIR = join(sandbox, 'output');
  process.env.JOBOPS_PROJECT_ROOT = sandbox;
  ({ getDb } = await import('../dist/db.js'));
  const db = getDb();
  db.prepare(`
    INSERT INTO github_repositories
      (github_repo_id,full_name,html_url,visibility,default_branch,latest_sha)
    VALUES (101,'candidate/public-project','https://github.com/candidate/public-project','public','main','abc123')
  `).run();
  db.prepare(`
    INSERT INTO github_cv_proposals
      (id,github_repo_id,source_commit_sha,source_url,evidence_json,proposed_packet_content,packet_diff,confidence)
    VALUES (?,?,?,?,?,?,?,?)
  `).run(proposalId, 101, 'abc123', 'https://github.com/candidate/public-project', '{}', '# CV', 'Section 6 project update', 80);
  const { buildHttpApp } = await import('../dist/http/app.js');
  await new Promise(resolve => { server = buildHttpApp().listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) { server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); }
  if (sandbox) rmSync(sandbox, { recursive: true, force: true });
});

test('dashboard displays a visible GitHub approval request', async () => {
  const response = await fetch(`${base}/`);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /GitHub found 1 proposed CV update\. Review now\./);
  assert.match(html, /Approve and update JobOps \+ LivingCV/);
  assert.match(html, /candidate\/public-project/);
});

test('dashboard reject uses the shared proposal review core and clears the alert', async () => {
  const countBefore = await (await fetch(`${base}/api/github/proposals/pending-count`)).json();
  assert.equal(countBefore.pending, 1);
  const rejected = await fetch(`${base}/api/github/proposals/${proposalId}/reject`, { method: 'POST' });
  assert.equal(rejected.status, 200);
  assert.equal((await rejected.json()).status, 'rejected');
  assert.equal(getDb().prepare(`SELECT status FROM github_cv_proposals WHERE id=?`).get(proposalId).status, 'rejected');
  const htmlAfter = await (await fetch(`${base}/`)).text();
  assert.doesNotMatch(htmlAfter, /GitHub found 1 proposed CV update/);
});
