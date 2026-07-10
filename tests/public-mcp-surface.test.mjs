// Public MCP surface — structural guarantees that no mutating tool can ever
// leak into /mcp/public, even via prompt injection. See PLAN §5 + §2 invariant 4.
//
// We import from the compiled source (the rest of the repo compiles to dist/
// so it imports from there). Two paths are validated:
//   1. Server-side registration: PUBLIC_TOOLS is deep-equal to exactly
//      {get_career_packet, get_story_bank_public}. Anything else (mutating,
//      persona-leaking) is structurally unreachable on /mcp/public.
//   2. HTTP-level: an unauthenticated POST to /mcp/public lists exactly the
//      two tools, and an unauthenticated POST to /mcp is rejected.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

let sandbox;
before(async () => {
  sandbox = mkdtempSync(join(tmpdir(), 'jobops-public-mcp-'));
  mkdirSync(resolve(sandbox, 'config'), { recursive: true });
  writeFileSync(resolve(sandbox, 'cv.md'), `# CV`);
  writeFileSync(resolve(sandbox, 'config/profile.yml'), `candidate:\n  full_name: "Test"`);
  writeFileSync(resolve(sandbox, 'portals.yml'), `tracked_companies: []\n`);

  process.env.JOBOPS_DATA_DIR     = resolve(sandbox, 'data');
  process.env.JOBOPS_OUTPUT_DIR   = resolve(sandbox, 'output');
  process.env.JOBOPS_PROJECT_ROOT = sandbox;
});

after(() => { if (sandbox) rmSync(sandbox, { recursive: true, force: true }); });

// Use tsx so we can require the TypeScript source directly.
// TEST_TARGET=src exercises the source tree (forces a recompile); default exercises dist/.
const SRC = process.env.JOBOPS_TEST_SRC === '1';

let defineTool, listAllTools, getPublicTools, buildHttpApp, config, setTransportMode, closeBrowser, runInWriteLock, getDb, ensureActiveCareerPacket, loadProjectFiles, applySchedulerState;

if (SRC) {
  ({ defineTool } = await import('../src/mcp/define.ts'));
  ({ listAllTools, getPublicTools } = await import('../src/mcp/server.ts'));
  ({ buildHttpApp } = await import('../src/http/app.ts'));
  ({ config } = await import('../src/config.ts'));
  ({ setTransportMode } = await import('../src/core/server_status.ts'));
  ({ closeBrowser } = await import('../src/core/render.ts'));
  ({ runInWriteLock, getDb } = await import('../src/db.ts'));
  ({ ensureActiveCareerPacket, loadProjectFiles } = await import('../src/core/profile.ts'));
  ({ applyState: applySchedulerState } = await import('../src/core/scheduler.ts'));
} else {
  ({ defineTool } = await import('../dist/mcp/define.js'));
  ({ listAllTools, getPublicTools } = await import('../dist/mcp/server.js'));
  ({ buildHttpApp } = await import('../dist/http/app.js'));
  ({ config } = await import('../dist/config.js'));
  ({ setTransportMode } = await import('../dist/core/server_status.js'));
  ({ closeBrowser } = await import('../dist/core/render.js'));
  ({ runInWriteLock, getDb } = await import('../dist/db.js'));
  ({ ensureActiveCareerPacket, loadProjectFiles } = await import('../dist/core/profile.js'));
  ({ applyState: applySchedulerState } = await import('../dist/core/scheduler.js'));
}

// 1. Every registered tool has an explicit `mutates`.
//
// This is the audit hook: if someone adds a new tool and forgets the field,
// defineTool can't validate it directly, but registry-level tooling CAN —
// and this test refuses to pass until every tool in the registry has one.
// §5: "audit all 51 tools once and set it explicitly".
test('every registered tool has an explicit mutates', () => {
  const all = listAllTools();
  assert.ok(all.length >= 3, 'registry should contain the three public tools at minimum');
  const missing = all.filter((t) => typeof t.mutates !== 'boolean');
  assert.deepEqual(missing, [], `tools missing mutates: ${missing.map((t) => t.name).join(', ')}`);
});

// 2. PUBLIC_TOOLS is EXACTLY { get_career_packet, get_story_bank_public }.
//
// Deep-equal at the registry level: closed by construction. Adding a third
// publicSafe tool requires updating this test (and reviewer-approved intent).
test('PUBLIC_TOOLS deep-equals exactly the three public tools', () => {
  const pub = getPublicTools();
  assert.deepEqual(
    pub.map((t) => t.name).sort(),
    ['get_career_packet', 'get_career_packet_json', 'get_story_bank_public'].sort(),
  );
  for (const t of pub) {
    assert.equal(t.mutates, false, `${t.name} must be mutates=false`);
  }
});

// 3. defineTool throws at module load if a tool is both publicSafe and mutates.
//
// Programmer error: opt-in to public requires non-mutation. The check runs
// synchronously inside defineTool, so a failed assertion is caught here.
test('defineTool refuses publicSafe + mutates=true', () => {
  assert.throws(() => defineTool({
    name: 'malicious_test_tool',
    title: 'should-not-define',
    description: 'must throw',
    inputSchema: {},
    mutates: true,
    publicSafe: true,
    handler: () => ({ content: [{ type: 'text', text: '' }] }),
  }), /publicSafe but mutates/);
});

// 4. /mcp/public responds to an unauthenticated tools/list — structurally
//    guaranteeing the external surface is reachable without an admin token.
//
// /mcp meanwhile returns 401 (the bearer guard's job).
//
// Both endpoints have to be live at the same time, so we use a single Express
// app and exercise both routes back-to-back. JOBOPS_AUTH_TOKEN is left unset
// here, but the route allow-list check in src/http/app.ts treats /mcp/public
// as always-open; /mcp is gated only when config.authPolicy.requireToken is
// true (non-localhost binds, or token explicitly set even locally). To force
// /mcp to gate even on this test, set JOBOPS_AUTH_TOKEN in the env.

test('/mcp/public responds without a token (tools/list shows exactly the three public tools)', async () => {
  // Initialize DB + ensure the public tools can actually run.
  getDb();
  await ensureActiveCareerPacket();
  loadProjectFiles();
  setTransportMode('http');
  applySchedulerState();

  // Force requireToken=true so /mcp IS gated; this validates the allow-list
  // asymmetry — /mcp/public must remain open even when /mcp is closed.
  const origAuth = config.authPolicy;
  /** @type {any} */
  const cfgAny = config;
  cfgAny.authPolicy = { ...origAuth, requireToken: true, token: 'unauth-test-token' };

  let server;
  try {
    const app = buildHttpApp();
    const { mountMcp } = await (SRC
      ? import('../src/mcp/server.ts')
      : import('../dist/mcp/server.js'));
    mountMcp(app, '/mcp');
    mountMcp(app, '/mcp/public', [...getPublicTools()]);

    const { createServer } = await import('node:http');
    server = createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const base = `http://127.0.0.1:${port}`;

    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    const fetchJson = async (path) => {
      const res = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body,
      });
      let json = null;
      const text = await res.text();
      try { json = JSON.parse(text); } catch { /* not JSON */ }
      return { status: res.status, json, text, ct: res.headers.get('content-type') };
    };

    // /mcp without a token → 401.
    const r401 = await fetchJson('/mcp');
    assert.equal(r401.status, 401, '/mcp without token must 401');

    // /mcp/public without a token → 200, lists exactly 3 tools.
    const r200 = await fetchJson('/mcp/public');
    if (r200.status !== 200) {
      console.error('DEBUG /mcp/public', r200.status, 'ct=', r200.ct, 'text=', r200.text.slice(0, 400));
    }
    assert.equal(r200.status, 200, '/mcp/public without token must respond 200');
    const listed = r200.json?.result?.tools ?? [];
    const names = listed.map((t) => t.name).sort();
    assert.deepEqual(
      names,
      ['get_career_packet', 'get_career_packet_json', 'get_story_bank_public'],
      'external surface must list exactly the three public tools',
    );
  } finally {
    cfgAny.authPolicy = origAuth;
    if (server) await new Promise((resolve) => server.close(() => resolve()));
  }
});

void runInWriteLock;
void closeBrowser;
