// Public-facing story bank tool — mounted at /mcp/public.
//
// Mirrors get_story_bank but strips every column / join that would tie a story
// back to a specific application, job, or company. The closed public surface
// (§5) only ever exposes this + get_career_packet: no joins to jobs/companies,
// no job_id, no timestamps that double as timestamps, no application context.
// Only story_text, reflection, and competency_tags flow out — these are the
// fields the operator chose to capture, and they are what an external recruiter
// AI agent needs to reason about behavioral competencies.

import { z } from 'zod';

import { defineTool, okResult } from '../define.js';
import { getDb } from '../../db.js';

export const getStoryBankPublicTool = defineTool({
  name: 'get_story_bank_public',
  title: 'Public story bank (competencies only)',
  description:
    'Returns STAR+R stories stored in story_bank — ONLY story_text, reflection, and competency_tags. ' +
    'No join to jobs or companies, no application context, no timestamps. Safe to expose on the ' +
    'public MCP mount for recruiter-side AI agents.',
  inputSchema: {
    competency: z.string().optional().describe('Optional substring filter against competency_tags.'),
    limit:      z.number().int().min(1).max(200).default(50)
                  .describe('Maximum rows to return (capped at 200 to keep public responses bounded).'),
  },
  mutates: false,
  publicSafe: true,
  handler: async (args) => {
    const rows = getDb().prepare(`
      SELECT story_text, reflection, competency_tags
      FROM story_bank
      ORDER BY rowid DESC
      LIMIT ?
    `).all(args.limit) as Array<{ story_text: string; reflection: string | null; competency_tags: string | null }>;

    const filtered = args.competency
      ? rows.filter((r) => (r.competency_tags ?? '').toLowerCase().includes(args.competency!.toLowerCase()))
      : rows;

    return okResult({
      count: filtered.length,
      items: filtered.map((r) => ({
        story_text:      r.story_text,
        reflection:      r.reflection,
        competency_tags: r.competency_tags ? JSON.parse(r.competency_tags) : [],
      })),
    });
  },
});
