// sync_packet_to_cv — write the active career packet back into the source files
// (cv.md + config/profile.yml), the inverse of reseed. Makes the two directions symmetric
// and explicit: reseed (cv.md → packet) and sync-back (packet → cv.md), neither automatic
// nor silently destructive.
//
// Use when you've been editing the packet from chat (update_career_packet) and want the
// source files brought up to date FROM those edits — e.g. so cv.md stops drifting stale, or
// so a forced reseed reproduces the packet instead of clobbering it.

import { z } from 'zod';

import { defineTool, okResult, errResult } from '../define.js';
import { getActiveCareerPacket, syncPacketToSourceFiles, seedCareerPacketFromFiles, packetPreview } from '../../core/profile.js';

export const syncPacketToCvTool = defineTool({
  name: 'sync_packet_to_cv',
  title: 'Write the active packet back into cv.md + profile.yml',
  description:
    'Inverse of reseed: writes the active career_packet back into the source files — Sections 3–8 ' +
    '(experience / projects / skills / education) → cv.md; Section 2 taglines + Section 1 identity → ' +
    'config/profile.yml. Use this to bring cv.md up to date from chat edits so it stops drifting stale. ' +
    'Non-destructive to the packet (only writes the source files). Optionally pass then_reseed:true to ' +
    'immediately rebuild a reseed-origin packet from the freshly-synced cv.md (makes the packet and ' +
    'source files consistent and clears the chat-edited flag).',
    mutates: true,
inputSchema: {
    then_reseed: z.boolean().optional()
      .describe('After writing the source files, force-reseed so the active packet is rebuilt from the synced cv.md (origin becomes reseed). Default false — leaves your chat-edited packet active.'),
  },
  handler: async (args) => {
    const active = getActiveCareerPacket();
    if (!active) return errResult('No active career_packet to sync. Run init/reseed first.');

    let sync;
    try {
      sync = syncPacketToSourceFiles();
    } catch (e: any) {
      return errResult(`sync_packet_to_cv failed: ${e?.message ?? String(e)}`);
    }

    const base = {
      ok: true,
      synced_from_version: active.version,
      cv_path: sync.cv_path,
      profile_path: sync.profile_path,
      cv_bytes: sync.cv_bytes,
      wrote: {
        roles: sync.roles, projects: sync.projects, skills: sync.skills,
        education: sync.education, taglines: sync.taglines, identity_fields: sync.identity_fields,
      },
    };

    if (args.then_reseed) {
      const r = await seedCareerPacketFromFiles({ mode: 'reseed', force: true });
      return okResult({
        ...base,
        reseeded: true,
        new_version: r.version,
        sections_with_cv_content: r.sections_with_cv_content,
        preview: packetPreview(r.preview, 300),
        note: 'cv.md + profile.yml updated from the packet, then reseeded — packet is now reseed-origin and consistent with the source files.',
      });
    }

    return okResult({
      ...base,
      reseeded: false,
      note: 'cv.md + profile.yml updated from the active packet. The chat-edited packet is still active. '
          + 'Run reseed_career_packet force:true (or sync again with then_reseed:true) to rebuild a reseed-origin '
          + 'packet from cv.md — it will now reproduce your edits.',
    });
  },
});
