import { test } from 'node:test';
import assert from 'node:assert/strict';

test('public repository guard requires both private=false and visibility=public', async () => {
  const { isPublicRepository } = await import('../dist/core/github_client.js');
  assert.equal(isPublicRepository({ private: false, visibility: 'public' }), true);
  assert.equal(isPublicRepository({ private: true, visibility: 'private' }), false);
  assert.equal(isPublicRepository({ private: false, visibility: 'internal' }), false);
  assert.equal(isPublicRepository({ private: true, visibility: 'public' }), false);
});

test('evidence extraction refuses private repositories before any API content read', async () => {
  const { extractGithubEvidence } = await import('../dist/core/github_client.js');
  await assert.rejects(() => extractGithubEvidence({
    id: 1, name: 'secret', full_name: 'user/secret', html_url: 'https://github.com/user/secret',
    description: null, private: true, visibility: 'private', fork: false, archived: false,
    default_branch: 'main', pushed_at: null,
  }, 'abc'), /non-public/i);
});

test('proposal adds and then updates a GitHub-backed project without duplication', async () => {
  const { proposePacketContent } = await import('../dist/core/github_sync.js');
  const repo = {
    id: 2, name: 'sample-app', full_name: 'user/sample-app', html_url: 'https://github.com/user/sample-app',
    description: 'A useful sample app', private: false, visibility: 'public', fork: false,
    archived: false, default_branch: 'main', pushed_at: null,
  };
  const evidence = {
    repository: repo.full_name, repository_url: repo.html_url, commit_sha: 'abc',
    description: repo.description, topics: [], languages: { TypeScript: 100 }, technologies: ['react'],
    readme_summary: '', deployment_url: null, evidence_sources: ['README.md', 'package.json'],
  };
  const base = '# Career Packet\n\n## 5. Earlier Experience\n\n- Existing role\n\n## 6. Projects Bank\n\n- **Old project** — Existing project\n\n## 7. Skills Bank\n\n- **Languages:** Python\n';
  const first = proposePacketContent(base, repo, evidence);
  assert.match(first, /sample app/);
  assert.match(first, /https:\/\/github.com\/user\/sample-app/);
  const second = proposePacketContent(first, repo, { ...evidence, description: 'Updated description', commit_sha: 'def' });
  assert.equal((second.match(/github\.com\/user\/sample-app/g) ?? []).length, 1);
  assert.match(second, /Updated description/);
});
