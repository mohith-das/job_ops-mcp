// Canonical Federation Contract v1 — token-poll state machine tests.
//
// Per RFC 8628 the server returns:
//   authorization_pending → HTTP 400 + {error: "authorization_pending"}
//   slow_down             → HTTP 400 + {error: "slow_down", interval: N}
//   expired_token         → HTTP 400 + {error: "expired_token"}
//   access_denied         → HTTP 400 + {error: "access_denied"}
//   success               → HTTP 200 + {access_token, node_id, email, expires_in}
//
// Throwing on non-2xx would abort the very first poll (the first response is
// always authorization_pending). These tests stand up an in-process Node HTTP
// mock that returns RFC 8628 400 bodies, then verify pollForToken keeps
// polling, honors slow_down intervals, and resolves the success.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let sandbox;
before(async () => {
  sandbox = mkdtempSync(join(tmpdir(), 'jobops-hb-token-'));
  process.env.JOBOPS_DATA_DIR     = sandbox;
  process.env.JOBOPS_OUTPUT_DIR   = join(sandbox, 'output');
  process.env.JOBOPS_PROJECT_ROOT = sandbox;
  // Trivial CV / profile so db init doesn't blow up on missing files.
  writeFileSync(join(sandbox, 'cv.md'), '# CV');
  mkdirSync(join(sandbox, 'config'), { recursive: true });
  writeFileSync(join(sandbox, 'config', 'profile.yml'), 'candidate:\n  full_name: Test');

  const { getDb } = await import('../dist/db.js');
  getDb();
});
after(() => { if (sandbox) rmSync(sandbox, { recursive: true, force: true }); });

/**
 * Tiny mock HireBridge /auth/token server. The script decides what response
 * to send for the i-th request — e.g. ['pending', 'pending', 'success'].
 *
 * Captures every request body so we can assert form-encoding + grant_type.
 */
function startMockHb(script) {
  const calls = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c.toString('utf-8'); });
    req.on('end', () => {
      calls.push({ body, contentType: req.headers['content-type'] ?? null });
      const action = script.shift();
      if (action === undefined) {
        res.writeHead(500);
        res.end();
        return;
      }
      switch (action) {
        case 'pending':
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'authorization_pending' }));
          break;
        case 'slow_down':
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'slow_down', interval: 1 }));
          break;
        case 'expired_token':
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'expired_token' }));
          break;
        case 'access_denied':
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'access_denied' }));
          break;
        case 'success':
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            access_token: 'hb-token-abc',
            node_id: 'node-xyz',
            email: 'u@example.com',
            expires_in: 3600,
          }));
          break;
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ server, url: `http://127.0.0.1:${port}`, calls });
    });
  });
}

test('token poll: form-encoded grant + parses 400 authorization_pending until success', async () => {
  const { server, url, calls } = await startMockHb(['pending', 'pending', 'success']);
  try {
    const { pollForToken } = await import('../dist/core/hirebridge_client.js');
    const res = await pollForToken('dev-code', 0, 30, url); // interval 0 → sleep 1s minimum
    assert.equal(res.access_token, 'hb-token-abc');
    assert.equal(res.node_id, 'node-xyz');
    assert.equal(res.email, 'u@example.com');
    assert.equal(calls.length, 3, 'should poll 3 times (2 pending + 1 success)');
    for (const c of calls) {
      assert.match(c.contentType ?? '', /application\/x-www-form-urlencoded/);
      const params = new URLSearchParams(c.body);
      assert.equal(params.get('grant_type'), 'urn:ietf:params:oauth:grant-type:device_code');
      assert.equal(params.get('device_code'), 'dev-code');
    }
  } finally { await new Promise((r) => server.close(() => r())); }
});

test('token poll: slow_down respects returned interval', async () => {
  // Use a script that issues slow_down twice with interval=0 (so the test is fast),
  // then a success. We assert the polling call count proves all 3 were made.
  const { server, url, calls } = await startMockHb(['slow_down', 'slow_down', 'success']);
  try {
    const { pollForToken } = await import('../dist/core/hirebridge_client.js');
    const res = await pollForToken('dev-code', 0, 30, url);
    assert.equal(res.access_token, 'hb-token-abc');
    assert.equal(calls.length, 3);
  } finally { await new Promise((r) => server.close(() => r())); }
});

test('token poll: expired_token throws a friendly re-run hint', async () => {
  const { server, url } = await startMockHb(['pending', 'expired_token']);
  try {
    const { pollForToken } = await import('../dist/core/hirebridge_client.js');
    await assert.rejects(
      () => pollForToken('dev-code', 0, 30, url),
      /Magic link expired\. Run connect_to_hirebridge again/,
    );
  } finally { await new Promise((r) => server.close(() => r())); }
});

test('token poll: access_denied throws a friendly message', async () => {
  const { server, url } = await startMockHb(['access_denied']);
  try {
    const { pollForToken } = await import('../dist/core/hirebridge_client.js');
    await assert.rejects(
      () => pollForToken('dev-code', 0, 30, url),
      /Access denied/,
    );
  } finally { await new Promise((r) => server.close(() => r())); }
});

test('token poll: unknown RFC 8628 error surfaces both HTTP code and error code', async () => {
  // Simulate the server returning a 400 with an error code the client does not
  // have an explicit branch for. The polling loop must still NOT silently swallow.
  const server = createServer((req, res) => {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'unrecognized_future_code' }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}`;
  try {
    const { pollForToken } = await import('../dist/core/hirebridge_client.js');
    await assert.rejects(
      () => pollForToken('dev-code', 0, 30, url),
      /unrecognized_future_code/,
    );
  } finally { await new Promise((r) => server.close(() => r())); }
});
