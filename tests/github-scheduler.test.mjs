import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let sandbox;
before(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'jobops-github-scheduler-'));
  process.env.JOBOPS_DATA_DIR = sandbox;
  process.env.JOBOPS_OUTPUT_DIR = join(sandbox, 'output');
  process.env.JOBOPS_PROJECT_ROOT = sandbox;
});
after(() => { if (sandbox) rmSync(sandbox, { recursive: true, force: true }); });

test('github scheduler is exactly six hours and becomes active when enabled', async () => {
  const { JOB_DEFS, setEnabledJobs, status, disableAll } = await import('../dist/core/scheduler.js');
  const { getDb } = await import('../dist/db.js');
  getDb().prepare(`INSERT OR REPLACE INTO github_connection(id,github_username,enabled) VALUES(1,'candidate',0)`).run();
  assert.equal(JOB_DEFS.github_sync_6h.intervalMs, 6 * 60 * 60 * 1000);
  const enabled = await setEnabledJobs(['github_sync_6h']);
  assert.deepEqual(enabled, ['github_sync_6h']);
  const current = status();
  assert.deepEqual(current.enabled_jobs, ['github_sync_6h']);
  assert.deepEqual(current.runtime, ['github_sync_6h']);
  assert.equal(current.available_jobs.find((job) => job.name === 'github_sync_6h').interval_ms, 21_600_000);
  await disableAll();
});

test('configuring GitHub leaves automatic sync off until explicitly enabled', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (/\/users\/candidate$/.test(url)) return Response.json({ id: 101, login: 'candidate', html_url: 'https://github.com/candidate', type: 'User' });
    if (/\/users\/candidate\/repos\?/.test(url)) return Response.json([]);
    throw new Error(`unexpected fetch ${url}`);
  };
  try {
    const { configureGithub } = await import('../dist/core/github_sync.js');
    const { status, disableAll, setGithubSchedulerEnabled } = await import('../dist/core/scheduler.js');
    const { getDb } = await import('../dist/db.js');
    getDb().prepare(`INSERT INTO career_packet(id,version,content,is_active,origin) VALUES('scheduler-packet',1,'# CV',1,'seed')`).run();
    const configured = await configureGithub('candidate');
    assert.equal(configured.automatic_sync, false);
    assert.equal(configured.scheduled_every_hours, null);
    assert.deepEqual(status().enabled_jobs, []);
    assert.equal(getDb().prepare(`SELECT enabled FROM github_connection WHERE id=1`).get().enabled, 0);

    await setGithubSchedulerEnabled(true);
    assert.deepEqual(status().enabled_jobs, ['github_sync_6h']);
    assert.equal(getDb().prepare(`SELECT enabled FROM github_connection WHERE id=1`).get().enabled, 1);

    await setGithubSchedulerEnabled(false);
    assert.deepEqual(status().enabled_jobs, []);
    assert.equal(getDb().prepare(`SELECT enabled FROM github_connection WHERE id=1`).get().enabled, 0);
    await disableAll();
  } finally {
    globalThis.fetch = originalFetch;
  }
});
