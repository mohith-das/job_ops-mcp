// G3 — outreach suite (8 tools).
//
// All draft_* tools default to mode='chat': they return the active career packet, the
// outreach_tone.md rules, and the connection/job context, so the chat client drafts the
// message. With mode='api' we call the configured LLM with the same context inline and
// validate the result against the safety rails (char cap + never-refer-me + no-visa +
// no-emojis + no-exclamations). Validation failures are surfaced — never silently saved.

import { z } from 'zod';
import { randomUUID } from 'node:crypto';

import { getDb, runInWriteLock } from '../../db.js';
import { defineTool, okResult, errResult } from '../define.js';
import { getActiveCareerPacket } from '../../core/profile.js';
import { chatLogged } from '../../core/llm.js';
import { getMode } from '../../core/modes.js';
import { getOutreachLimits, validateOutreach } from '../../core/outreach_safety.js';

const OUTREACH_TYPES = ['warm_intro_request','founder_dm','recruiter_followup','generic','followup'] as const;
const OUTREACH_STATUSES = ['queued','drafted','edited','sent','replied','dead','success'] as const;

const readOutreachTone = () => getMode('outreach_tone.md');

// Maps an outreach_type to the validation profile in outreach_safety.ts.
// `warm_intro_request` and `recruiter_followup` both fall under "warm" rails per modes/outreach_tone.md.
const TYPE_TO_LIMITS: Record<string, 'warm' | 'founder' | 'followup' | 'reply' | 'generic'> = {
  warm_intro_request: 'warm',
  founder_dm:         'founder',
  followup:           'followup',
  recruiter_followup: 'warm',
};
function typeForLimits(t: string): 'warm' | 'founder' | 'followup' | 'reply' | 'generic' {
  return TYPE_TO_LIMITS[t] ?? 'generic';
}

// ── find_warm_intros ─────────────────────────────────────────────────────────

export const findWarmIntrosTool = defineTool({
  name: 'find_warm_intros',
  title: 'Find warm intros at a company',
  description: 'Joins jobs × non-recruiter LinkedIn connections at the same company. Filterable by company name substring. Sorted by score then contact priority.',
  inputSchema: {
    company:   z.string().optional(),
    min_score: z.number().int().min(0).max(100).default(80),
    limit:     z.number().int().min(1).max(200).default(50),
  },
  handler: async (args) => {
    const where = ['v.score_total IS NOT NULL', 'v.score_total >= ?'];
    const params: any[] = [args.min_score];
    if (args.company) { where.push('LOWER(v.company_name) LIKE ?'); params.push(`%${args.company.toLowerCase()}%`); }
    const rows = getDb().prepare(`
      SELECT v.*, lc.linkedin_url, lc.preferred_channel
      FROM v_jobs_with_warm_intros v
      JOIN linkedin_connections lc ON lc.id = v.connection_id
      WHERE ${where.join(' AND ')}
      LIMIT ?
    `).all(...params, args.limit) as any[];
    return okResult({ count: rows.length, items: rows });
  },
mutates: false,
  });

// ── find_founders ────────────────────────────────────────────────────────────

export const findFoundersTool = defineTool({
  name: 'find_founders',
  title: 'Find founders/CEO/CTO/c-suite in your network',
  description: 'Returns non-stealth founders / c-suite from linkedin_connections, derived in v_founder_network.',
  inputSchema: {
    kind:  z.enum(['founder','ceo','cto','c_suite','any']).default('any'),
    limit: z.number().int().min(1).max(500).default(100),
  },
  handler: async (args) => {
    const where = ['is_stealth = 0'];
    const params: any[] = [];
    if (args.kind !== 'any') { where.push('founder_kind = ?'); params.push(args.kind); }
    const rows = getDb().prepare(`
      SELECT v.*, lc.linkedin_url, lc.preferred_channel
      FROM v_founder_network v
      JOIN linkedin_connections lc ON lc.id = v.connection_id
      WHERE ${where.join(' AND ')}
      ORDER BY
        CASE founder_kind WHEN 'founder' THEN 1 WHEN 'ceo' THEN 2 WHEN 'cto' THEN 3 ELSE 4 END,
        lc.full_name
      LIMIT ?
    `).all(...params, args.limit) as any[];
    return okResult({ count: rows.length, items: rows });
  },
mutates: false,
  });

// ── draft_outreach ───────────────────────────────────────────────────────────

export const draftOutreachTool = defineTool({
  name: 'draft_outreach',
  title: 'Draft a warm-intro or founder DM',
  description:
    'mode=chat: returns connection + (optional) job context + career packet + outreach_tone.md so the chat client drafts the DM. ' +
    'mode=api: calls the configured LLM, validates char cap / no visa / no refer-me / no emojis, persists draft. ' +
    'Always inserts a queued or drafted outreach row tied to the connection.',
  inputSchema: {
    connection_id: z.string().min(1),
    job_id:        z.string().optional(),
    type:          z.enum(OUTREACH_TYPES).default('warm_intro_request'),
    mode:          z.enum(['chat','api']).default('chat'),
    message:       z.string().optional().describe('Provide on a second chat-mode call to persist a drafted message.'),
  },
  handler: async (args) => {
    const db = getDb();
    const conn = db.prepare(`SELECT * FROM linkedin_connections WHERE id = ?`).get(args.connection_id) as any;
    if (!conn) return errResult(`No connection ${args.connection_id}`);
    const job = args.job_id
      ? db.prepare(`SELECT id, title, company_id, company_name_raw, source_url FROM jobs WHERE id = ?`).get(args.job_id) as any
      : null;
    const limits = getOutreachLimits(typeForLimits(args.type));

    // Persisting a chat-drafted message on the round-trip.
    if (args.mode === 'chat' && args.message) {
      const validation = validateOutreach(args.message, typeForLimits(args.type));
      if (!validation.ok) {
        return errResult(`outreach validation failed: ${JSON.stringify(validation)}`);
      }
      const id = await persistDraft({
        connection_id: conn.id,
        company_id:    conn.company_id ?? job?.company_id ?? null,
        related_job_id: job?.id ?? null,
        outreach_type: args.type,
        channel:       conn.preferred_channel ?? 'linkedin',
        draft_message: args.message,
      });
      return okResult({
        outreach_id: id, status: 'drafted',
        validation, char_cap: limits.maxChars, length: args.message.length,
      });
    }

    if (args.mode === 'chat') {
      // Step 1: hand the chat all the context it needs to draft.
      return okResult({
        instructions:
          'Draft the message per modes/outreach_tone.md (under the char cap; no emojis; no exclamation marks; ' +
          'never "refer me"; NEVER mention visa / OPT / sponsorship). Then call draft_outreach AGAIN with the ' +
          '`message` argument to persist.',
        char_cap: limits.maxChars,
        type:     args.type,
        connection: {
          id: conn.id, full_name: conn.full_name, position: conn.position,
          company_raw: conn.company_raw, is_recruiter: !!conn.is_recruiter,
          is_engineering: !!conn.is_engineering, is_leadership: !!conn.is_leadership,
          linkedin_url: conn.linkedin_url, preferred_channel: conn.preferred_channel,
        },
        job: job ? {
          id: job.id, title: job.title, company: job.company_name_raw, source_url: job.source_url,
        } : null,
        career_packet: getActiveCareerPacket()?.content ?? '',
        outreach_tone: readOutreachTone(),
      });
    }

    // mode=api — call LLM, validate, persist.
    try {
      const systemTone = readOutreachTone();
      const packet = getActiveCareerPacket()?.content ?? '';
      const system = systemTone + '\n\n== CAREER PACKET ==\n' + packet +
        '\n\n== OUTPUT CONTRACT ==\nReturn STRICT JSON: { "message": "...", "opening_hook": "...", "primary_ask": "...", "strategy_note": "...", "subject_line": "..." }.';
      const user = JSON.stringify({
        type: args.type, char_cap: limits.maxChars,
        connection: {
          full_name: conn.full_name, position: conn.position, company_raw: conn.company_raw,
          is_recruiter: !!conn.is_recruiter, is_engineering: !!conn.is_engineering, is_leadership: !!conn.is_leadership,
        },
        job: job ? { title: job.title, company: job.company_name_raw } : null,
      });
      const call = await chatLogged('draft_outreach.api', [
        { role: 'system', content: system },
        { role: 'user',   content: user },
      ], { responseFormat: 'json_object', temperature: 0.6, maxTokens: 1200 });
      if (!call.parseOk || typeof (call.parsed as any)?.message !== 'string') {
        return errResult(`LLM produced unparseable output: ${call.parseError ?? 'no message field'}`);
      }
      const parsed = call.parsed as any;
      const validation = validateOutreach(parsed.message, typeForLimits(args.type));
      if (!validation.ok) {
        return errResult(`LLM draft failed safety rails — not persisted. ${JSON.stringify(validation)}`);
      }
      const id = await persistDraft({
        connection_id: conn.id,
        company_id:    conn.company_id ?? job?.company_id ?? null,
        related_job_id: job?.id ?? null,
        outreach_type: args.type,
        channel:       conn.preferred_channel ?? 'linkedin',
        draft_message: parsed.message,
        subject_line:  parsed.subject_line ?? null,
        notes:         [parsed.opening_hook && `hook: ${parsed.opening_hook}`,
                        parsed.primary_ask  && `ask: ${parsed.primary_ask}`,
                        parsed.strategy_note && `strategy: ${parsed.strategy_note}`]
                          .filter(Boolean).join(' | ') || null,
      });
      return okResult({ outreach_id: id, status: 'drafted', validation, parsed });
    } catch (e: any) {
      return errResult(`api draft_outreach failed: ${e?.message ?? String(e)}`);
    }
  },
  mutates: true,
 
});

// ── get_outreach_queue ───────────────────────────────────────────────────────

export const getOutreachQueueTool = defineTool({
  name: 'get_outreach_queue',
  title: 'Outreach queue',
  description: 'Returns outreach rows filtered by status (defaults: queued + drafted + edited). Newest first.',
  inputSchema: {
    status: z.array(z.enum(OUTREACH_STATUSES)).optional(),
    limit:  z.number().int().min(1).max(500).default(100),
  },
  handler: async (args) => {
    const statuses = args.status?.length ? args.status : ['queued','drafted','edited'];
    const placeholders = statuses.map(() => '?').join(',');
    const rows = getDb().prepare(`
      SELECT o.*, lc.full_name AS connection_name, lc.linkedin_url,
             c.name AS company_name,
             j.title AS job_title, j.source_url
      FROM outreach o
      LEFT JOIN linkedin_connections lc ON lc.id = o.connection_id
      LEFT JOIN companies c ON c.id = o.company_id
      LEFT JOIN jobs j ON j.id = o.related_job_id
      WHERE o.status IN (${placeholders})
      ORDER BY datetime(o.updated_at) DESC
      LIMIT ?
    `).all(...statuses, args.limit) as any[];
    return okResult({ count: rows.length, items: rows });
  },
mutates: false,
  });

// ── update_outreach ──────────────────────────────────────────────────────────

export const updateOutreachTool = defineTool({
  name: 'update_outreach',
  title: 'Update outreach status',
  description: 'Move an outreach row to a new status. Stamps sent_at on "sent" and replied_at on "replied". Optional reply text + followup_due_at.',
  inputSchema: {
    id:              z.string().min(1),
    status:          z.enum(OUTREACH_STATUSES),
    reply:           z.string().optional(),
    followup_in_days: z.number().int().min(1).max(365).optional()
                        .describe('Sets followup_due_at to now + N days. Defaults to 5 when status=sent and no override.'),
    edited_message:  z.string().optional()
                        .describe('If set, replaces the edited_message and re-validates safety rails.'),
  },
  handler: async (args) => {
    const result = await runInWriteLock(() => {
      const db = getDb();
      const row = db.prepare(`SELECT * FROM outreach WHERE id = ?`).get(args.id) as any;
      if (!row) return { ok: false as const, message: `no outreach ${args.id}` };
      // Validate edited_message if provided.
      if (args.edited_message) {
        const validation = validateOutreach(args.edited_message, typeForLimits(row.outreach_type));
        if (!validation.ok) return { ok: false as const, message: `edited_message failed: ${JSON.stringify(validation)}` };
      }
      const sets: string[] = ['status = ?', 'updated_at = CURRENT_TIMESTAMP'];
      const params: any[] = [args.status];
      if (args.status === 'sent') {
        sets.push('sent_at = CURRENT_TIMESTAMP');
        const days = args.followup_in_days ?? 5;
        sets.push(`followup_due_at = datetime('now', '+${days} days')`);
      }
      if (args.status === 'replied') {
        sets.push('replied_at = CURRENT_TIMESTAMP');
        if (args.reply) { sets.push('reply_text = ?'); params.push(args.reply); }
      }
      if (args.edited_message) { sets.push('edited_message = ?'); params.push(args.edited_message); }
      db.prepare(`UPDATE outreach SET ${sets.join(', ')} WHERE id = ?`).run(...params, args.id);
      return { ok: true as const, from: row.status, to: args.status };
    });
    if (!result.ok) return errResult(result.message);
    return okResult({ id: args.id, from: result.from, to: result.to });
  },
  mutates: true,
 
});

// ── get_followups_due ────────────────────────────────────────────────────────

export const getFollowupsDueTool = defineTool({
  name: 'get_followups_due',
  title: 'Follow-ups due',
  description: 'Returns outreach rows in status=sent with followup_due_at <= now. View v_followups_due.',
  inputSchema: { limit: z.number().int().min(1).max(500).default(100) },
  handler: async (args) => {
    const rows = getDb().prepare(`
      SELECT v.*, lc.linkedin_url, lc.preferred_channel
      FROM v_followups_due v
      LEFT JOIN linkedin_connections lc ON lc.id = v.connection_id
      ORDER BY datetime(v.followup_due_at) ASC
      LIMIT ?
    `).all(args.limit) as any[];
    return okResult({ count: rows.length, items: rows });
  },
mutates: false,
  });

// ── draft_followup ───────────────────────────────────────────────────────────

export const draftFollowupTool = defineTool({
  name: 'draft_followup',
  title: 'Draft a 1-2 line follow-up nudge',
  description:
    'For outreach in status=sent that has not been replied to. mode=chat returns context + tone rules. ' +
    'mode=api calls the LLM and validates safety rails before persisting.',
  inputSchema: {
    outreach_id: z.string().min(1),
    mode:        z.enum(['chat','api']).default('chat'),
    message:     z.string().optional().describe('Provide on a second chat-mode call to persist.'),
  },
  handler: async (args) => {
    const db = getDb();
    const original = db.prepare(`SELECT * FROM outreach WHERE id = ?`).get(args.outreach_id) as any;
    if (!original) return errResult(`No outreach ${args.outreach_id}`);
    const conn = db.prepare(`SELECT * FROM linkedin_connections WHERE id = ?`).get(original.connection_id) as any;
    const limits = getOutreachLimits('followup');

    if (args.mode === 'chat' && args.message) {
      const validation = validateOutreach(args.message, 'followup');
      if (!validation.ok) return errResult(`followup validation failed: ${JSON.stringify(validation)}`);
      const id = await persistDraft({
        connection_id: original.connection_id,
        company_id:    original.company_id,
        related_job_id: original.related_job_id,
        outreach_type: 'followup',
        channel:       original.channel ?? 'linkedin',
        draft_message: args.message,
        notes:         `followup to outreach ${original.id}`,
      });
      return okResult({ outreach_id: id, status: 'drafted', validation });
    }

    if (args.mode === 'chat') {
      return okResult({
        instructions: 'Draft a 1-2 line nudge. Tone: still curious about X, drop me a line if it ever makes sense. Soft close again. NO new ask. NO visa mention. Then call draft_followup with `message` to persist.',
        char_cap: limits.maxChars,
        original: {
          id: original.id, sent_at: original.sent_at, draft_message: original.edited_message ?? original.draft_message,
        },
        connection: conn ? { full_name: conn.full_name, position: conn.position } : null,
        outreach_tone: readOutreachTone(),
      });
    }

    // api mode
    try {
      const system = readOutreachTone() +
        '\n\n== TASK ==\nDraft a 1-2 line follow-up nudge. NO new ask. NO visa mention. Output STRICT JSON: { "message": "..." }.';
      const user = JSON.stringify({
        original_message: original.edited_message ?? original.draft_message,
        connection: conn ? { full_name: conn.full_name, position: conn.position } : null,
        days_since_sent: original.sent_at ? daysAgo(original.sent_at) : null,
      });
      const call = await chatLogged('draft_followup.api', [
        { role: 'system', content: system }, { role: 'user', content: user },
      ], { responseFormat: 'json_object', temperature: 0.5, maxTokens: 600 });
      if (!call.parseOk || typeof (call.parsed as any)?.message !== 'string') {
        return errResult(`LLM produced unparseable output: ${call.parseError ?? 'no message'}`);
      }
      const msg = (call.parsed as any).message;
      const validation = validateOutreach(msg, 'followup');
      if (!validation.ok) return errResult(`LLM draft failed safety rails: ${JSON.stringify(validation)}`);
      const id = await persistDraft({
        connection_id: original.connection_id,
        company_id:    original.company_id,
        related_job_id: original.related_job_id,
        outreach_type: 'followup',
        channel:       original.channel ?? 'linkedin',
        draft_message: msg,
        notes:         `followup to outreach ${original.id}`,
      });
      return okResult({ outreach_id: id, status: 'drafted', validation, message: msg });
    } catch (e: any) {
      return errResult(`api draft_followup failed: ${e?.message ?? String(e)}`);
    }
  },
  mutates: true,
 
});

// ── draft_reply ──────────────────────────────────────────────────────────────

export const draftReplyTool = defineTool({
  name: 'draft_reply',
  title: 'Draft a reply to a received reply',
  description: 'Contextual response draft for outreach in status=replied. Human edits + sends.',
  inputSchema: {
    outreach_id: z.string().min(1),
    received_reply: z.string().optional().describe('Override or supply the inbound reply text if not stored.'),
    mode:        z.enum(['chat','api']).default('chat'),
    message:     z.string().optional(),
  },
  handler: async (args) => {
    const db = getDb();
    const original = db.prepare(`SELECT * FROM outreach WHERE id = ?`).get(args.outreach_id) as any;
    if (!original) return errResult(`No outreach ${args.outreach_id}`);
    const reply = args.received_reply ?? original.reply_text ?? '';
    if (!reply) return errResult('No reply text on file. Pass `received_reply` to draft.');
    const conn = db.prepare(`SELECT * FROM linkedin_connections WHERE id = ?`).get(original.connection_id) as any;

    if (args.mode === 'chat' && args.message) {
      const validation = validateOutreach(args.message, 'reply');
      if (!validation.ok) return errResult(`reply validation failed: ${JSON.stringify(validation)}`);
      const id = await persistDraft({
        connection_id: original.connection_id,
        company_id:    original.company_id,
        related_job_id: original.related_job_id,
        outreach_type: 'generic',
        channel:       original.channel ?? 'linkedin',
        draft_message: args.message,
        notes:         `reply to outreach ${original.id}`,
      });
      return okResult({ outreach_id: id, status: 'drafted', validation });
    }

    if (args.mode === 'chat') {
      return okResult({
        instructions:
          'Match their energy. If they replied warmly with a question, answer it tightly and add one forward-moving piece. ' +
          'If they deflected, send 1-line thanks + an open door. Never beg. No visa mention. Then call draft_reply with `message` to persist.',
        char_cap: 800,
        original_message:  original.edited_message ?? original.draft_message,
        received_reply:    reply,
        connection:        conn ? { full_name: conn.full_name, position: conn.position } : null,
        career_packet:     getActiveCareerPacket()?.content ?? '',
        outreach_tone:     readOutreachTone(),
      });
    }

    // api mode
    try {
      const system = readOutreachTone() +
        '\n\n== TASK ==\nDraft a reply. Match their energy. NO visa mention. Output STRICT JSON: { "message": "..." }.';
      const user = JSON.stringify({
        original: original.edited_message ?? original.draft_message,
        received_reply: reply,
        connection: conn ? { full_name: conn.full_name, position: conn.position } : null,
      });
      const call = await chatLogged('draft_reply.api', [
        { role: 'system', content: system }, { role: 'user', content: user },
      ], { responseFormat: 'json_object', temperature: 0.5, maxTokens: 1000 });
      if (!call.parseOk || typeof (call.parsed as any)?.message !== 'string') {
        return errResult(`LLM produced unparseable output: ${call.parseError ?? 'no message'}`);
      }
      const msg = (call.parsed as any).message;
      const validation = validateOutreach(msg, 'reply');
      if (!validation.ok) return errResult(`LLM draft failed safety rails: ${JSON.stringify(validation)}`);
      const id = await persistDraft({
        connection_id: original.connection_id,
        company_id:    original.company_id,
        related_job_id: original.related_job_id,
        outreach_type: 'generic',
        channel:       original.channel ?? 'linkedin',
        draft_message: msg,
        notes:         `reply to outreach ${original.id}`,
      });
      return okResult({ outreach_id: id, status: 'drafted', validation, message: msg });
    } catch (e: any) {
      return errResult(`api draft_reply failed: ${e?.message ?? String(e)}`);
    }
  },
  mutates: true,
 
});

// ── helpers ──────────────────────────────────────────────────────────────────

interface PersistArgs {
  connection_id:  string;
  company_id:     string | null;
  related_job_id: string | null;
  outreach_type:  string;
  channel:        string;
  draft_message:  string;
  subject_line?:  string | null;
  notes?:         string | null;
}

async function persistDraft(p: PersistArgs): Promise<string> {
  return runInWriteLock(() => {
    const db = getDb();
    const existing = db.prepare(`
      SELECT id FROM outreach
      WHERE connection_id = ? AND COALESCE(related_job_id,'') = COALESCE(?,'') AND outreach_type = ? AND status IN ('queued','drafted','edited')
      ORDER BY datetime(updated_at) DESC LIMIT 1
    `).get(p.connection_id, p.related_job_id ?? '', p.outreach_type) as { id: string } | undefined;
    if (existing) {
      db.prepare(`
        UPDATE outreach SET draft_message = ?, subject_line = COALESCE(?, subject_line),
          notes = COALESCE(?, notes), status = 'drafted', updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(p.draft_message, p.subject_line ?? null, p.notes ?? null, existing.id);
      return existing.id;
    }
    const id = randomUUID();
    db.prepare(`
      INSERT INTO outreach (id, connection_id, company_id, related_job_id, outreach_type, channel, status,
                            draft_message, subject_line, notes)
      VALUES (?, ?, ?, ?, ?, ?, 'drafted', ?, ?, ?)
    `).run(id, p.connection_id, p.company_id, p.related_job_id, p.outreach_type, p.channel,
            p.draft_message, p.subject_line ?? null, p.notes ?? null);
    return id;
  });
}

function daysAgo(iso: string): number {
  const t = new Date(iso).getTime();
  return Math.max(0, Math.floor((Date.now() - t) / 86_400_000));
}
