// Express app: tracker dashboard, /files static server, /healthz, and the /mcp transport.
// The MCP HTTP transport is mounted from src/mcp/server.ts onto the same Express instance
// so users only need to expose one port to their chat client.
//
// Auth: when config.authPolicy.requireToken is true (non-localhost bind, or a token set
// even locally), every PII-bearing route — the dashboard (/), /files/*, and /mcp — is
// gated behind a bearer token. /healthz stays open (no PII) so liveness probes work, and
// the protected-resource metadata document is served unauthenticated for discovery.
import express, { type Express, type Request, type Response } from 'express';
import { resolve, normalize, relative, sep } from 'node:path';

import { config } from '../config.js';
import { renderDashboard, renderTrashPage, countsJson } from './dashboard.js';
import { serverStatus } from '../core/server_status.js';
import { bearerAuthMiddleware, protectedResourceMetadata } from '../core/auth.js';
import { mountElicit } from './elicit.js';
import {
  setJobStatus, trashJobs, restoreJobs, purgeJobs, JOB_STATUSES, type JobStatus,
} from '../core/job_trash.js';
import { reviewGithubProposal } from '../core/github_sync.js';
import { getDb } from '../db.js';

export function buildHttpApp(): Express {
  const app = express();

  // Body parser — MCP transport uses JSON-RPC; raise the limit slightly so chat clients
  // can POST report bodies on step 2 of evaluate_job.
  app.use(express.json({ limit: '4mb' }));

  // Liveness — always open, never serves PII.
  app.get('/healthz', (_req: Request, res: Response) => {
    res.json({
      ok: true,
      listenUrl: config.listenUrl,
      publicBaseUrl: config.publicBaseUrl,
      auth: config.authPolicy.mode,
    });
  });

  // Protected-resource metadata (RFC 9728-shaped) — discovery, always open.
  const resourceMetadataUrl = `${config.publicBaseUrl}/.well-known/oauth-protected-resource`;
  app.get('/.well-known/oauth-protected-resource', (_req: Request, res: Response) => {
    res.json(protectedResourceMetadata(`${config.publicBaseUrl}/mcp`));
  });

  // URL-mode elicitation capture (sensitive inputs entered out-of-band, never via the MCP
  // client). Mounted before the auth guard — the one-time unguessable id is the capability.
  // Needs urlencoded form parsing for the POST.
  app.use(express.urlencoded({ extended: false }));
  mountElicit(app, '/elicit');

  // Gate the PII surface when the policy demands a token. Mounted BEFORE the routes so it
  // covers the dashboard, /files, and (via mountMcp, which runs after this) /mcp.
  if (config.authPolicy.requireToken && config.authPolicy.token) {
    const guard = bearerAuthMiddleware(config.authPolicy.token, resourceMetadataUrl);
    app.use((req: Request, res: Response, next) => {
      // Allow-list the always-open routes; everything else needs the token.
      // /mcp/public is the anonymous recruiter-side surface; its toolset is
      // narrow (get_career_packet + get_story_bank_public) and server-registered
      // to be non-mutating, so leaving it open is safe.
      if (
        req.path === '/healthz' ||
        req.path === '/.well-known/oauth-protected-resource' ||
        req.path === '/mcp/public'
      ) {
        return next();
      }
      return guard(req, res, next);
    });
  }

  app.get('/', (req: Request, res: Response) => {
    res.type('html').send(renderDashboard(req.query as Record<string, unknown>));
  });

  // Soft-deleted ("trashed") jobs page.
  app.get('/trash', (_req: Request, res: Response) => {
    res.type('html').send(renderTrashPage());
  });

  // ── Tracker CRUD API — the UI calls these; they share core/job_trash.ts with the MCP
  // tools (one implementation). All are behind the same auth guard as the dashboard. ──
  app.get('/api/counts', (_req: Request, res: Response) => res.json(countsJson()));

  app.get('/api/github/proposals/pending-count', (_req: Request, res: Response) => {
    const row = getDb().prepare(`SELECT COUNT(*) AS n FROM github_cv_proposals WHERE status='pending'`).get() as { n: number };
    res.json({ pending: row.n });
  });

  app.post('/api/github/proposals/:id/approve', async (req: Request, res: Response) => {
    try { return res.json(await reviewGithubProposal(req.params.id, 'approve')); }
    catch (error: any) { return res.status(400).json({ error: error?.message ?? String(error) }); }
  });

  app.post('/api/github/proposals/:id/reject', async (req: Request, res: Response) => {
    try { return res.json(await reviewGithubProposal(req.params.id, 'reject')); }
    catch (error: any) { return res.status(400).json({ error: error?.message ?? String(error) }); }
  });

  // Server identity for the shared-topology check: uptime, DB path + fingerprint,
  // clients seen since boot. Auth-gated (mounted after the guard) — the DB path and
  // client list are operator-only detail. The CLI `status` command reads this.
  app.get('/api/status', (_req: Request, res: Response) => res.json(serverStatus()));

  app.post('/api/jobs/:id/status', async (req: Request, res: Response) => {
    const status = String(req.body?.status ?? '');
    if (!(JOB_STATUSES as readonly string[]).includes(status)) {
      return res.status(400).json({ error: `invalid status "${status}"` });
    }
    const r = await setJobStatus(req.params.id, status as JobStatus, req.body?.note);
    if (!r.ok) return res.status(404).json({ error: r.message });
    return res.json(r);
  });

  app.post('/api/jobs/:id/trash', async (req: Request, res: Response) => {
    const r = await trashJobs({ jobIds: [req.params.id] });
    if (!r.trashed && r.results[0]?.action === 'not_found') return res.status(404).json({ error: 'job not found' });
    return res.json(r);
  });

  app.post('/api/jobs/:id/restore', async (req: Request, res: Response) => {
    const r = await restoreJobs([req.params.id]);
    return res.json(r);
  });

  // Hard delete — single trashed job. Backup written inside purgeJobs.
  app.post('/api/jobs/:id/purge', async (req: Request, res: Response) => {
    const r = await purgeJobs({ jobIds: [req.params.id] });
    return res.json(r);
  });

  // Hard delete — empty the whole trash. Requires explicit confirm (same as chat purge_all).
  app.post('/api/trash/purge-all', async (req: Request, res: Response) => {
    if (req.body?.confirm !== true) return res.status(400).json({ error: 'confirm:true required to empty the trash' });
    const r = await purgeJobs({ all: true });
    return res.json(r);
  });

  // /files/* — serve anything under outputDir. Path traversal guarded.
  app.get('/files/*', (req: Request, res: Response) => {
    const raw = (req.params as any)[0] as string;
    const abs = normalize(resolve(config.outputDir, raw));
    const rel = relative(config.outputDir, abs);
    if (rel.startsWith('..') || rel.includes(`${sep}..${sep}`) || abs === config.outputDir) {
      res.status(403).send('forbidden');
      return;
    }
    res.sendFile(abs, (err) => {
      if (err) res.status(404).send('not found');
    });
  });

  return app;
}
