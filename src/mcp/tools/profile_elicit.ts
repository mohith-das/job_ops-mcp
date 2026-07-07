// update_profile — capture identity fields + per-archetype taglines through MCP
// elicitation (form mode) instead of hand-editing config/profile.yml, then reseed the
// career packet so the changes take effect immediately.
//
// Capability-gated + graceful degradation:
//   • client supports elicitation  → server requests a form; on accept we merge + reseed;
//   • caller passes `fields` arg    → programmatic path (also the test path), merge + reseed;
//   • neither                       → return the field list + instructions to edit the YAML
//                                     (the existing file-based path still works).

import { z } from 'zod';

import { defineTool, okResult, errResult } from '../define.js';
import {
  applyProfileUpdate, seedCareerPacketFromFiles, loadProjectFiles, packetPreview,
  type ProfileUpdate,
} from '../../core/profile.js';
import type { ElicitObjectSchema } from '../client_bridge.js';

// Flat schema — elicitation requestedSchema allows only primitive properties (no nesting),
// so taglines are captured as up to three archetype/tagline pairs.
const FORM_SCHEMA: ElicitObjectSchema = {
  type: 'object',
  properties: {
    full_name:     { type: 'string', title: 'Full name' },
    email:         { type: 'string', title: 'Email', format: 'email' },
    phone:         { type: 'string', title: 'Phone' },
    location:      { type: 'string', title: 'Location (City, Country)' },
    linkedin:      { type: 'string', title: 'LinkedIn URL' },
    github:        { type: 'string', title: 'GitHub URL' },
    portfolio_url: { type: 'string', title: 'Portfolio URL' },
    tagline_1_archetype: { type: 'string', title: 'Tagline 1 — archetype (e.g. Builder PM)' },
    tagline_1_text:      { type: 'string', title: 'Tagline 1 — one-line positioning' },
    tagline_2_archetype: { type: 'string', title: 'Tagline 2 — archetype (e.g. Applied AI Engineer)' },
    tagline_2_text:      { type: 'string', title: 'Tagline 2 — one-line positioning' },
    tagline_3_archetype: { type: 'string', title: 'Tagline 3 — archetype (e.g. Forward-Deployed)' },
    tagline_3_text:      { type: 'string', title: 'Tagline 3 — one-line positioning' },
  },
  required: [],
};

const CANDIDATE_KEYS = ['full_name', 'email', 'phone', 'location', 'linkedin', 'github', 'portfolio_url'] as const;

/** Turn a flat form/content record into a structured ProfileUpdate. */
export function contentToProfileUpdate(content: Record<string, any>): ProfileUpdate {
  const candidate: Record<string, string> = {};
  for (const k of CANDIDATE_KEYS) {
    const v = content[k];
    if (typeof v === 'string' && v.trim()) candidate[k] = v.trim();
  }
  const taglines: Record<string, string> = {};
  for (const i of [1, 2, 3]) {
    const a = content[`tagline_${i}_archetype`];
    const t = content[`tagline_${i}_text`];
    if (typeof a === 'string' && a.trim() && typeof t === 'string' && t.trim()) {
      taglines[a.trim()] = t.trim();
    }
  }
  return { candidate, taglines };
}

export const updateProfileTool = defineTool({
  name: 'update_profile',
  title: 'Update profile (identity + taglines) via elicitation',
  description:
    'Capture or update your identity fields and per-archetype taglines, then reseed the career ' +
    'packet — no manual YAML edit. Uses MCP elicitation (form mode) when the client supports it; ' +
    'otherwise pass `fields` directly, or edit config/profile.yml by hand (the file path still works).',
    mutates: true,
inputSchema: {
    fields: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional()
      .describe('Programmatic path: flat values (full_name, email, …, tagline_1_archetype, tagline_1_text, …). ' +
                'When omitted and the client supports elicitation, the server requests a form instead.'),
    reseed: z.boolean().default(true).describe('Rebuild the career packet from the updated profile after saving.'),
  },
  handler: async (args, ctx) => {
    let content: Record<string, any> | null = args.fields ? { ...args.fields } : null;

    // No explicit fields → try elicitation.
    if (!content) {
      if (ctx?.bridge?.canElicit()) {
        const r = await ctx.bridge.elicitForm({
          message: 'Update your jobops profile. Leave any field blank to keep its current value. '
                 + 'Taglines auto-fill career-packet Section 2 (one per archetype).',
          requestedSchema: FORM_SCHEMA,
        });
        if (r.action !== 'accept' || !r.content) {
          return okResult({ updated: false, action: r.action,
            note: 'Elicitation was not accepted — profile unchanged.' });
        }
        content = r.content;
      } else {
        // Fallback: no elicitation support and no fields — tell the user how to proceed.
        return okResult({
          updated: false,
          elicitation_supported: false,
          fallback: 'Your client does not support elicitation. Either pass `fields` to this tool, '
                  + 'or edit config/profile.yml by hand and run reseed.',
          editable_fields: Object.keys(FORM_SCHEMA.properties),
        });
      }
    }

    const update = contentToProfileUpdate(content);
    if (!update.candidate || (Object.keys(update.candidate).length === 0 && Object.keys(update.taglines ?? {}).length === 0)) {
      return okResult({ updated: false, note: 'No non-empty values supplied — profile unchanged.' });
    }

    const saved = applyProfileUpdate(update);

    let reseed: any = null;
    if (args.reseed) {
      const { cvMd } = loadProjectFiles();
      const r = await seedCareerPacketFromFiles({ mode: 'reseed' });
      reseed = {
        new_version: r.version,
        sections_with_cv_content: r.sections_with_cv_content,
        cv_present: !!cvMd,
        preview: packetPreview(r.preview, 300),
      };
    }

    return okResult({
      updated: true,
      profile_path: saved.path,
      candidate_fields_set: saved.candidate_fields_set,
      taglines_set: saved.taglines_set,
      reseed,
    });
  },
});
