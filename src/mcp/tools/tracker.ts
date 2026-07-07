// G1 — read tools + state transitions on jobs.
//
// All writes serialize through runInWriteLock (db.ts).

import { z } from 'zod';

import { config } from '../../config.js';
import { getDb, runInWriteLock } from '../../db.js';
import { defineTool, okResult, errResult } from '../define.js';
import { fileUrl, trackerUrl } from '../../core/links.js';
import { JOB_STATUSES, setJobStatus } from '../../core/job_trash.js';
import { queryTracker, pipelineCounts } from '../../core/tracker_query.js';

// Canonical lifecycle states (the CHECK on jobs.status is the hard guard). Shared with the
// trash/UI logic via core/job_trash.ts so there's one list.
const STATUSES = JOB_STATUSES;

const ROLE_CATEGORIES = ['pm','ml_eng','data_eng','analytics_eng','swe','forward_deployed','other'] as const;

// ── get_top_jobs ─────────────────────────────────────────────────────────────

export const getTopJobsTool = defineTool({
  name: 'get_top_jobs',
  title: 'Top scored jobs (triage)',
  description:
    'Triage view of rated jobs, filterable by min score, role_category, and status. Default min_score=75, limit=20. ' +
    'Use a non-default `role_category` to get a per-role lane (e.g. PM-only).',
  inputSchema: {
    min_score:     z.number().int().min(0).max(100).default(75),
    role_category: z.enum(ROLE_CATEGORIES).optional(),
    status:        z.enum(STATUSES).optional(),
    limit:         z.number().int().min(1).max(200).default(20),
  },
  handler: async (args) => {
    const where = ['j.trashed_at IS NULL', 'j.score_total IS NOT NULL', 'j.score_total >= ?'];
    const params: any[] = [args.min_score];
    if (args.role_category) { where.push('j.role_category = ?'); params.push(args.role_category); }
    if (args.status)        { where.push('j.status = ?');        params.push(args.status); }
    const rows = getDb().prepare(`
      SELECT
        j.id AS job_id,
        j.title,
        COALESCE(c.name, j.company_name_raw) AS company_name,
        j.score_total, j.score_resume_fit, j.score_taste_fit, j.score_visa_fit,
        j.role_category, j.seniority, j.location_raw AS location,
        j.status, j.source_url, j.discovered_at, j.scored_at,
        (SELECT er.html_path FROM eval_reports er WHERE er.job_id = j.id ORDER BY er.created_at DESC LIMIT 1) AS report_html
      FROM jobs j
      LEFT JOIN companies c ON c.id = j.company_id
      WHERE ${where.join(' AND ')}
      ORDER BY j.score_total DESC, datetime(j.discovered_at) DESC
      LIMIT ?
    `).all(...params, args.limit) as any[];

    const items = rows.map(r => {
      const out: any = {
        ...r,
        report_url: r.report_html ? fileUrl(r.report_html) : null,
        report_html: undefined,
      };
      if (!config.visaScoringEnabled) delete out.score_visa_fit;
      return out;
    });
    return okResult({ count: items.length, min_score: args.min_score, items });
  },
mutates: false,
  });

// ── get_tracker ──────────────────────────────────────────────────────────────

export const getTrackerTool = defineTool({
  name: 'get_tracker',
  title: 'Tracker view (JSON)',
  description:
    'Filtered/paginated pipeline snapshot — the same query that powers the dashboard at /. '
    + 'Combine status(es), score range, company/title search, role/seniority, sort, and limit/offset '
    + '(e.g. "applied jobs scored over 70, page 2"). counts_by_status is always the FULL pipeline '
    + '(trashed excluded), independent of the filter. Trashed jobs are excluded unless show_trashed.',
  inputSchema: {
    status:        z.enum(STATUSES).optional().describe('Single-status filter (back-compat).'),
    statuses:      z.array(z.enum(STATUSES)).optional().describe('Multi-status filter (status IN ...).'),
    min_score:     z.number().int().min(0).max(100).optional(),
    max_score:     z.number().int().min(0).max(100).optional(),
    company:       z.string().optional().describe('Case-insensitive contains on company name.'),
    role_category: z.string().optional(),
    seniority:     z.string().optional().describe('Case-insensitive contains on seniority/level.'),
    q:             z.string().optional().describe('Case-insensitive search on title OR company.'),
    show_trashed:  z.boolean().optional().describe('Include trashed jobs (default false).'),
    sort:          z.enum(['score', 'discovered', 'company']).optional().describe('Default: score.'),
    dir:           z.enum(['asc', 'desc']).optional().describe('Default: desc.'),
    limit:         z.number().int().min(1).max(500).default(100),
    offset:        z.number().int().min(0).optional(),
  },
  handler: async (args) => {
    const statuses = args.statuses ?? (args.status ? [args.status] : undefined);
    const r = queryTracker({
      statuses, min_score: args.min_score, max_score: args.max_score,
      company: args.company, role_category: args.role_category, seniority: args.seniority,
      q: args.q, show_trashed: args.show_trashed, sort: args.sort, dir: args.dir,
      limit: args.limit, offset: args.offset,
    });
    return okResult({
      counts_by_status: pipelineCounts(),
      total_matching:   r.total,        // across all pages (for the current filter)
      filtered_count:   r.items.length, // this page
      limit:            r.limit,
      offset:           r.offset,
      tracker_url:      trackerUrl(),
      items: r.items,
    });
  },
mutates: false,
  });

// ── update_status ────────────────────────────────────────────────────────────

export const updateStatusTool = defineTool({
  name: 'update_status',
  title: 'Update job status',
  description: 'Move a job to a new canonical status. Stamps applied_at when transitioning to "applied".',
  inputSchema: {
    job_id: z.string().min(1),
    status: z.enum(STATUSES),
    note:   z.string().optional(),
  },
  handler: async (args) => {
    const result = await setJobStatus(args.job_id, args.status, args.note);
    if (!result.ok) return errResult(result.message);
    return okResult({ job_id: args.job_id, from: result.from, to: result.to });
  },
  mutates: true,
 
});

// ── mark_ready_to_apply ──────────────────────────────────────────────────────

export const markReadyToApplyTool = defineTool({
  name: 'mark_ready_to_apply',
  title: 'Bulk-mark jobs ready to apply',
  description: 'Bulk-sets job status to ready_to_apply. Skips jobs in terminal states (applied/screen/onsite/offer/rejected/discarded).',
  inputSchema: { job_ids: z.array(z.string().min(1)).min(1).max(200) },
  handler: async (args) => {
    const TERMINAL = new Set(['applied','screen','onsite','offer','rejected','discarded']);
    const summary = await runInWriteLock(() => {
      const db = getDb();
      const tx = db.transaction((ids: string[]) => {
        const out = { updated: [] as string[], skipped: [] as { job_id: string; reason: string }[] };
        const sel = db.prepare('SELECT status FROM jobs WHERE id = ?');
        const upd = db.prepare(`UPDATE jobs SET status = 'ready_to_apply', updated_at = CURRENT_TIMESTAMP WHERE id = ?`);
        for (const id of ids) {
          const row = sel.get(id) as { status: string } | undefined;
          if (!row) { out.skipped.push({ job_id: id, reason: 'not found' }); continue; }
          if (TERMINAL.has(row.status)) {
            out.skipped.push({ job_id: id, reason: `terminal state ${row.status}` }); continue;
          }
          upd.run(id);
          out.updated.push(id);
        }
        return out;
      });
      return tx(args.job_ids);
    });
    return okResult({ updated_count: summary.updated.length, ...summary });
  },
  mutates: true,
 
});

