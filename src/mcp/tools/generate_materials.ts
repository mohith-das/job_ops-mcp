// generate_materials — picks subsets from career_packet per JD using tailoring_rules.md.
// Writes tailored_bullets + cover_letter_draft to applications. chat-mode default;
// api-mode runs the LLM with strict-JSON parse. The brief: "never invent claims not in
// career_packet" — we enforce this by re-checking the LLM output against the packet for
// any concrete metrics it cites (best-effort; the chat is the final guard).

import { z } from 'zod';
import { randomUUID } from 'node:crypto';

import { getDb, runInWriteLock } from '../../db.js';
import { defineTool, okResult, errResult } from '../define.js';
import { chatLogged } from '../../core/llm.js';
import { getActiveCareerPacket } from '../../core/profile.js';
import { scanForVisaLeakage } from '../../core/outreach_safety.js';
import { getMode } from '../../core/modes.js';

// `experience_bullets` is a map keyed by employer/role slug — the slugs come from the
// user's own career_packet, so the renderer doesn't bake in any specific employer name.
const materialsShape = z.object({
  tagline:            z.string().optional(),
  experience_bullets: z.record(z.string(), z.array(z.string())).optional(),
  projects_section:   z.string().optional(),
  skills_section:     z.string().optional(),
  cover_letter_body:  z.string().optional(),
  tailoring_notes:    z.string().optional(),
});

export const generateMaterialsTool = defineTool({
  name: 'generate_materials',
  title: 'Generate tailored resume bullets + cover letter',
  description:
    'Picks bullets / tagline / cover from the active career_packet per the JD via tailoring_rules. ' +
    'chat-mode default returns context for the chat to draft. api-mode calls the LLM, validates against ' +
    'the visa rail, and writes tailored_bullets + cover_letter_draft to the application row.',
    mutates: true,
inputSchema: {
    job_id:    z.string().min(1),
    mode:      z.enum(['chat','api']).default('chat'),
    materials: materialsShape.optional()
                .describe('Provide on a second chat-mode call to persist what the chat drafted.'),
  },
  handler: async (args) => {
    const db = getDb();
    const job = db.prepare(`
      SELECT j.*, COALESCE(c.name, j.company_name_raw) AS company_name
      FROM jobs j LEFT JOIN companies c ON c.id = j.company_id WHERE j.id = ?
    `).get(args.job_id) as any;
    if (!job) return errResult(`No job ${args.job_id}`);

    if (args.mode === 'chat' && args.materials) {
      const result = await persistMaterials(args.job_id, args.materials);
      return okResult(result);
    }

    if (args.mode === 'chat') {
      return okResult({
        instructions:
          'Read modes/tailoring_rules.md and modes/career_packet.md. Pick subsets per JD. Output STRICT JSON ' +
          'matching the contract in tailoring_rules.md. NEVER invent metrics not in the packet. NEVER mention ' +
          'visa / OPT / sponsorship in any bullet or in the cover letter. Then call generate_materials AGAIN with `materials` to persist.',
        job: { id: job.id, title: job.title, company: job.company_name, location: job.location_raw,
                role_category: job.role_category, seniority: job.seniority,
                description: job.description, requirements: job.requirements },
        tailoring_rules: getMode('tailoring_rules.md'),
        career_packet:   getActiveCareerPacket()?.content ?? '',
      });
    }

    // api mode
    try {
      const system =
        getMode('tailoring_rules.md') +
        '\n\n== CAREER PACKET (AUTHORITATIVE — never invent claims outside this) ==\n' +
        (getActiveCareerPacket()?.content ?? '') +
        '\n\n== INSTRUCTIONS ==\nOutput STRICT JSON only. NO LaTeX in cover_letter_body. NO visa / OPT / sponsorship mentions.';
      const user = JSON.stringify({
        title: job.title, company: job.company_name, location: job.location_raw,
        role_category: job.role_category, seniority: job.seniority,
        description: (job.description ?? '').slice(0, 10_000),
        requirements: job.requirements ?? null,
      });
      const call = await chatLogged('generate_materials.api', [
        { role: 'system', content: system }, { role: 'user', content: user },
      ], { responseFormat: 'json_object', temperature: 0.4, maxTokens: 6000, jobId: job.id });
      if (!call.parseOk) return errResult(`LLM produced unparseable output: ${call.parseError}`);
      const m = call.parsed as any;
      const result = await persistMaterials(args.job_id, m);
      return okResult({ ...result, parse_ok: true });
    } catch (e: any) {
      return errResult(`api generate_materials failed: ${e?.message ?? String(e)}`);
    }
  },
});

/**
 * Concatenates the materials fields that end up in the actual delivered resume + cover
 * letter. Used by the visa-rail scan. Internal-only fields (tailoring_notes, debug
 * scratch) are deliberately excluded — a chat note saying "I made sure not to mention
 * visa" should NOT trip the rail. Exported for tests.
 */
export function candidateFacingMaterialsText(m: any): string {
  const parts: string[] = [];
  if (typeof m?.tagline === 'string') parts.push(m.tagline);
  if (m?.experience_bullets && typeof m.experience_bullets === 'object') {
    for (const v of Object.values(m.experience_bullets)) {
      if (Array.isArray(v)) {
        for (const b of v) if (typeof b === 'string') parts.push(b);
      }
    }
  }
  if (typeof m?.projects_section  === 'string') parts.push(m.projects_section);
  if (typeof m?.skills_section    === 'string') parts.push(m.skills_section);
  if (typeof m?.cover_letter_body === 'string') parts.push(m.cover_letter_body);
  return parts.join('\n');
}

async function persistMaterials(job_id: string, m: any): Promise<any> {
  // Visa rail across only the candidate-facing text. tailoring_notes is internal meta
  // and may legitimately mention visa as a deliberate-omission note — don't trip on it.
  const leaks = scanForVisaLeakage(candidateFacingMaterialsText(m));
  if (leaks.length) {
    throw new Error(`materials failed visa rail: ${JSON.stringify(leaks)} — not persisted`);
  }
  return runInWriteLock(() => {
    const db = getDb();
    const existing = db.prepare(`SELECT id, materials_v FROM applications WHERE job_id = ?`).get(job_id) as { id: string; materials_v: number } | undefined;
    const tailored = JSON.stringify({
      tagline:            m.tagline ?? null,
      experience_bullets: m.experience_bullets ?? null,
      projects_section:   m.projects_section ?? null,
      skills_section:     m.skills_section ?? null,
    });
    if (existing) {
      const newV = existing.materials_v + 1;
      db.prepare(`
        UPDATE applications SET
          tailored_bullets = ?, cover_letter_draft = ?, tailoring_notes = ?,
          materials_v = ?, status = 'materials_drafted', last_status_change_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP,
          resume_tex = NULL, cover_letter_tex = NULL  -- mark for re-render
        WHERE id = ?
      `).run(tailored, m.cover_letter_body ?? null, m.tailoring_notes ?? null, newV, existing.id);
      // Mirror status onto jobs row.
      db.prepare(`UPDATE jobs SET status = 'materials_drafted', materials_generated_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(job_id);
      return { application_id: existing.id, job_id, materials_v: newV, status: 'materials_drafted' };
    }
    const appId = randomUUID();
    db.prepare(`
      INSERT INTO applications (
        id, job_id, status, tailored_bullets, cover_letter_draft, tailoring_notes, materials_v
      ) VALUES (?, ?, 'materials_drafted', ?, ?, ?, 1)
    `).run(appId, job_id, tailored, m.cover_letter_body ?? null, m.tailoring_notes ?? null);
    db.prepare(`UPDATE jobs SET status = 'materials_drafted', materials_generated_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(job_id);
    return { application_id: appId, job_id, materials_v: 1, status: 'materials_drafted' };
  });
}
