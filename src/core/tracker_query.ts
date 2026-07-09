// Shared tracker query: filter + search + sort + paginate, in SQL (efficient at 1000+ rows —
// WHERE/LIMIT/OFFSET + a COUNT for the total, never in-memory filtering of everything). Used
// by BOTH the get_tracker MCP tool and the dashboard UI, so the logic lives in one place.

import { getDb } from '../db.js';
import { fileUrl } from './links.js';
import { JOB_STATUSES } from './job_trash.js';

export type TrackerSort = 'score' | 'discovered' | 'company';
export type SortDir = 'asc' | 'desc';

export interface TrackerQuery {
  statuses?:      string[];   // status IN (...)
  min_score?:     number;
  max_score?:     number;
  company?:       string;     // case-insensitive contains
  role_category?: string;     // exact
  seniority?:     string;     // case-insensitive contains
  q?:             string;     // case-insensitive contains on title OR company
  show_trashed?:  boolean;    // default false → trashed excluded
  sort?:          TrackerSort;
  dir?:           SortDir;
  limit?:         number;     // page size
  offset?:        number;
}

export interface TrackerItem {
  job_id: string; title: string; company_name: string;
  score_total: number | null; role_category: string | null; seniority: string | null;
  location: string | null; status: string; source_url: string;
  discovered_at: string | null; scored_at: string | null; applied_at: string | null;
  trashed: boolean;
  report_url: string | null; resume_url: string | null; cover_url: string | null;
  resume_tex_url: string | null; cover_tex_url: string | null;
}

export interface TrackerResult {
  items: TrackerItem[];
  total: number;          // total rows MATCHING the filter (across all pages)
  limit: number;
  offset: number;
}

const VALID_STATUS = new Set<string>(JOB_STATUSES);

/** Build the shared WHERE clause + bound params from a query (no LIMIT/ORDER). */
function buildWhere(qr: TrackerQuery): { clause: string; params: any[] } {
  const where: string[] = [];
  const params: any[] = [];
  if (!qr.show_trashed) where.push('j.trashed_at IS NULL');

  const statuses = (qr.statuses ?? []).filter(s => VALID_STATUS.has(s));
  if (statuses.length) {
    where.push(`j.status IN (${statuses.map(() => '?').join(',')})`);
    params.push(...statuses);
  }
  if (typeof qr.min_score === 'number') { where.push('j.score_total >= ?'); params.push(qr.min_score); }
  if (typeof qr.max_score === 'number') { where.push('j.score_total <= ?'); params.push(qr.max_score); }
  if (qr.company?.trim()) { where.push('LOWER(COALESCE(c.name, j.company_name_raw)) LIKE ?'); params.push(`%${qr.company.trim().toLowerCase()}%`); }
  if (qr.role_category?.trim()) { where.push('j.role_category = ?'); params.push(qr.role_category.trim()); }
  if (qr.seniority?.trim()) { where.push('LOWER(COALESCE(j.seniority,\'\')) LIKE ?'); params.push(`%${qr.seniority.trim().toLowerCase()}%`); }
  if (qr.q?.trim()) {
    const like = `%${qr.q.trim().toLowerCase()}%`;
    where.push('(LOWER(j.title) LIKE ? OR LOWER(COALESCE(c.name, j.company_name_raw)) LIKE ?)');
    params.push(like, like);
  }
  return { clause: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

function orderBy(sort: TrackerSort | undefined, dir: SortDir | undefined): string {
  const d = dir === 'asc' ? 'ASC' : 'DESC';
  switch (sort) {
    case 'company':    return `company_name COLLATE NOCASE ${d}, j.score_total DESC`;
    case 'discovered': return `datetime(j.discovered_at) ${d}, j.score_total DESC`;
    case 'score':
    default:           return `j.score_total ${d} NULLS LAST, datetime(j.discovered_at) DESC`;
  }
}

/**
 * Run the filtered/sorted/paginated query. Returns the page of items plus `total` = the count
 * of ALL rows matching the filter (for page math), via a separate COUNT on the same WHERE.
 */
export function queryTracker(qr: TrackerQuery): TrackerResult {
  const db = getDb();
  const { clause, params } = buildWhere(qr);
  const limit  = Math.max(1, Math.min(qr.limit ?? 50, 500));
  const offset = Math.max(0, qr.offset ?? 0);

  const total = (db.prepare(`
    SELECT COUNT(*) AS n
    FROM jobs j LEFT JOIN companies c ON c.id = j.company_id
    ${clause}
  `).get(...params) as { n: number }).n;

  const rows = db.prepare(`
    SELECT
      j.id AS job_id, j.title,
      COALESCE(c.name, j.company_name_raw) AS company_name,
      j.score_total, j.role_category, j.seniority,
      j.location_raw AS location, j.status, j.source_url,
      j.discovered_at, j.scored_at, j.applied_at, j.trashed_at,
      (SELECT er.html_path FROM eval_reports er WHERE er.job_id = j.id ORDER BY er.created_at DESC LIMIT 1) AS report_html,
      (SELECT a.resume_path FROM applications a WHERE a.job_id = j.id LIMIT 1) AS resume_path,
      (SELECT a.cover_path  FROM applications a WHERE a.job_id = j.id LIMIT 1) AS cover_path,
      (SELECT a.rendered_files FROM applications a WHERE a.job_id = j.id LIMIT 1) AS rendered_files
    FROM jobs j LEFT JOIN companies c ON c.id = j.company_id
    ${clause}
    ORDER BY ${orderBy(qr.sort, qr.dir)}
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset) as any[];

  const items: TrackerItem[] = rows.map(r => {
    let rendered: any = null;
    try { rendered = r.rendered_files ? JSON.parse(r.rendered_files) : null; } catch {}
    return {
      job_id: r.job_id, title: r.title, company_name: r.company_name,
      score_total: r.score_total, role_category: r.role_category, seniority: r.seniority,
      location: r.location, status: r.status, source_url: r.source_url,
      discovered_at: r.discovered_at, scored_at: r.scored_at, applied_at: r.applied_at,
      trashed: !!r.trashed_at,
      report_url: r.report_html ? fileUrl(r.report_html) : null,
      resume_url: r.resume_path ? fileUrl(r.resume_path) : null,
      cover_url:  r.cover_path  ? fileUrl(r.cover_path)  : null,
      resume_tex_url: rendered?.resume?.tex ? fileUrl(rendered.resume.tex) : null,
      cover_tex_url:  rendered?.cover?.tex  ? fileUrl(rendered.cover.tex)  : null,
    };
  });

  return { items, total, limit, offset };
}

/**
 * Full-pipeline status counts (trashed always excluded). INDEPENDENT of any filter/search —
 * the summary cards always reflect the whole pipeline, not the current page/filter.
 */
export function pipelineCounts(): Record<string, number> & { total: number } {
  const rows = getDb().prepare(
    `SELECT status, COUNT(*) AS n FROM jobs WHERE trashed_at IS NULL GROUP BY status`,
  ).all() as { status: string; n: number }[];
  const out: Record<string, number> & { total: number } = { total: 0 } as any;
  for (const s of JOB_STATUSES) out[s] = 0;
  for (const r of rows) { out[r.status] = r.n; out.total += r.n; }
  return out;
}

/** Distinct company names present (active jobs), for a filter dropdown. */
export function distinctCompanies(limit = 500): string[] {
  return (getDb().prepare(`
    SELECT DISTINCT COALESCE(c.name, j.company_name_raw) AS name
    FROM jobs j LEFT JOIN companies c ON c.id = j.company_id
    WHERE j.trashed_at IS NULL AND name IS NOT NULL AND name <> ''
    ORDER BY name COLLATE NOCASE ASC LIMIT ?
  `).all(limit) as { name: string }[]).map(r => r.name);
}
