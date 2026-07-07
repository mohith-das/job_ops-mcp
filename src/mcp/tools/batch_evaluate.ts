// batch_evaluate — api path. Rates all unrated (score_total IS NULL) jobs through the
// configured LLM with the rubric. Strict JSON parse with PARSE_ERROR fallback: failed
// jobs stay unrated and their score_detail records the parse_error + raw — never silent
// zeros (study guide §4.3 gotcha).

import { z } from 'zod';

import { config } from '../../config.js';
import { getDb, runInWriteLock } from '../../db.js';
import { defineTool, okResult, errResult } from '../define.js';
import { getMode } from '../../core/modes.js';
import { combineNoVisa } from '../../core/reports.js';
import { pickCompleter, type Completer } from '../../core/scoring.js';

const ROLE_CATEGORIES = ['pm','ml_eng','data_eng','analytics_eng','swe','forward_deployed','other'] as const;

export const batchEvaluateTool = defineTool({
  name: 'batch_evaluate',
  title: 'Batch-rate unrated jobs via LLM',
  description:
    'Selects unrated jobs (score_total IS NULL) matching the optional filter and rates each. ' +
    'Prefers MCP sampling (your connected client\'s model — no API key needed); falls back to a ' +
    'BYO LLM key (Gemini/DeepSeek) when the client does not support sampling. Returns an A-F tier ' +
    'distribution and any parse-error count. Never produces silent zeros.',
    mutates: true,
inputSchema: {
    role_category: z.enum(ROLE_CATEGORIES).optional(),
    company:       z.string().optional().describe('Substring match on company name.'),
    limit:         z.number().int().min(1).max(500).default(50),
    concurrency:   z.number().int().min(1).max(8).default(2),
  },
  handler: async (args, ctx) => {
    const picked = pickCompleter(ctx?.bridge);
    if (!picked) {
      return errResult(
        'No scoring backend available. Either: connect an MCP client that supports sampling ' +
        '(no key needed), OR set JOBOPS_LLM_PROVIDER=gemini with GEMINI_API_KEY, OR use ' +
        'evaluate_job mode=chat for the manual path.',
      );
    }
    const rubric = getMode('rubric.md');
    if (!rubric || rubric.startsWith('_missing')) return errResult('modes/rubric.md missing');

    // Pick jobs.
    const where: string[] = ['j.trashed_at IS NULL', 'j.score_total IS NULL', `j.status NOT IN ('rejected','discarded','skip')`];
    const params: any[] = [];
    if (args.role_category) { where.push('j.role_category = ?'); params.push(args.role_category); }
    if (args.company)       { where.push('LOWER(COALESCE(c.name, j.company_name_raw)) LIKE ?'); params.push(`%${args.company.toLowerCase()}%`); }
    const rows = getDb().prepare(`
      SELECT j.id, j.title, COALESCE(c.name, j.company_name_raw) AS company_name,
             j.location_raw AS location, j.description
      FROM jobs j LEFT JOIN companies c ON c.id = j.company_id
      WHERE ${where.join(' AND ')}
      ORDER BY datetime(j.discovered_at) DESC LIMIT ?
    `).all(...params, args.limit) as any[];

    if (!rows.length) return okResult({ rated: 0, distribution: emptyDist(), parse_errors: 0, items: [] });

    const distribution = emptyDist();
    let parseErrors = 0;
    const items: any[] = [];

    // Bounded-concurrency loop without an extra dep.
    const queue = rows.slice();
    const workers = Array.from({ length: Math.min(args.concurrency, queue.length) }, async () => {
      while (queue.length) {
        const job = queue.shift()!;
        try {
          const res = await rateOne(job, rubric, picked.completer);
          tierBump(distribution, res?.score_total);
          if (!res?.parsed) parseErrors++;
          items.push({ job_id: job.id, title: job.title, company: job.company_name,
                       score_total: res?.score_total ?? null, role_category: res?.role_category ?? null,
                       parse_ok: !!res?.parsed });
        } catch (e: any) {
          parseErrors++;
          items.push({ job_id: job.id, title: job.title, company: job.company_name, error: e?.message ?? String(e) });
        }
      }
    });
    await Promise.all(workers);

    return okResult({
      rated: items.length - parseErrors,
      parse_errors: parseErrors,
      scored_via: picked.kind,   // 'sampling' (client model, no key) or 'api' (BYO key)
      distribution,
      items: items.slice().sort((a, b) => (b.score_total ?? -1) - (a.score_total ?? -1)),
    });
  },
});

async function rateOne(job: any, rubric: string, complete: Completer): Promise<{ parsed: any; score_total: number | null; role_category?: string }> {
  const system = rubric +
    '\n\n== INSTRUCTIONS ==\nScore the JD below per the rubric. Output ONLY the strict JSON object specified in "Output contract (chat mode)". No prose outside JSON.';
  const user = `JOB title: ${job.title}\nCompany: ${job.company_name}\nLocation: ${job.location ?? ''}\n\nDESCRIPTION:\n${(job.description ?? '').slice(0, 8000)}`;
  const call = await complete('batch_evaluate', [
    { role: 'system', content: system }, { role: 'user', content: user },
  ], { temperature: 0.2, jobId: job.id });

  if (!call.parseOk) {
    // Persist parse error — keep score_total NULL so it stays in unrated bucket for retry.
    await runInWriteLock(() => {
      getDb().prepare(`
        UPDATE jobs SET score_detail = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
      `).run(JSON.stringify({ parse_error: call.parseError, raw: call.text.slice(0, 800), mode: 'api', llm_call_id: call.id }), job.id);
    });
    return { parsed: null, score_total: null };
  }
  const p = call.parsed as any;
  const resumeFit = clampInt(p.resume_fit);
  const tasteFit  = clampInt(p.taste_fit);
  const visaFit   = config.visaScoringEnabled ? clampInt(p.visa_fit) : null;
  const score = config.visaScoringEnabled
    ? clampInt(p.score_total ?? null)
    : combineNoVisa(resumeFit, tasteFit);
  await runInWriteLock(() => {
    getDb().prepare(`
      UPDATE jobs SET
        score_total = ?, score_resume_fit = ?, score_taste_fit = ?, score_visa_fit = ?,
        role_category = COALESCE(?, role_category),
        seniority = COALESCE(?, seniority),
        score_detail = ?, scored_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      score, resumeFit, tasteFit, visaFit,
      p.role_category ?? null, p.seniority ?? null,
      JSON.stringify({ ...p, mode: 'api', llm_call_id: call.id, visa_scoring_enabled: config.visaScoringEnabled }),
      job.id,
    );
  });
  return { parsed: p, score_total: score, role_category: p.role_category };
}

function clampInt(n: any): number | null {
  if (n === null || n === undefined) return null;
  const x = Number(n);
  if (!Number.isFinite(x)) return null;
  return Math.max(0, Math.min(100, Math.round(x)));
}

function emptyDist() { return { A: 0, B: 0, C: 0, D: 0, F: 0, unrated: 0 }; }
function tierBump(d: any, score: number | null | undefined) {
  if (score == null) { d.unrated++; return; }
  if (score >= 85) d.A++;
  else if (score >= 75) d.B++;
  else if (score >= 60) d.C++;
  else if (score >= 40) d.D++;
  else d.F++;
}

