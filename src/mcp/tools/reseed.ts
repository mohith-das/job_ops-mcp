// reseed_career_packet — rebuild the active career_packet from the current cv.md +
// config/profile.yml. Bumps version, demotes the previous active row (history kept).
// Same underlying logic as the CLI `reseed` subcommand.

import { z } from 'zod';

import { defineTool, okResult, errResult } from '../define.js';
import { seedCareerPacketFromFiles, loadProjectFiles, cvHasRealContent, packetPreview } from '../../core/profile.js';

export const reseedCareerPacketTool = defineTool({
  name: 'reseed_career_packet',
  title: 'Rebuild the career packet from cv.md + profile.yml',
  description:
    'Re-reads cv.md and config/profile.yml and writes a NEW active career_packet version, ' +
    'demoting the previous one (history retained). SAFE by default: if the active packet has ' +
    'chat edits (made via update_career_packet) that are not in cv.md, reseed REFUSES and warns ' +
    'rather than overwriting them — pass force:true to rebuild from cv.md anyway, or run ' +
    'sync_packet_to_cv first to write those edits back into cv.md. Identity comes from ' +
    'profile.yml; bullets / projects / skills / education come from cv.md.',
    mutates: true,
inputSchema: {
    force: z.boolean().optional()
      .describe('Rebuild from cv.md even if the active packet has chat edits (DESTRUCTIVE to those edits). Default false = safe.'),
    confirm_empty_cv: z.boolean().optional()
      .describe('cv.md missing or trivially small? Set true to seed identity-only anyway. Default false (errors instead).'),
  },
  handler: async (args) => {
    const { cvMd } = loadProjectFiles();
    if (!cvHasRealContent(cvMd) && !args.confirm_empty_cv) {
      return errResult(
        'cv.md is missing or still looks like the <TODO> example template. ' +
        'Fill it in first, then re-run. Pass confirm_empty_cv=true to reseed anyway ' +
        '(identity-only — most sections will stay as <TODO> placeholders).',
      );
    }
    const r = await seedCareerPacketFromFiles({ mode: 'reseed', force: !!args.force });
    if (r.blocked) {
      // Non-destructive default: surface the warning, change nothing.
      return errResult(`reseed refused (no changes made): ${r.blocked_reason}`);
    }
    return okResult({
      ok: true,
      forced:                    !!args.force,
      new_version:               r.version,
      bytes:                     r.bytes,
      sections_with_cv_content:  r.sections_with_cv_content,
      sections_max:              6,
      preview:                   packetPreview(r.preview, 400),
      note:                      'previous active packet demoted; history retained in career_packet table',
    });
  },
});
