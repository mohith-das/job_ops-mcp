// evaluate_job — two-step chat-mode evaluator.
//
// Step 1: caller passes `input` (URL or pasted JD). Server normalizes, persists a job row,
//         returns { job_id, normalized_jd, rubric, report_format, career_packet } so the
//         chat client can score + draft the 6-block report.
// Step 2: caller calls evaluate_job again with the same job_id + a `report` payload + scores.
//         Server persists the eval_report, updates job scores, returns the report link.
//
// api mode: requires GEMINI_API_KEY or DEEPSEEK_API_KEY. Runs both scoring + the 6-block
// report through the LLM with the rubric/report_format as system messages. Strict JSON
// parsing — never silent zeros (see core/llm.ts parseJsonStrict).

import { z } from 'zod';

import { adoptJobFromJD, getJob } from '../../core/jobs.js';
import { normalizeJD } from '../../core/jd_normalize.js';
import { saveReport, type ReportBlocks } from '../../core/reports.js';
import { getActiveCareerPacket } from '../../core/profile.js';
import { getMode } from '../../core/modes.js';
import { trackerUrl } from '../../core/links.js';
import { pickCompleter } from '../../core/scoring.js';
import { defineTool, okResult, errResult } from '../define.js';

const reportBlocks = {
  archetype_detected: z.string().nullish(),
  block_role_summary: z.string().nullish(),
  block_cv_match:     z.string().nullish(),
  block_level:        z.string().nullish(),
  block_comp:         z.string().nullish(),
  block_personalize:  z.string().nullish(),
  block_interview:    z.string().nullish(),
  block_legitimacy:   z.string().nullish(),
  keywords:           z.array(z.string()).nullish(),
};

const scores = {
  resume_fit:    z.number().int().min(0).max(100).optional(),
  taste_fit:     z.number().int().min(0).max(100).optional(),
  visa_fit:      z.number().int().min(0).max(100).optional(),
  score_total:   z.number().int().min(0).max(100).optional(),
  reasoning:     z.string().optional(),
  concerns:      z.string().nullish(),
  role_category: z.string().optional(),
  seniority:     z.string().optional(),
};

export const evaluateJobTool = defineTool({
  name: 'evaluate_job',
  title: 'Evaluate a job',
  description:
    'Two-step JD evaluator. Step 1: pass `input` (URL or pasted JD) to get rubric + normalized JD. ' +
    'Step 2: pass `job_id` + `report` + `scores` to persist the 6-block report and return its localhost link. ' +
    'mode="api" runs both steps server-side via the configured LLM.',
    mutates: true,
inputSchema: {
    input:    z.string().min(1).optional()
                .describe('A URL OR pasted JD text. Required on step 1.'),
    job_id:   z.string().optional()
                .describe('Reuse an existing job row instead of adopting a new one. Set this on step 2.'),
    mode:     z.enum(['chat', 'api']).default('chat'),
    title:    z.string().optional().describe('Optional title override.'),
    company:  z.string().optional().describe('Optional company override.'),
    location: z.string().optional(),
    report:   z.object(reportBlocks).optional()
                .describe('Filled by chat on step 2 — the 6-block A–F (+G) markdown blocks.'),
    scores:   z.object(scores).strict().optional()
                .describe('Filled by chat on step 2 — strict JSON scores per modes/rubric.md.'),
  },
  handler: async (args, ctx) => {
    const mode = args.mode ?? 'chat';
    const isFinalize = !!(args.report || args.scores);

    // ── Step 2 (chat OR api) — finalize ────────────────────────────────────
    if (isFinalize) {
      if (!args.job_id) return errResult('Finalize call requires job_id from the step-1 response.');
      const job = getJob(args.job_id);
      if (!job) return errResult(`No job with id ${args.job_id}`);
      const saved = await saveReport({
        job_id: job.id,
        mode,
        raw_input: job.description ?? '',
        blocks: normalizeBlocks(args.report),
        scores: args.scores ?? {},
      });
      return okResult({
        step: 'finalized',
        job_id: job.id,
        report_id: saved.id,
        report_url: saved.url,
        tracker_url: trackerUrl(),
      });
    }

    // ── Step 1 ──────────────────────────────────────────────────────────────
    if (!args.input) return errResult('First call requires `input` (URL or pasted JD).');

    const jd = await normalizeJD(args.input);
    const adopted = await adoptJobFromJD({
      jd, title: args.title, company: args.company, location: args.location,
    });

    if (mode === 'chat') {
      return okResult({
        step: 'prepared',
        job_id: adopted.id,
        job_created: adopted.created,
        normalized_jd: {
          source:        jd.source,
          source_url:    jd.source_url,
          title_guess:   jd.title_guess,
          company_guess: jd.company_guess,
          char_count:    jd.text.length,
          text:          jd.text,
        },
        instructions:
          'Read the three resources below, score the JD per modes/rubric.md (STRICT JSON), ' +
          'draft the 6-block A–F (+G) report per modes/report_format.md, then CALL evaluate_job ' +
          'AGAIN with { job_id, report, scores } to persist and get the report link.',
        rubric:        getMode('rubric.md'),
        report_format: getMode('report_format.md'),
        career_packet: getActiveCareerPacket()?.content ?? '_no active career packet_',
      });
    }

    // ── Step 1 (api mode) — run scoring + report inline ─────────────────────
    // "api" here means server-side completion: MCP sampling (client model, no key) when
    // available, else the BYO-key provider. Same rubric + strict-JSON contract either way.
    const picked = pickCompleter(ctx?.bridge);
    if (!picked) {
      return errResult(
        'mode="api" needs a scoring backend: connect an MCP client that supports sampling ' +
        '(no key needed), or set JOBOPS_LLM_PROVIDER=gemini with GEMINI_API_KEY. ' +
        'Otherwise use mode="chat" (the default) — your chat client scores it.',
      );
    }
    try {
      const packet = getActiveCareerPacket()?.content ?? '';
      const userMsg = `== JOB (title=${jd.title_guess ?? ''}, company=${jd.company_guess ?? ''}) ==\n${jd.text}`;

      const scoringSystem = getMode('rubric.md') +
        '\n\n== INSTRUCTIONS ==\n' +
        'Score the JD below per the rubric. Output ONLY the strict JSON object specified in ' +
        '"Output contract (chat mode)". No prose outside JSON.';
      const blocksSystem = getMode('report_format.md') +
        '\n\n== CAREER PACKET ==\n' + packet +
        '\n\n== INSTRUCTIONS ==\n' +
        'Draft the 6-block A–F (+G optional) report. Output STRICT JSON only with keys: ' +
        'archetype_detected, block_role_summary, block_cv_match, block_level, block_comp, ' +
        'block_personalize, block_interview, block_legitimacy, keywords (array of strings).';

      // Scoring + blocks are independent given the same JD — run in parallel.
      const [scoreCall, blocksCall] = await Promise.all([
        picked.completer('evaluate_job.api.scores', [
          { role: 'system', content: scoringSystem }, { role: 'user', content: userMsg },
        ], { temperature: 0.2, jobId: adopted.id }),
        picked.completer('evaluate_job.api.blocks', [
          { role: 'system', content: blocksSystem }, { role: 'user', content: userMsg },
        ], { temperature: 0.3, maxTokens: 6000, jobId: adopted.id }),
      ]);
      const scoreData = (scoreCall.parsed ?? null) as any;

      // Save — even on parse failure, persist what we have. NEVER silent zeros.
      const saved = await saveReport({
        job_id: adopted.id, mode: 'api',
        raw_input: jd.text,
        blocks: normalizeBlocks(blocksCall.parsed),
        // Only attach scores if parsing succeeded — else leave NULL.
        scores: scoreCall.parseOk && scoreData ? scoreData : undefined,
      });

      return okResult({
        step: 'finalized',
        mode: 'api',
        scored_via: picked.kind,   // 'sampling' (client model, no key) or 'api' (BYO key)
        job_id: adopted.id,
        report_id: saved.id,
        report_url: saved.url,
        scoring_parse_ok: scoreCall.parseOk,
        blocks_parse_ok:  blocksCall.parseOk,
        scoring_parse_error: scoreCall.parseError ?? null,
        blocks_parse_error:  blocksCall.parseError ?? null,
        tracker_url: trackerUrl(),
      });
    } catch (e: any) {
      return errResult(`api-mode evaluate_job failed: ${e?.message ?? String(e)}`);
    }
  },
});

// Single shape converter — used by both the chat-finalize and api paths so the keys-list
// stays one source of truth and only ReportBlocks knows what the report shape is.
function normalizeBlocks(raw: any): ReportBlocks {
  const r = raw ?? {};
  return {
    archetype_detected: r.archetype_detected ?? null,
    block_role_summary: r.block_role_summary ?? null,
    block_cv_match:     r.block_cv_match     ?? null,
    block_level:        r.block_level        ?? null,
    block_comp:         r.block_comp         ?? null,
    block_personalize:  r.block_personalize  ?? null,
    block_interview:    r.block_interview    ?? null,
    block_legitimacy:   r.block_legitimacy   ?? null,
    keywords:           Array.isArray(r.keywords) ? r.keywords : null,
  };
}
