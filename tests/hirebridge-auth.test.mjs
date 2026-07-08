// Feature 4: HireBridge Connection (Magic Link Auth)
//   Tests for initiateDeviceAuth + pollForToken + writeHireBridgeTokenToEnv.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let sandbox;
before(async () => {
  sandbox = mkdtempSync(join(tmpdir(), 'jobops-hirebridge-'));
  process.env.JOBOPS_DATA_DIR = sandbox;
  process.env.JOBOPS_OUTPUT_DIR = join(sandbox, 'output');
  process.env.JOBOPS_PROJECT_ROOT = sandbox;

  // Initialize DB
  const { getDb } = await import('../dist/db.js');
  getDb();
});

after(() => {
  if (sandbox) rmSync(sandbox, { recursive: true, force: true });
});

// ── writeHireBridgeTokenToEnv ─────────────────────────────────────────────────

test('writeHireBridgeTokenToEnv creates .env with token and email', async () => {
  const { writeHireBridgeTokenToEnv } = await import('../dist/core/hirebridge_client.js');

  const envPath = join(sandbox, '.env');
  // Ensure .env doesn't exist initially
  if (existsSync(envPath)) {
    rmSync(envPath);
  }

  writeHireBridgeTokenToEnv('test-token-123', 'test@example.com', sandbox);

  assert.ok(existsSync(envPath));
  const content = readFileSync(envPath, 'utf-8');
  assert.match(content, /JOBOPS_HIREBRIDGE_TOKEN=test-token-123/);
  assert.match(content, /JOBOPS_HIREBRIDGE_EMAIL=test@example\.com/);
});

test('writeHireBridgeTokenToEnv replaces existing token in .env', async () => {
  const { writeHireBridgeTokenToEnv } = await import('../dist/core/hirebridge_client.js');

  const envPath = join(sandbox, '.env');
  // Create .env with existing token
  writeFileSync(envPath, 'JOBOPS_HIREBRIDGE_TOKEN=old-token\nJOBOPS_OTHER=value\n');

  writeHireBridgeTokenToEnv('new-token-456', 'new@example.com', sandbox);

  const content = readFileSync(envPath, 'utf-8');
  assert.match(content, /JOBOPS_HIREBRIDGE_TOKEN=new-token-456/);
  assert.doesNotMatch(content, /old-token/);
  assert.match(content, /JOBOPS_OTHER=value/); // Other vars preserved
  assert.match(content, /JOBOPS_HIREBRIDGE_EMAIL=new@example\.com/);
});

test('writeHireBridgeTokenToEnv sets process.env', async () => {
  const { writeHireBridgeTokenToEnv } = await import('../dist/core/hirebridge_client.js');

  const origToken = process.env.JOBOPS_HIREBRIDGE_TOKEN;
  const origEmail = process.env.JOBOPS_HIREBRIDGE_EMAIL;

  try {
    writeHireBridgeTokenToEnv('env-token-789', 'env@example.com', sandbox);

    assert.equal(process.env.JOBOPS_HIREBRIDGE_TOKEN, 'env-token-789');
    assert.equal(process.env.JOBOPS_HIREBRIDGE_EMAIL, 'env@example.com');
  } finally {
    if (origToken) {
      process.env.JOBOPS_HIREBRIDGE_TOKEN = origToken;
    } else {
      delete process.env.JOBOPS_HIREBRIDGE_TOKEN;
    }
    if (origEmail) {
      process.env.JOBOPS_HIREBRIDGE_EMAIL = origEmail;
    } else {
      delete process.env.JOBOPS_HIREBRIDGE_EMAIL;
    }
  }
});

// ── initiateDeviceAuth ────────────────────────────────────────────────────────

test('initiateDeviceAuth throws when HireBridge is unreachable', async () => {
  const origUrl = process.env.JOBOPS_HIREBRIDGE_URL;
  process.env.JOBOPS_HIREBRIDGE_URL = 'http://127.0.0.1:99999'; // unreachable port

  try {
    const { initiateDeviceAuth } = await import('../dist/core/hirebridge_client.js');
    await assert.rejects(
      () => initiateDeviceAuth('test@example.com'),
      /(HireBridge \/auth\/device failed|Failed to parse URL|fetch failed)/,
    );
  } finally {
    if (origUrl) {
      process.env.JOBOPS_HIREBRIDGE_URL = origUrl;
    } else {
      delete process.env.JOBOPS_HIREBRIDGE_URL;
    }
  }
});
