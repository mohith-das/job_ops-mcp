// G5 — extract_stories, get_story_bank, negotiation_brief.

import { z } from 'zod';
import { randomUUID } from 'node:crypto';

import { getDb, runInWriteLock } from '../../db.js';
import { defineTool, okResult, errResult } from '../define.js';
import { getLatestReport } from '../../core/reports.js';
import { getMode } from '../../core/modes.js';
import { trackerUrl } from '../../core/links.js';

// ── extract_stories ──────────────────────────────────────────────────────────
//
// Reads block_interview from the latest eval_report for the job, parses STAR + Reflection
// rows out of the markdown table, and appends them to story_bank. The chat client can
// optionally pre-extract by passing `stories` directly (skips parsing).

const storyShape = z.object({
  story_text:      z.string().min(1),
  reflection:      z.string().nullish(),
  competency_tags: z.array(z.string()).nullish(),
});

export const extractStoriesTool = defineTool({
  name: 'extract_stories',
  title: 'Derive STAR+R stories from a job evaluation',
  description:
    'Pulls STAR + Reflection rows out of the latest eval_report.block_interview for the job and inserts them into story_bank. ' +
    'Pass `stories` to skip parsing and append a hand-curated list instead.',
    mutates: true,
inputSchema: {
    job_id:  z.string().min(1),
    stories: z.array(storyShape).optional(),
  },
  handler: async (args) => {
    let stories = args.stories ?? null;
    if (!stories) {
      const report = getLatestReport(args.job_id);
      if (!report) return errResult(`No eval report for ${args.job_id} — run evaluate_job first.`);
      stories = parseStoriesFromBlockF(report.block_interview ?? '');
      if (!stories.length) {
        return okResult({
          inserted: 0,
          note: 'No STAR+R rows found in the markdown table. Re-run with `stories` to supply them manually, or finalize a richer block_interview.',
          block_interview_chars: (report.block_interview ?? '').length,
        });
      }
    }
    const insertedIds = await runInWriteLock(() => {
      const db = getDb();
      const stmt = db.prepare(`
        INSERT INTO story_bank (id, job_id, story_text, reflection, competency_tags)
        VALUES (?, ?, ?, ?, ?)
      `);
      const ids: string[] = [];
      for (const s of stories!) {
        const id = randomUUID();
        stmt.run(id, args.job_id, s.story_text, s.reflection ?? null,
                  s.competency_tags ? JSON.stringify(s.competency_tags) : null);
        ids.push(id);
      }
      return ids;
    });
    return okResult({ inserted: insertedIds.length, ids: insertedIds });
  },
});

// Heuristic parser — looks for | … | … | … | rows after a header containing 'Story' / 'STAR' / 'Reflection'.
function parseStoriesFromBlockF(md: string): Array<{ story_text: string; reflection: string | null; competency_tags: string[] | null }> {
  const lines = md.split('\n');
  const out: Array<{ story_text: string; reflection: string | null; competency_tags: string[] | null }> = [];
  let pastHeader = false;
  for (const line of lines) {
    if (!pastHeader) {
      if (/^\s*\|\s*-+\s*\|/.test(line)) { pastHeader = true; continue; }
      continue;
    }
    if (!line.includes('|')) continue;
    const cells = line.split('|').slice(1, -1).map(c => c.trim()).filter(Boolean);
    if (cells.length < 2) continue;
    // The shape is roughly: [#, Requirement, Story, S, T, A, R, Reflection] OR [#, Requirement, Story, Reflection]
    const story = cells.slice(0, -1).join(' — ');
    const reflection = cells[cells.length - 1];
    const tags = extractCompetencyTags(story + ' ' + reflection);
    out.push({ story_text: story, reflection: reflection || null, competency_tags: tags.length ? tags : null });
  }
  return out;
}

const COMPETENCY_VOCAB = [
  'leadership','ownership','ambiguity','prioritization','stakeholder','cross-functional',
  'systems design','agentic','llm','evals','observability','data engineering','sql','product discovery',
  'roadmap','metrics','a/b testing','negotiation','customer-facing','delivery speed',
];
function extractCompetencyTags(s: string): string[] {
  const lower = s.toLowerCase();
  return [...new Set(COMPETENCY_VOCAB.filter(v => lower.includes(v)))];
}

// ── get_story_bank ───────────────────────────────────────────────────────────

export const getStoryBankTool = defineTool({
  name: 'get_story_bank',
  title: 'Story bank',
  description: 'Returns accumulated STAR+R stories. Optional competency filter (substring match on tags).',
  inputSchema: {
    competency: z.string().optional(),
    limit:      z.number().int().min(1).max(500).default(100),
  },
  handler: async (args) => {
    const rows = getDb().prepare(`
      SELECT s.id, s.story_text, s.reflection, s.competency_tags, s.created_at,
             s.job_id, j.title AS job_title, COALESCE(c.name, j.company_name_raw) AS company_name
      FROM story_bank s
      LEFT JOIN jobs j ON j.id = s.job_id
      LEFT JOIN companies c ON c.id = j.company_id
      ORDER BY datetime(s.created_at) DESC
      LIMIT ?
    `).all(args.limit) as any[];
    const filtered = args.competency
      ? rows.filter(r => (r.competency_tags ?? '').toLowerCase().includes(args.competency!.toLowerCase()))
      : rows;
    return okResult({
      count: filtered.length,
      items: filtered.map(r => ({
        ...r,
        competency_tags: r.competency_tags ? JSON.parse(r.competency_tags) : null,
      })),
    });
  },
mutates: false,
  });

// ── negotiation_brief ────────────────────────────────────────────────────────

export const negotiationBriefTool = defineTool({
  name: 'negotiation_brief',
  title: 'Negotiation brief for a job',
  description:
    'Returns the negotiation_playbook + the most recent comp enrichment for the company + a draft framework. ' +
    'Chat-mode default; api-mode tailors via LLM.',
  inputSchema: {
    job_id: z.string().min(1),
    mode:   z.enum(['chat','api']).default('chat'),
  },
  handler: async (args) => {
    const db = getDb();
    const job = db.prepare(`
      SELECT j.*, COALESCE(c.name, j.company_name_raw) AS company_name, c.id AS resolved_company_id
      FROM jobs j LEFT JOIN companies c ON c.id = j.company_id WHERE j.id = ?
    `).get(args.job_id) as any;
    if (!job) return errResult(`No job ${args.job_id}`);
    const enrichment = db.prepare(`
      SELECT kind, summary, confidence_score, signal_quality, source_urls
      FROM enrichment WHERE company_id = ? AND kind = 'comp' AND datetime(expires_at) > datetime('now')
    `).get(job.resolved_company_id) as any;
    const playbook = getMode('negotiation_playbook.md');

    return okResult({
      job: { id: job.id, title: job.title, company: job.company_name,
              location: job.location_raw, comp_min_usd: job.comp_min_usd, comp_max_usd: job.comp_max_usd },
      comp_enrichment: enrichment ?? null,
      playbook,
      framework: {
        anchor:   'Total comp (base + sign-on + equity + bonus + benefits), never base alone',
        pillars:  [
          'Salary framework anchored on market band',
          'Geographic-discount pushback (challenge silent geo adjustments)',
          'Competing-offer leverage only when REAL (named company, named stage)',
        ],
        knobs:    ['sign-on', 'equity refresh', 'title', 'remote stipend', 'start date', '6-month review'],
        hard_rules: [
          'Never accept verbally same-day',
          'Visa / OPT stays out of negotiation until comp is in writing',
          'Do not negotiate against yourself',
        ],
      },
      tracker_url: trackerUrl(),
    });
  },
  mutates: true,
 
});
