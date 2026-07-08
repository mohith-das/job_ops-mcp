// MCP tool for syncing career-packet.json to LivingCV.
//
// sync_to_livingcv — pushes the compiled career packet to a local LivingCV instance.

import { z } from 'zod';

import { defineTool, okResult, errResult } from '../define.js';
import { syncToLivingCV } from '../../core/livingcv_client.js';
import { getDb } from '../../db.js';

export const syncToLivingCVTool = defineTool({
  name: 'sync_to_livingcv',
  title: 'Sync career packet to LivingCV',
  description:
    'Push the compiled career-packet.json to a local LivingCV instance via JSON-RPC. ' +
    'Authenticates using LivingCV\'s Master Relay bearer token (JOBOPS_LIVINGCV_TOKEN). ' +
    'Requires a compiled career packet (run compile_career_packet first). ' +
    'Use force=true to sync even if the content hasn\'t changed since last sync.',
  mutates: true,
  inputSchema: {
    force: z.boolean().default(false)
      .describe('Sync even if content hasn\'t changed since last sync. Default: false.'),
  },
  handler: async (args) => {
    // Check for active career_packet_json
    const packetRow = getDb()
      .prepare(`SELECT content FROM career_packet_json WHERE is_active = 1`)
      .get() as any;

    if (!packetRow) {
      return errResult(
        'No compiled career packet found. Run compile_career_packet first to compile cv.md + profile.yml + story_bank into career-packet.json.',
      );
    }

    let packet;
    try {
      packet = JSON.parse(packetRow.content);
    } catch {
      return errResult('Active career_packet_json has malformed content (JSON parse failed).');
    }

    const result = await syncToLivingCV(packet, args.force);

    if (result.ok) {
      return okResult({
        synced: true,
        livingcv_url: result.livingcv_url,
        packet_version: result.packet_version,
        content_hash: result.content_hash,
        response: result.response,
        note: `Career packet synced to LivingCV at ${result.livingcv_url}.`,
      });
    } else {
      return errResult(
        `Failed to sync to LivingCV: ${result.error}` +
        (result.fix ? `\n\nFix: ${result.fix}` : ''),
      );
    }
  },
});
