// MCP tools for the canonical career-packet.json (JSON Resume superset).
//
// compile_career_packet — compiles local data into career-packet.json, persists to DB + file.
// get_career_packet_json — returns the active compiled packet (read-only, publicSafe).

import { z } from 'zod';

import { defineTool, okResult, errResult } from '../define.js';
import { compileCareerPacketJson } from '../../core/career_packet_json.js';
import { getDb } from '../../db.js';

// ── compile_career_packet ─────────────────────────────────────────────────────

export const compileCareerPacketTool = defineTool({
  name: 'compile_career_packet',
  title: 'Compile canonical career-packet.json',
  description:
    'Compile the user\'s local data (cv.md, profile.yml, story_bank) into a canonical ' +
    'career-packet.json — a JSON Resume superset with Lightcast Open Skills IDs and ' +
    'verifiable provenance claims (evidence from story_bank). ' +
    'Persists to the career_packet_json table (versioned) and writes output/career-packet.json. ' +
    'Use lightcast_mode="llm" (default) to map skills to Lightcast IDs via the configured LLM. ' +
    'Use lightcast_mode="skip" to skip Lightcast mapping (faster, but skills have no IDs).',
  mutates: true,
  inputSchema: {
    lightcast_mode: z.enum(['llm', 'skip']).default('llm')
      .describe('Whether to map skills to Lightcast Open Skills IDs via the LLM. Default: "llm".'),
  },
  handler: async (args) => {
    try {
      const result = await compileCareerPacketJson({
        lightcastMode: args.lightcast_mode,
      });

      // Count skills and evidence for the summary
      const skillsCount = result.content.skills.reduce((sum, cat) => sum + cat.items.length, 0);
      const evidenceCount = result.content.evidence.length;
      const workCount = result.content.work.length;
      const projectsCount = result.content.projects.length;

      return okResult({
        version: result.version,
        content_hash: result.content_hash,
        lightcast_mapped: result.content.meta.lightcast_mapped,
        file_path: result.file_path,
        stats: {
          skills: skillsCount,
          evidence: evidenceCount,
          work_experiences: workCount,
          projects: projectsCount,
        },
        note: 'Career packet compiled successfully. Use sync_to_livingcv to push to your LivingCV instance.',
      });
    } catch (e: any) {
      return errResult(`Failed to compile career packet: ${e?.message ?? e}`);
    }
  },
});

// ── get_career_packet_json ────────────────────────────────────────────────────

export const getCareerPacketJsonTool = defineTool({
  name: 'get_career_packet_json',
  title: 'Get the active compiled career packet (JSON)',
  description:
    'Returns the active career_packet_json row — the compiled canonical career-packet.json ' +
    '(JSON Resume superset with Lightcast IDs and evidence). ' +
    'Read-only. Safe to expose on the public MCP surface.',
  mutates: false,
  publicSafe: true,
  inputSchema: {},
  handler: async () => {
    const row = getDb()
      .prepare(`SELECT id, version, content, content_hash, lightcast_mapped, created_at FROM career_packet_json WHERE is_active = 1`)
      .get() as any;

    if (!row) {
      return errResult(
        'No active compiled career packet. Run compile_career_packet first to compile from cv.md + profile.yml + story_bank.',
      );
    }

    let content;
    try {
      content = JSON.parse(row.content);
    } catch {
      return errResult('Active career_packet_json row has malformed content (JSON parse failed).');
    }

    return okResult({
      id: row.id,
      version: row.version,
      content,
      content_hash: row.content_hash,
      lightcast_mapped: !!row.lightcast_mapped,
      created_at: row.created_at,
    });
  },
});
