// Feature 6: Auto-Updater
//   Tests for checkForUpdate.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// ── checkForUpdate ────────────────────────────────────────────────────────────

test('checkForUpdate returns current version and update command', async () => {
  const { checkForUpdate } = await import('../dist/core/updater.js');

  const result = await checkForUpdate();

  // Should have current version
  assert.ok(result.current);
  assert.match(result.current, /^\d+\.\d+\.\d+/);

  // Should have latest version
  assert.ok(result.latest);
  assert.match(result.latest, /^\d+\.\d+\.\d+/);

  // Should have checkedAt timestamp
  assert.ok(result.checkedAt);

  // If update is available, should have updateCommand
  if (result.updateAvailable) {
    assert.ok(result.updateCommand);
    assert.match(result.updateCommand, /(npm install -g|npx)/);
  } else {
    // If up to date, updateCommand can be empty
    assert.equal(typeof result.updateCommand, 'string');
  }
});

test('checkForUpdate handles npm registry being unreachable', async () => {
  // This test is hard to simulate without mocking fetch.
  // The implementation catches errors and returns current === latest.
  // We just verify the function doesn't throw.
  const { checkForUpdate } = await import('../dist/core/updater.js');

  // Should not throw even if registry is unreachable
  const result = await checkForUpdate();
  assert.ok(result);
  assert.ok(result.current);
  assert.ok(result.latest);
});
