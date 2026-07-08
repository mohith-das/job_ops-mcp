// MCP tools for edge embedding generation.
//
// generate_embeddings — generates vector embeddings of the career-packet.json sections.
// get_embeddings — returns cached embedding metadata (without the vectors).

import { z } from 'zod';

import { defineTool, okResult, errResult } from '../define.js';
import { embedPacket, getEmbedder, embeddingAvailable } from '../../core/embeddings.js';
import { getDb } from '../../db.js';

// ── generate_embeddings ───────────────────────────────────────────────────────

export const generateEmbeddingsTool = defineTool({
  name: 'generate_embeddings',
  title: 'Generate vector embeddings of the career packet',
  description:
    'Generate vector embeddings of the career-packet.json sections using the configured ' +
    'embedding provider (local all-MiniLM-L6-v2, OpenAI, or Voyage). Embeddings are cached ' +
    'by packet_hash, so re-running on unchanged content returns cached results instantly. ' +
    'Use force=true to re-embed even if cached. ' +
    'Requires a compiled career packet (run compile_career_packet first).',
  mutates: true,
  inputSchema: {
    force: z.boolean().default(false)
      .describe('Re-embed even if embeddings are cached for this packet_hash. Default: false.'),
  },
  handler: async (args) => {
    if (!embeddingAvailable()) {
      return errResult(
        'No embedding provider configured. Set JOBOPS_EMBEDDING_PROVIDER to "local", "openai", or "voyage" in .env. ' +
        'For "local", ensure @xenova/transformers is installed: npm install @xenova/transformers',
      );
    }

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

    // If force=true, clear cache for this packet
    if (args.force) {
      // We don't know the hash yet, so we clear all embeddings for the current model
      // and let embedPacket regenerate them. This is a bit wasteful but simple.
      const embedder = getEmbedder();
      getDb().prepare(`DELETE FROM embeddings_cache WHERE model = ?`).run(embedder.model);
    }

    try {
      const result = await embedPacket(packet);

      return okResult({
        packet_hash: result.packet_hash,
        sections_embedded: result.sections.length,
        model: result.model,
        dim: result.sections[0]?.dim ?? 0,
        cached: result.cached,
        generated_at: result.generated_at,
        note: result.cached
          ? 'All embeddings were cached (packet unchanged since last embed).'
          : `Generated ${result.sections.length} new embeddings. Cached for future use.`,
      });
    } catch (e: any) {
      return errResult(`Failed to generate embeddings: ${e?.message ?? e}`);
    }
  },
});

// ── get_embeddings ────────────────────────────────────────────────────────────

export const getEmbeddingsTool = defineTool({
  name: 'get_embeddings',
  title: 'Get cached embedding metadata',
  description:
    'Returns metadata about cached embeddings for the active career packet (sections, model, dim, ' +
    'generated_at). Does NOT return the actual vector data (use broadcast_signal for that). ' +
    'Read-only.',
  mutates: false,
  inputSchema: {},
  handler: async () => {
    // Check for active career_packet_json
    const packetRow = getDb()
      .prepare(`SELECT content_hash FROM career_packet_json WHERE is_active = 1`)
      .get() as any;

    if (!packetRow) {
      return errResult('No compiled career packet found. Run compile_career_packet first.');
    }

    // Get cached embeddings for this packet
    const rows = getDb()
      .prepare(`
        SELECT section, model, dim, created_at
        FROM embeddings_cache
        WHERE packet_hash = ?
        ORDER BY section
      `)
      .all(packetRow.content_hash) as any[];

    if (rows.length === 0) {
      return okResult({
        packet_hash: packetRow.content_hash,
        embeddings_cached: false,
        sections: [],
        note: 'No embeddings cached for this packet. Run generate_embeddings to create them.',
      });
    }

    const sections = rows.map((r) => ({
      section: r.section,
      model: r.model,
      dim: r.dim,
      created_at: r.created_at,
    }));

    return okResult({
      packet_hash: packetRow.content_hash,
      embeddings_cached: true,
      sections,
      note: `${sections.length} embedding section(s) cached.`,
    });
  },
});
