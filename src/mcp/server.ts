// MCP server wiring.
//
// Stateless mode: one fresh McpServer per HTTP request. For a local single-user process
// the per-request setup is microseconds and the lifecycle is dramatically simpler than
// session-based mode (no Map<sessionId, transport>, no GC).
//
// MULTI-CLIENT SAFETY: the fresh-per-request server is load-bearing, not a style
// choice. The SDK's Protocol holds ONE transport reference — a single McpServer
// shared across overlapping requests would route client A's response through
// client B's connection. A fresh server per request gives every concurrent
// client (Claude Desktop, Claude Code, opencode, codex, …) an isolated protocol
// instance over the same shared tool implementations + one SQLite DB.
//
// Tool registration follows src/mcp/define.ts — every tool exports a single ToolDef.
// To add a tool: write src/mcp/tools/<name>.ts that exports `<name>Tool`, import it
// below, and add it to ALL_TOOLS. resources/list comes from src/core/resources.ts.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Express, Request, Response } from 'express';

import { config } from '../config.js';
import { listResources } from '../core/resources.js';
import { recordClientInitialize, recordMcpRequest } from '../core/server_status.js';
import { registerTools, type AnyToolDef } from './define.js';
import { setDuplexCapable } from './client_bridge.js';

// ── Tool imports ─────────────────────────────────────────────────────────────
// Keep this block ordered by the brief's grouping for at-a-glance navigation.

// M1 — eval & PDFs
import { evaluateJobTool } from './tools/evaluate_job.js';
import { renderPdfTool    } from './tools/render_pdf.js';
import { getReportTool    } from './tools/get_report.js';

// G1 — tracker queries + mutators
import { getTopJobsTool, getTrackerTool, updateStatusTool, markReadyToApplyTool } from './tools/tracker.js';
import { deleteJobsTool, restoreJobsTool, listTrashedTool, purgeJobsTool } from './tools/job_trash.js';

// G2 — portal scanner
import { scanPortalsTool } from './tools/scan_portals.js';

// G3 — outreach
import {
  findWarmIntrosTool, findFoundersTool, draftOutreachTool, getOutreachQueueTool,
  updateOutreachTool, getFollowupsDueTool, draftFollowupTool, draftReplyTool,
} from './tools/outreach.js';

// G4 — visa
import { visaSignalTool, importH1bTool, importLinkedinTool } from './tools/visa.js';
import { addContactsTool } from './tools/add_contacts.js';
import { exportContactsTool, importContactsTool, deleteContactsTool } from './tools/contacts_io.js';

// G5 — stories + negotiation
import { extractStoriesTool, getStoryBankTool, negotiationBriefTool } from './tools/stories.js';
import { getStoryBankPublicTool } from './tools/stories_public.js';

// G6 — batch + materials
import { batchEvaluateTool   } from './tools/batch_evaluate.js';
import { generateMaterialsTool } from './tools/generate_materials.js';

// G7 — training/project/research/digest + profile ops
import {
  evaluateTrainingTool, evaluateProjectTool, deepResearchTool, dailyDigestTool,
  getCareerPacketTool, updateCareerPacketTool, enrichCompanyTool, costEstimateTool,
} from './tools/ops.js';
import { reseedCareerPacketTool } from './tools/reseed.js';
import { syncPacketToCvTool } from './tools/sync_packet.js';
import { editPacketItemTool, removePacketItemTool, restorePacketVersionTool } from './tools/packet_edit.js';
import { updateProfileTool } from './tools/profile_elicit.js';
import { doctorTool } from './tools/doctor.js';

// G8 — apply prefill
import { applyPrefillTool } from './tools/apply_prefill.js';

// G9 — scheduler
import { schedulerStatusTool, schedulerEnableTool, schedulerDisableTool } from './tools/scheduler.js';
import {
  configureGithubSyncTool, syncGithubTool, setGithubAutoSyncTool, githubSyncStatusTool, listGithubRepositoriesTool,
  updateGithubRepositoryTool, listGithubProposalsTool, approveGithubProposalTool,
  rejectGithubProposalTool,
} from './tools/github_sync.js';

// G10 — federation (career-packet.json, LivingCV sync, embeddings, HireBridge)
import { compileCareerPacketTool, getCareerPacketJsonTool } from './tools/career_packet_json.js';
import { generateEmbeddingsTool, getEmbeddingsTool } from './tools/embeddings.js';
import { syncToLivingCVTool } from './tools/sync_to_livingcv.js';
import { broadcastSignalTool, getFederationStatusTool } from './tools/signal_broadcast.js';
import { updateJobopsTool } from './tools/update_jobops.js';

// Tools tagged "visa" are hidden from tools/list when JOBOPS_VISA_SCORING=false.
const VISA_TOOL_NAMES: ReadonlySet<string> = new Set([
  'visa_signal', 'import_h1b', 'import_linkedin',
]);

const FULL_TOOLSET: AnyToolDef[] = [
  evaluateJobTool, renderPdfTool, getReportTool,
  getTopJobsTool, getTrackerTool, updateStatusTool, markReadyToApplyTool,
  deleteJobsTool, restoreJobsTool, listTrashedTool, purgeJobsTool,
  scanPortalsTool,
  findWarmIntrosTool, findFoundersTool, draftOutreachTool, getOutreachQueueTool,
  updateOutreachTool, getFollowupsDueTool, draftFollowupTool, draftReplyTool,
  visaSignalTool, importH1bTool, importLinkedinTool,
  addContactsTool, exportContactsTool, importContactsTool, deleteContactsTool,
  extractStoriesTool, getStoryBankTool, negotiationBriefTool, getStoryBankPublicTool,
  batchEvaluateTool, generateMaterialsTool,
  evaluateTrainingTool, evaluateProjectTool, deepResearchTool, dailyDigestTool,
  getCareerPacketTool, updateCareerPacketTool, reseedCareerPacketTool, syncPacketToCvTool,
  editPacketItemTool, removePacketItemTool, restorePacketVersionTool,
  updateProfileTool, enrichCompanyTool, costEstimateTool,
  doctorTool,
  applyPrefillTool,
  schedulerStatusTool, schedulerEnableTool, schedulerDisableTool,
  configureGithubSyncTool, syncGithubTool, setGithubAutoSyncTool, githubSyncStatusTool, listGithubRepositoriesTool,
  updateGithubRepositoryTool, listGithubProposalsTool, approveGithubProposalTool, rejectGithubProposalTool,
  compileCareerPacketTool, getCareerPacketJsonTool,
  generateEmbeddingsTool, getEmbeddingsTool,
  syncToLivingCVTool,
  broadcastSignalTool, getFederationStatusTool,
  updateJobopsTool,
];

const ALL_TOOLS: AnyToolDef[] = config.visaScoringEnabled
  ? FULL_TOOLSET
  : FULL_TOOLSET.filter(t => !VISA_TOOL_NAMES.has(t.name));

function pkgVersion(): string {
  try {
    return JSON.parse(readFileSync(resolve(config.installDir, 'package.json'), 'utf-8')).version ?? '0.0.0';
  } catch { return '0.0.0'; }
}
const PKG_VERSION = pkgVersion();

// The public-facing MCP surface (mounted at /mcp/public) exposes EXACTLY the
// tools that opt-in to `publicSafe`. Per the closed-surface policy (§5), every
// other jobops tool leaks operator-only data — active pipeline, negotiation
// posture, visa, contacts/PII, or server internals — and is intentionally
// unreachable from anonymous recruiter clients.
//
// `PUBLIC_TOOLS` is derived from ALL_TOOLS at module load (after the visa
// toggle) so flipping the visa flag automatically updates the public surface.
const PUBLIC_TOOLS: AnyToolDef[] = ALL_TOOLS.filter((t) => t.publicSafe === true);

export function getPublicTools(): ReadonlyArray<AnyToolDef> {
  return PUBLIC_TOOLS;
}

// Tools and resources are static, but each protocol instance must be fresh — see the
// multi-client note in the header. Registration is microseconds; correctness first.
function buildMcpServer(tools: AnyToolDef[] = ALL_TOOLS): McpServer {
  const server = new McpServer({ name: 'jobops', version: PKG_VERSION });
  registerTools(server, tools);
  for (const r of listResources()) {
    server.registerResource(
      r.name, r.uri,
      { title: r.title, description: r.description, mimeType: r.mimeType },
      async () => ({ contents: [{ uri: r.uri, mimeType: r.mimeType, text: r.body() }] }),
    );
  }
  return server;
}

/** Best-effort client tracking for /api/status + the CLI `status` command. */
function recordRequestForStatus(req: Request): void {
  recordMcpRequest();
  const body = req.body;
  const messages = Array.isArray(body) ? body : [body];
  for (const m of messages) {
    if (m && typeof m === 'object' && m.method === 'initialize') {
      const info = m.params?.clientInfo ?? {};
      recordClientInitialize({
        name:    typeof info.name === 'string' ? info.name : undefined,
        version: typeof info.version === 'string' ? info.version : undefined,
        remote:  req.ip,
      });
    }
  }
}

export function mountMcp(app: Express, path = '/mcp', tools: AnyToolDef[] = ALL_TOOLS): void {
  const handle = async (req: Request, res: Response) => {
    recordRequestForStatus(req);
    // Fresh server + transport per request — complete isolation between
    // concurrent clients (one shared instance would cross-route responses).
    // The `tools` argument lets callers (e.g. the public mount in src/server.ts)
    // register a strictly narrower surface.
    const server = buildMcpServer(tools);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on('close', () => {
      transport.close().catch(() => undefined);
      server.close().catch(() => undefined);
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err: any) {
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error:   { code: -32603, message: err?.message ?? 'internal error' },
          id:      null,
        });
      }
    }
  };

  app.post(path, handle);
  app.get(path,    (_req: Request, res: Response) => res.status(405).end());
  app.delete(path, (_req: Request, res: Response) => res.status(405).end());
}

export function listAllTools(): AnyToolDef[] { return ALL_TOOLS; }

// ── stdio transport ─────────────────────────────────────────────────────────
// Used by Claude Desktop and any other MCP client that only speaks stdio.
// Blocks until stdin closes (the client disconnects). In stdio mode the caller
// must keep stdout clean — all logging in this process already goes to stderr.
export async function serveStdio(): Promise<void> {
  // stdio carries bidirectional traffic, so server→client requests (MCP sampling +
  // elicitation) can actually be delivered. The HTTP transport (stateless + JSON) cannot,
  // so it leaves this false and those features gate off → clients fall back gracefully.
  setDuplexCapable(true);
  recordClientInitialize({ name: 'stdio-client', version: '?', remote: 'stdio' });
  // stdio is exactly one client for the process lifetime — a single instance is safe here.
  const server = buildMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Server runs until transport closes; transport.onclose fires when stdin EOFs.
  await new Promise<void>((resolve) => {
    transport.onclose = () => resolve();
  });
}
