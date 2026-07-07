// Entrypoint. One process, two transport modes:
//
//   HTTP   (default)   — npx @mohith_das/jobops start
//     MCP transport + file server + tracker dashboard, all on JOBOPS_PORT.
//
//   stdio  (Claude Desktop)  — npx @mohith_das/jobops start --stdio
//     MCP transport on stdin/stdout; HTTP file server still runs on the port
//     so /files/* artifact links the chat returns still resolve in a browser.
//
// In stdio mode all logging MUST go to stderr — stdout is the MCP channel.
import { buildHttpApp } from './http/app.js';
import { mountMcp, serveStdio, getPublicTools } from './mcp/server.js';
import { config } from './config.js';
import { getDb } from './db.js';
import { ensureActiveCareerPacket, loadProjectFiles } from './core/profile.js';
import { closeBrowser } from './core/render.js';
import { shutdownScanResources } from './core/scan_engine.js';
import { setTransportMode } from './core/server_status.js';
import { applyState as applySchedulerState, readEnabledJobs } from './core/scheduler.js';

export interface BootOptions {
  stdio?: boolean;
}

function authBannerLine(): string {
  switch (config.authPolicy.mode) {
    case 'open':  return 'open (localhost-only — no token required)';
    case 'token': return config.authPolicy.isLocalhost
      ? 'bearer token required (set even for localhost)'
      : 'bearer token required (remote bind — PII protected)';
    default:      return 'denied';
  }
}

export async function bootServer(opts: BootOptions = {}): Promise<void> {
  // ── Default-deny guard ───────────────────────────────────────────────────────
  // Refuse to boot when bound to a non-localhost address without an auth token. This
  // is the hard guarantee that resume PDFs / LinkedIn connections / H1B PII are never
  // served unauthenticated to a remote network. stdio mode still binds the HTTP file
  // server (for /files/* links), so the guard applies there too.
  if (config.authPolicy.mode === 'deny') {
    // eslint-disable-next-line no-console
    console.error(
      `\n[fatal] Refusing to start: ${config.authPolicy.reason}\n` +
      `  Bind host:   ${config.host}\n` +
      `  Fix (pick one):\n` +
      `    • Bind to localhost only (default):  unset JOBOPS_HOST (or set it to 127.0.0.1)\n` +
      `    • Expose remotely WITH auth:         export JOBOPS_AUTH_TOKEN="$(openssl rand -hex 32)"\n` +
      `  Never expose resume PDFs / LinkedIn / H1B data to a network without a token.\n`,
    );
    process.exit(1);
  }

  // Migrations + first-run seeding (side-effect of getDb()).
  getDb();
  const seed = await ensureActiveCareerPacket();
  const files = loadProjectFiles();

  const app = buildHttpApp();
  // In stdio mode we DON'T mount /mcp — MCP rides stdin/stdout instead.
  // The Express server still runs so /files/* artifact links resolve.
  setTransportMode(opts.stdio ? 'stdio' : 'http');
  if (!opts.stdio) {
    // Authenticated, full surface.
    mountMcp(app, '/mcp');
    // Open, read-only curated surface for external recruiter-side AI agents
    // (Claude.ai connectors, ChatGPT MCP, etc.) — allow-listed in the bearer
    // middleware in src/http/app.ts. Tools are server-side registered; no
    // client-side filter can make a mutating tool unreachable, so the mount
    // takes a strictly narrower toolset (deriveTools → PUBLIC_TOOLS).
    mountMcp(app, '/mcp/public', [...getPublicTools()]);
  }
  applySchedulerState();
  const enabled = readEnabledJobs();

  const server = app.listen(config.port, config.host, () => {
    const pubLine = config.publicBaseUrlIsExplicit
      ? `  · Public URL:     ${config.publicBaseUrl}  (artifact links emit this)`
      : `  · Public URL:     ${config.publicBaseUrl}  (default — set JOBOPS_PUBLIC_BASE_URL to override)`;
    const lines = opts.stdio
      ? [
          '',
          `▷ jobops stdio mode`,
          `  · MCP transport:  stdin/stdout`,
          `  · Listen URL:     ${config.listenUrl}  (HTTP file server bound here)`,
          pubLine,
          `  · DB:             ${config.dbPath}`,
          `  · Project root:   ${config.projectRoot}`,
          `  · career_packet:  ${seed.created ? `seeded v${seed.version}` : `existing v${seed.version}`}`,
          `  · scheduler:      ${enabled.length ? enabled.join(', ') : 'off'}`,
          `  · visa scoring:   ${config.visaScoringEnabled ? 'on (0.5/0.3/0.2)' : 'off (0.6/0.4, visa tools hidden)'}`,
          `  · auth:           ${authBannerLine()}`,
          '',
        ]
      : [
          '',
          `▷ jobops listening on ${config.listenUrl}`,
          `  · MCP endpoint:   ${config.listenUrl}/mcp`,
          `  · Tracker UI:     ${config.listenUrl}/`,
          `  · File server:    ${config.listenUrl}/files/*`,
          pubLine,
          `  · DB:             ${config.dbPath}`,
          `  · Project root:   ${config.projectRoot}`,
          `  · cv.md present:  ${!!files.cvMd}`,
          `  · profile.yml:    ${!!files.profile}`,
          `  · portals.yml:    ${!!files.portalsYml}`,
          `  · career_packet:  ${seed.created ? `seeded v${seed.version}` : `existing v${seed.version}`}`,
          `  · scheduler:      ${enabled.length ? enabled.join(', ') : 'off'}`,
          `  · visa scoring:   ${config.visaScoringEnabled ? 'on (0.5/0.3/0.2)' : 'off (0.6/0.4, visa tools hidden)'}`,
          `  · auth:           ${authBannerLine()}`,
          '',
        ];
    // eslint-disable-next-line no-console
    console.error(lines.join('\n'));
  });

  const shutdown = async (signal: string) => {
    // eslint-disable-next-line no-console
    console.error(`\n[shutdown] ${signal} received`);
    server.close();
    await closeBrowser();
    await shutdownScanResources();
    process.exit(0);
  };
  process.on('SIGINT',  () => { void shutdown('SIGINT'); });
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });

  if (opts.stdio) {
    // Block here until the stdio client disconnects (stdin EOFs).
    // The HTTP file server keeps serving /files/* in parallel.
    await serveStdio();
    // eslint-disable-next-line no-console
    console.error('[shutdown] stdio client disconnected');
    server.close();
    await closeBrowser();
    await shutdownScanResources();
    process.exit(0);
  }
}
