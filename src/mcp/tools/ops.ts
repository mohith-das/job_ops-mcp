// G7 — profile + ops tools.
//   evaluate_training, evaluate_project, deep_research, daily_digest,
//   get_career_packet, update_career_packet, enrich_company, cost_estimate

import { z } from 'zod';
import { randomUUID } from 'node:crypto';

import { getDb, runInWriteLock } from '../../db.js';
import { defineTool, okResult, errResult } from '../define.js';
import { chatLogged, llmAvailable, COST_TABLE, estimateCostUsd } from '../../core/llm.js';
import { getActiveCareerPacket, writeChatEditedPacket, editPacketSection } from '../../core/profile.js';
import { getMode } from '../../core/modes.js';
import { findCompanyByName } from '../../core/jobs.js';
import { fileUrl, trackerUrl } from '../../core/links.js';

// ── evaluate_training ────────────────────────────────────────────────────────

export const evaluateTrainingTool = defineTool({
  name: 'evaluate_training',
  title: 'Score a course / cert against the profile',
  description:
    'Scores a training input (URL, syllabus, or pasted text) against the candidate profile. ' +
    'chat-mode default returns the rubric + packet for the chat to score. api-mode runs the LLM.',
    mutates: true,
inputSchema: {
    input: z.string().min(1).describe('URL, syllabus text, or paste of training description.'),
    mode:  z.enum(['chat','api']).default('chat'),
  },
  handler: async (args) => {
    const packet = getActiveCareerPacket()?.content ?? '';
    const rubric = getMode('rubric.md');
    if (args.mode === 'chat') {
      return okResult({
        instructions:
          'Score this training on (a) skill_gap_fill 0-100 against the rubric profile, (b) market_signal 0-100 ' +
          '(how much hiring managers value the cert in the target roles), (c) time_to_value (weeks). ' +
          'Output STRICT JSON: { skill_gap_fill, market_signal, time_to_value_weeks, recommendation: "do_now"|"backlog"|"skip", reasoning }.',
        training_input: args.input,
        rubric, career_packet: packet,
      });
    }
    if (!llmAvailable()) return errResult('No LLM configured for api mode.');
    const system = rubric + '\n\n== CAREER PACKET ==\n' + packet +
      '\n\nReturn STRICT JSON: { skill_gap_fill, market_signal, time_to_value_weeks, recommendation, reasoning }.';
    const call = await chatLogged('evaluate_training.api', [
      { role: 'system', content: system }, { role: 'user', content: args.input },
    ], { responseFormat: 'json_object', temperature: 0.3 });
    if (!call.parseOk) return errResult(`parse error: ${call.parseError}`);
    return okResult(call.parsed as object);
  },
});

// ── evaluate_project ─────────────────────────────────────────────────────────

export const evaluateProjectTool = defineTool({
  name: 'evaluate_project',
  title: 'Score a portfolio-project idea',
  description:
    'Scores a portfolio-project idea against target roles for resume signal + interview leverage. ' +
    'chat-mode default returns the context; api-mode runs the LLM.',
  inputSchema: {
    input: z.string().min(1),
    mode:  z.enum(['chat','api']).default('chat'),
  },
  handler: async (args) => {
    const packet = getActiveCareerPacket()?.content ?? '';
    const rubric = getMode('rubric.md');
    if (args.mode === 'chat') {
      return okResult({
        instructions:
          'Score this project idea on (a) resume_signal 0-100, (b) interview_story_value 0-100, ' +
          '(c) effort_weeks, (d) shipping_risk 0-100. Recommend ship_now / refine / skip. ' +
          'Output STRICT JSON.',
        project_input: args.input,
        rubric, career_packet: packet,
      });
    }
    if (!llmAvailable()) return errResult('No LLM configured for api mode.');
    const system = rubric + '\n\n== CAREER PACKET ==\n' + packet +
      '\n\nReturn STRICT JSON: { resume_signal, interview_story_value, effort_weeks, shipping_risk, recommendation, reasoning }.';
    const call = await chatLogged('evaluate_project.api', [
      { role: 'system', content: system }, { role: 'user', content: args.input },
    ], { responseFormat: 'json_object', temperature: 0.3 });
    if (!call.parseOk) return errResult(`parse error: ${call.parseError}`);
    return okResult(call.parsed as object);
  },
  mutates: true,
 
});

// ── deep_research ────────────────────────────────────────────────────────────
//
// Combined company brief: cached enrichment rows (comp / culture / recent_news) + a
// structured suggestion of what to research next. chat-mode default returns context;
// api-mode summarises whatever's in `notes` or pulls from a chat-provided web snapshot.

export const deepResearchTool = defineTool({
  name: 'deep_research',
  title: 'Company brief',
  description:
    'Aggregates current enrichment rows (comp / culture / recent_news) + jobs + warm intros for the company. ' +
    'Chat client uses the returned structure to drive web research. With `notes` AND `kind` provided, the ' +
    'api-mode summarises into enrichment for that single kind (refuses without kind — use enrich_company ' +
    'directly to write multiple kinds at once).',
  inputSchema: {
    company: z.string().min(1),
    kind:    z.enum(['comp','culture','recent_news']).optional()
              .describe('Required when persisting (mode=api + notes). Single kind per call to avoid writing the same summary to multiple rows.'),
    notes:   z.string().optional().describe('When provided + mode=api + kind, summarise into enrichment.'),
    mode:    z.enum(['chat','api']).default('chat'),
  },
  handler: async (args) => {
    const db = getDb();
    const found = findCompanyByName(args.company);
    if (!found) return errResult(`No company matching "${args.company}". Run scan_portals or seed companies first.`);
    const c = db.prepare(`SELECT * FROM companies WHERE id = ?`).get(found.id) as any;

    const enrichments = db.prepare(`
      SELECT kind, summary, confidence_score, signal_quality, expires_at, source_urls
      FROM enrichment WHERE company_id = ?
    `).all(c.id) as any[];
    const topJobs = db.prepare(`
      SELECT j.id, j.title, j.score_total, j.role_category, j.status, j.source_url
      FROM jobs j WHERE j.company_id = ? ORDER BY j.score_total DESC NULLS LAST LIMIT 10
    `).all(c.id) as any[];
    const warmIntros = db.prepare(`
      SELECT id, full_name, position, preferred_channel
      FROM linkedin_connections WHERE company_id = ? AND is_recruiter = 0 LIMIT 25
    `).all(c.id) as any[];
    const h1b = db.prepare(`SELECT * FROM v_company_h1b_signal WHERE company_id = ?`).get(c.id) as any;

    if (args.mode === 'api' && args.notes) {
      if (!args.kind) return errResult('deep_research api+notes requires `kind` (comp|culture|recent_news). Use enrich_company directly to write multiple kinds.');
      const system =
        'You summarise web research about a company for a job candidate. Be skeptical: specific dollar figures + dates beat vague claims. ' +
        'Output STRICT JSON: { summary: "<3 sentences", confidence_score: 0-100, signal_quality: "strong|mixed|weak|none", flags: "<comma-separated tags or none>" }.';
      const user = JSON.stringify({ company: c.name, kind: args.kind, notes: args.notes.slice(0, 12_000) });
      const call = await chatLogged('deep_research.api', [
        { role: 'system', content: system }, { role: 'user', content: user },
      ], { responseFormat: 'json_object', temperature: 0.3, maxTokens: 1500 });
      if (call.parseOk && call.parsed) {
        const p = call.parsed as any;
        await runInWriteLock(() => {
          getDb().prepare(`
            INSERT INTO enrichment (id, company_id, kind, summary, confidence_score, signal_quality, flags, source_urls, expires_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, '[]', datetime('now','+30 days'))
            ON CONFLICT (company_id, kind) DO UPDATE SET
              summary = excluded.summary,
              confidence_score = excluded.confidence_score,
              signal_quality = excluded.signal_quality,
              flags = excluded.flags,
              expires_at = excluded.expires_at
          `).run(randomUUID(), c.id, args.kind,
                  p.summary ?? null, p.confidence_score ?? null, p.signal_quality ?? null, p.flags ?? null);
        });
      }
    }

    return okResult({
      company: { id: c.id, name: c.name, hq_city: c.hq_city, hq_country: c.hq_country,
                  headcount_range: c.headcount_range, funding_stage: c.funding_stage },
      enrichments, top_jobs: topJobs, warm_intros: warmIntros, h1b_signal: h1b ?? null,
      instructions: args.mode === 'chat' ? (
        'Use the company name to research comp, culture, recent_news. ' +
        'Pull from Levels.fyi / Glassdoor / Blind / TechCrunch / news. ' +
        'When done, call deep_research(company, kind, notes, mode=api) with notes containing the research blob.'
      ) : 'Persisted enrichment for the requested kind(s) if api+notes were provided.',
    });
  },
  mutates: true,
 
});

// ── daily_digest ─────────────────────────────────────────────────────────────

export const dailyDigestTool = defineTool({
  name: 'daily_digest',
  title: 'Morning summary',
  description:
    'Returns new top jobs since last digest, follow-ups due, pipeline state changes, and a cost snapshot. ' +
    'Stamps digest_state.last_digest_at unless dry_run.',
  inputSchema: {
    dry_run:  z.boolean().default(false),
    min_score: z.number().int().min(0).max(100).default(75),
    lookback_hours: z.number().int().min(1).max(720).optional()
      .describe('Overrides "since last digest". Useful for the first run.'),
  },
  handler: async (args) => {
    const db = getDb();
    const lastRow = db.prepare(`SELECT last_digest_at FROM digest_state WHERE id = 1`).get() as { last_digest_at: string | null };
    const cutoff = args.lookback_hours
      ? new Date(Date.now() - args.lookback_hours * 3_600_000).toISOString()
      : (lastRow?.last_digest_at ?? new Date(Date.now() - 24 * 3_600_000).toISOString());

    const newTop = db.prepare(`
      SELECT j.id, j.title, COALESCE(c.name, j.company_name_raw) AS company, j.score_total, j.source_url,
             (SELECT er.html_path FROM eval_reports er WHERE er.job_id = j.id ORDER BY er.created_at DESC LIMIT 1) AS report_html
      FROM jobs j LEFT JOIN companies c ON c.id = j.company_id
      WHERE j.trashed_at IS NULL AND j.score_total >= ? AND datetime(j.discovered_at) >= datetime(?)
      ORDER BY j.score_total DESC LIMIT 25
    `).all(args.min_score, cutoff) as any[];

    const followups = db.prepare(`SELECT * FROM v_followups_due ORDER BY datetime(followup_due_at) ASC LIMIT 25`).all() as any[];

    const recentStatusChanges = db.prepare(`
      SELECT j.id, j.title, COALESCE(c.name, j.company_name_raw) AS company, j.status, j.updated_at
      FROM jobs j LEFT JOIN companies c ON c.id = j.company_id
      WHERE j.trashed_at IS NULL AND datetime(j.updated_at) >= datetime(?) AND j.status IN ('applied','screen','onsite','offer','rejected','materials_drafted','ready_to_review')
      ORDER BY datetime(j.updated_at) DESC LIMIT 25
    `).all(cutoff) as any[];

    const costRow = db.prepare(`
      SELECT COUNT(*) AS calls, COALESCE(SUM(input_chars),0) AS in_chars, COALESCE(SUM(output_chars),0) AS out_chars
      FROM llm_calls WHERE datetime(created_at) >= datetime(?)
    `).get(cutoff) as { calls: number; in_chars: number; out_chars: number };

    if (!args.dry_run) {
      await runInWriteLock(() => {
        getDb().prepare(`UPDATE digest_state SET last_digest_at = CURRENT_TIMESTAMP WHERE id = 1`).run();
      });
    }
    return okResult({
      since: cutoff,
      new_top_jobs:   newTop.map(j => ({
        ...j,
        report_html: undefined,
        report_url:  j.report_html ? fileUrl(j.report_html) : null,
      })),
      followups_due:  followups,
      status_changes: recentStatusChanges,
      llm_cost_window: {
        calls: costRow.calls, input_chars: costRow.in_chars, output_chars: costRow.out_chars,
      },
      tracker_url: trackerUrl(),
    });
  },
  mutates: true,
 
});

// ── get_career_packet ────────────────────────────────────────────────────────

export const getCareerPacketTool = defineTool({
  name: 'get_career_packet',
  title: 'Get the active career packet',
  description: 'Returns the active career_packet row (markdown + version + cv-hash).',
  inputSchema: {},
  handler: async () => {
    const row = getActiveCareerPacket();
    if (!row) return errResult('No active career packet (server should seed on first run).');
    return okResult(row);
  },
  mutates: false,
  publicSafe: true,
 
});

// ── update_career_packet ─────────────────────────────────────────────────────

export const updateCareerPacketTool = defineTool({
  name: 'update_career_packet',
  title: 'Update the active career packet (chat is the edit surface)',
  description:
    'Edit the active career packet from chat and persist a NEW version (history retained). This is ' +
    'the primary edit surface in chat-driven mode — the edit is marked user-edited so a later ' +
    'reseed will NOT silently overwrite it (reseed then warns and requires force). ' +
    'TWO modes: (a) full replace — pass `content`; (b) ergonomic SECTION edit — pass `section` ' +
    '(e.g. "2" for taglines, "6" for projects) + `section_content` (just that section\'s new body), ' +
    'so "change my tagline" or "remove project X" need not re-send the whole packet. ' +
    'To bring cv.md up to date FROM these edits, use sync_packet_to_cv.',
  mutates: true,
  inputSchema: {
    content:         z.string().min(50).optional().describe('Full markdown content of the new packet (full-replace mode).'),
    section:         z.string().optional().describe('Section number to edit, e.g. "2" (taglines) or "6" (projects). Use with section_content.'),
    section_content: z.string().min(1).optional().describe('The new body for `section` (heading is kept). Replaces only that section.'),
    notes:           z.string().optional(),
  },
  handler: async (args) => {
    const hasFull    = typeof args.content === 'string';
    const hasSection = typeof args.section === 'string' && typeof args.section_content === 'string';
    if (hasFull && hasSection) {
      return errResult('Pass EITHER `content` (full replace) OR `section`+`section_content` (section edit), not both.');
    }
    if (!hasFull && !hasSection) {
      return errResult('Provide `content` (full replace) OR `section`+`section_content` (section edit). For a section edit, get_career_packet first to see section numbers.');
    }

    let newContent: string;
    let notes = args.notes ?? null;
    if (hasSection) {
      const active = getActiveCareerPacket();
      if (!active) return errResult('No active career_packet to edit. Run init/reseed first.');
      try {
        newContent = editPacketSection(active.content, args.section!, args.section_content!);
      } catch (e: any) {
        return errResult(e?.message ?? String(e));
      }
      if (newContent === active.content) {
        return errResult(`Section ${args.section} body unchanged (or not matched) — nothing written.`);
      }
      notes = notes ?? `chat edit: section ${args.section!.replace(/[^0-9]/g, '')}`;
    } else {
      newContent = args.content!;
    }

    const result = await writeChatEditedPacket(newContent, notes);
    return okResult({
      id: result.id,
      version: result.version,
      content_bytes: result.bytes,
      origin: 'chat_edit',
      edited: hasSection ? `section ${args.section!.replace(/[^0-9]/g, '')}` : 'full',
      note: 'Marked user-edited. reseed_career_packet will NOT overwrite this without force. '
          + 'Use sync_packet_to_cv to update cv.md from this packet.',
    });
  },
});

// ── enrich_company ───────────────────────────────────────────────────────────
//
// Lightweight wrapper around deep_research(api) for a single (company, kind). Useful in
// chat for queueing a quick TTL refresh.

export const enrichCompanyTool = defineTool({
  name: 'enrich_company',
  title: 'Refresh enrichment row for a company',
  description: 'Stores a chat- or api-provided enrichment summary for (company, kind) with a 30-day TTL.',
  mutates: true,
  inputSchema: {
    company: z.string().min(1),
    kind:    z.enum(['comp','culture','recent_news']),
    summary: z.string().min(10),
    confidence_score: z.number().int().min(0).max(100).default(60),
    signal_quality:   z.enum(['strong','mixed','weak','none']).default('mixed'),
    source_urls:      z.array(z.string()).default([]),
    flags:            z.string().optional(),
  },
  handler: async (args) => {
    const c = findCompanyByName(args.company);
    if (!c) return errResult(`No company "${args.company}"`);
    const id = await runInWriteLock(() => {
      const id = randomUUID();
      getDb().prepare(`
        INSERT INTO enrichment (id, company_id, kind, summary, confidence_score, signal_quality, source_urls, flags, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now', '+30 days'))
        ON CONFLICT (company_id, kind) DO UPDATE SET
          summary = excluded.summary,
          confidence_score = excluded.confidence_score,
          signal_quality = excluded.signal_quality,
          source_urls = excluded.source_urls,
          flags = excluded.flags,
          expires_at = excluded.expires_at
      `).run(id, c.id, args.kind, args.summary, args.confidence_score, args.signal_quality,
              JSON.stringify(args.source_urls), args.flags ?? null);
      return id;
    });
    return okResult({ company: c.name, kind: args.kind, enrichment_id: id, ttl_days: 30 });
  },
});

// ── cost_estimate ────────────────────────────────────────────────────────────

export const costEstimateTool = defineTool({
  name: 'cost_estimate',
  title: 'LLM cost estimate',
  description: 'Aggregates llm_calls by provider+model+tool over a window and estimates USD cost. Defaults: last 30 days.',
  mutates: false,
  inputSchema: {
    days: z.number().int().min(1).max(365).default(30),
  },
  handler: async (args) => {
    // Compare ISO-8601 strings directly so the idx_llm_calls_created_at btree is usable.
    const cutoff = new Date(Date.now() - args.days * 86_400_000).toISOString();
    const rows = getDb().prepare(`
      SELECT provider, model, tool, COUNT(*) AS calls,
             SUM(input_chars) AS in_chars,
             SUM(output_chars) AS out_chars,
             SUM(CASE WHEN parse_ok = 0 THEN 1 ELSE 0 END) AS parse_errors,
             SUM(duration_ms) AS ms
      FROM llm_calls
      WHERE created_at >= ?
      GROUP BY provider, model, tool
      ORDER BY ms DESC
    `).all(cutoff) as any[];
    let totalUsd = 0;
    let samplingCalls = 0;
    const items = rows.map(r => {
      // Sampling runs on the connected client's model — the cost is borne by the client,
      // not by any server-side key. We still record the calls (for volume visibility) but
      // estimate $0 and flag them so the total isn't misread.
      const isSampling = r.provider === 'sampling';
      if (isSampling) samplingCalls += Number(r.calls ?? 0);
      const usd = isSampling ? 0 : estimateCostUsd(r.model, Number(r.in_chars ?? 0), Number(r.out_chars ?? 0));
      totalUsd += usd;
      return {
        ...r,
        usd_estimate: round4(usd),
        rate: isSampling ? null : (COST_TABLE[r.model] ?? null),
        cost_borne_by: isSampling ? 'client (MCP sampling — no server-side key cost)' : 'server (BYO key)',
      };
    });
    return okResult({
      window_days: args.days,
      total_usd_estimate: round4(totalUsd),
      note: samplingCalls
        ? `${samplingCalls} call(s) ran via MCP sampling — billed to the connected client's model, not estimated here ($0 server cost).`
        : undefined,
      by_provider_model_tool: items,
    });
  },
});

function round4(n: number): number { return Math.round(n * 10_000) / 10_000; }
