// Edge embedding generation for career-packet.json.
//
// Generates vector embeddings of the user's career packet sections locally using
// a small model (all-MiniLM-L6-v2 via @xenova/transformers) or a user-provided API
// key (OpenAI, Voyage). Embeddings are cached by packet_hash so we only re-embed
// when content changes.
//
// This is the "edge compute" piece: no data leaves the machine for embedding
// (when using the local provider), preserving privacy while enabling semantic
// search and signal matching.

import { createHash, randomUUID } from 'node:crypto';

import { getDb, runInWriteLock } from '../db.js';
import type { CareerPacketJson } from './career_packet_json.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface EmbeddingProvider {
  name: string;
  model: string;
  dim: number;
  embed(texts: string[]): Promise<number[][]>;
}

export interface EmbeddingResult {
  packet_hash: string;
  sections: Array<{
    section: string;
    embedding: number[];
    dim: number;
    model: string;
  }>;
  model: string;
  generated_at: string;
  cached: boolean;
}

// ── Provider factory ──────────────────────────────────────────────────────────

let _cached: EmbeddingProvider | null = null;

export function getEmbedder(): EmbeddingProvider {
  if (_cached) return _cached;

  // Read from process.env directly (not config) so tests can change it at runtime
  const provider = (process.env.JOBOPS_EMBEDDING_PROVIDER || 'local').toLowerCase();
  const model = process.env.JOBOPS_EMBEDDING_MODEL || 'all-MiniLM-L6-v2';

  if (provider === 'local') {
    _cached = new LocalEmbedder(model);
  } else if (provider === 'openai') {
    _cached = new OpenAIEmbedder(model);
  } else if (provider === 'voyage') {
    _cached = new VoyageEmbedder(model);
  } else {
    _cached = new NoneEmbedder();
  }

  return _cached;
}

export function resetEmbedderCache(): void {
  _cached = null;
}

export function embeddingAvailable(): boolean {
  return getEmbedder().name !== 'none';
}

// ── Local embedder (all-MiniLM-L6-v2 via @xenova/transformers) ────────────────

class LocalEmbedder implements EmbeddingProvider {
  name = 'local';
  model: string;
  dim = 384; // all-MiniLM-L6-v2 produces 384-dim vectors

  private _pipeline: any = null;

  constructor(model: string) {
    this.model = model;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (!texts.length) return [];

    // Lazy-load the pipeline on first call
    if (!this._pipeline) {
      try {
        const { pipeline } = await import('@xenova/transformers');
        this._pipeline = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
      } catch (e: any) {
        throw new Error(
          `Failed to load local embedding model. Ensure @xenova/transformers is installed: ` +
          `npm install @xenova/transformers. Error: ${e?.message ?? e}`,
        );
      }
    }

    // Generate embeddings (mean-pooling + L2 normalization)
    const embeddings: number[][] = [];
    for (const text of texts) {
      const output = await this._pipeline(text, { pooling: 'mean', normalize: true });
      // Convert tensor to plain array
      const arr = Array.from(output.data as Float32Array);
      embeddings.push(arr);
    }

    return embeddings;
  }
}

// ── OpenAI embedder ───────────────────────────────────────────────────────────

class OpenAIEmbedder implements EmbeddingProvider {
  name = 'openai';
  model: string;
  dim: number;

  constructor(model: string) {
    this.model = model || 'text-embedding-3-small';
    // Dimension depends on model
    this.dim = this.model.includes('large') ? 3072 : 1536;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (!texts.length) return [];

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY not set. Set it in .env or export it.');
    }

    const res = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        input: texts,
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`OpenAI embeddings API error: ${res.status} ${text.slice(0, 200)}`);
    }

    const json = await res.json();
    return json.data.map((d: any) => d.embedding);
  }
}

// ── Voyage embedder ───────────────────────────────────────────────────────────

class VoyageEmbedder implements EmbeddingProvider {
  name = 'voyage';
  model: string;
  dim: number;

  constructor(model: string) {
    this.model = model || 'voyage-3-lite';
    // Dimension depends on model
    this.dim = this.model.includes('large') ? 1024 : 384;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (!texts.length) return [];

    const apiKey = process.env.VOYAGE_API_KEY;
    if (!apiKey) {
      throw new Error('VOYAGE_API_KEY not set. Set it in .env or export it.');
    }

    const res = await fetch('https://api.voyageai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        input: texts,
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Voyage embeddings API error: ${res.status} ${text.slice(0, 200)}`);
    }

    const json = await res.json();
    return json.data.map((d: any) => d.embedding);
  }
}

// ── None embedder (no provider configured) ────────────────────────────────────

class NoneEmbedder implements EmbeddingProvider {
  name = 'none';
  model = 'none';
  dim = 0;

  async embed(_texts: string[]): Promise<number[][]> {
    throw new Error(
      'No embedding provider configured. Set JOBOPS_EMBEDDING_PROVIDER to "local", "openai", or "voyage". ' +
      'For "local", ensure @xenova/transformers is installed.',
    );
  }
}

// ── Packet embedding ──────────────────────────────────────────────────────────

/**
 * Break a career packet into sections and embed each one.
 *
 * Sections:
 *   - 'full': the entire packet as a single string
 *   - 'summary': basics.summary + basics.headline
 *   - 'skills': all skill names joined
 *   - 'work_0', 'work_1', ...: each work experience (bullets joined)
 *   - 'project_0', 'project_1', ...: each project (description)
 *   - 'evidence_0', 'evidence_1', ...: each evidence claim (story_text)
 *
 * Results are cached in embeddings_cache keyed by (packet_hash, section, model).
 * If all sections are already cached for this packet_hash + model, we return the
 * cached embeddings without re-computing.
 */
export async function embedPacket(packet: CareerPacketJson): Promise<EmbeddingResult> {
  const embedder = getEmbedder();
  if (embedder.name === 'none') {
    throw new Error('No embedding provider configured.');
  }

  // Compute packet hash
  const packetStr = JSON.stringify(packet, null, 2);
  const packet_hash = sha256(packetStr);

  // Break into sections
  const sections = breakIntoSections(packet);
  const sectionNames = Object.keys(sections);

  // Check cache
  const db = getDb();
  const cachedRows = db
    .prepare(`SELECT section, embedding FROM embeddings_cache WHERE packet_hash = ? AND model = ?`)
    .all(packet_hash, embedder.model) as any[];

  const cachedMap = new Map<string, number[]>();
  for (const row of cachedRows) {
    cachedMap.set(row.section, JSON.parse(row.embedding));
  }

  // Determine which sections need embedding
  const toEmbed: Array<{ section: string; text: string }> = [];
  for (const section of sectionNames) {
    if (!cachedMap.has(section)) {
      toEmbed.push({ section, text: sections[section] });
    }
  }

  // Embed uncached sections
  if (toEmbed.length > 0) {
    const texts = toEmbed.map((t) => t.text);
    const embeddings = await embedder.embed(texts);

    // Store in cache
    await runInWriteLock(() => {
      const stmt = db.prepare(`
        INSERT OR REPLACE INTO embeddings_cache (id, packet_hash, section, embedding, model, dim)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (let i = 0; i < toEmbed.length; i++) {
        stmt.run(
          randomUUID(),
          packet_hash,
          toEmbed[i].section,
          JSON.stringify(embeddings[i]),
          embedder.model,
          embedder.dim,
        );
      }
    });

    // Update cached map
    for (let i = 0; i < toEmbed.length; i++) {
      cachedMap.set(toEmbed[i].section, embeddings[i]);
    }
  }

  // Build result
  const resultSections = sectionNames.map((section) => ({
    section,
    embedding: cachedMap.get(section)!,
    dim: embedder.dim,
    model: embedder.model,
  }));

  return {
    packet_hash,
    sections: resultSections,
    model: embedder.model,
    generated_at: new Date().toISOString(),
    cached: toEmbed.length === 0,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function breakIntoSections(packet: CareerPacketJson): Record<string, string> {
  const sections: Record<string, string> = {};

  // Full packet
  sections['full'] = JSON.stringify(packet);

  // Summary
  const summaryParts = [packet.basics.headline, packet.basics.summary].filter(Boolean);
  sections['summary'] = summaryParts.join(' ');

  // Skills
  const allSkills = packet.skills.flatMap((cat) => cat.items.map((i) => i.name));
  sections['skills'] = allSkills.join(', ');

  // Work experiences
  packet.work.forEach((w, i) => {
    const parts = [w.company, w.position, ...w.bullets].filter(Boolean);
    sections[`work_${i}`] = parts.join(' ');
  });

  // Projects
  packet.projects.forEach((p, i) => {
    const parts = [p.title, p.description, p.tech].filter(Boolean);
    sections[`project_${i}`] = parts.join(' ');
  });

  // Evidence
  packet.evidence.forEach((e, i) => {
    const parts = [e.story_text, e.reflection].filter(Boolean);
    sections[`evidence_${i}`] = parts.join(' ');
  });

  return sections;
}

function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf-8').digest('hex');
}
