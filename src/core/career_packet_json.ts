// Compile the user's local data (cv.md, profile.yml, story_bank) into a canonical
// career-packet.json — a JSON Resume superset with Lightcast Open Skills IDs and
// verifiable provenance claims (evidence from story_bank).
//
// This is the "edge intelligence" output: a structured, machine-readable packet that
// can be synced to LivingCV (personal relay) and embedded locally for signal broadcast
// to HireBridge (central router).

import { createHash, randomUUID } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { config } from '../config.js';
import { getDb, runInWriteLock } from '../db.js';
import { parseCV, type CVData, type ExperienceItem } from './cv_parse.js';
import { loadProjectFiles, getActiveCareerPacket } from './profile.js';
import { mapSkillsToLightcast } from './lightcast.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CareerPacketJson {
  schema: 'jobops-federation-1.0';
  meta: {
    version: number;
    generated_at: string;
    source_cv_hash: string | null;
    source_packet_version: number | null;
    lightcast_mapped: boolean;
  };
  basics: {
    name: string;
    email: string;
    phone: string;
    location: { city: string; country: string; timezone: string };
    linkedin: string;
    github: string;
    portfolio: string;
    summary: string;
    headline: string;
  };
  target_roles: {
    primary: string[];
    archetypes: Array<{ name: string; level: string; fit: string }>;
  };
  taglines: Record<string, string>;
  work: Array<{
    company: string;
    position: string;
    period: string;
    location: string;
    bullets: string[];
    evidence: Array<{ story_id: string; competency_tags: string[] }>;
  }>;
  projects: Array<{ title: string; description: string; tech: string | null }>;
  education: Array<{ title: string; org: string; year: string }>;
  skills: Array<{
    category: string;
    items: Array<{ name: string; lightcast_id: string | null; confidence: number }>;
  }>;
  evidence: Array<{
    id: string;
    story_text: string;
    reflection: string | null;
    competency_tags: string[];
    source_job_id: string | null;
    source_company: string | null;
  }>;
  compensation: {
    target_range: string;
    currency: string;
    minimum: string;
    location_flexibility: string;
  };
  narrative: {
    superpowers: string[];
    likes: string[];
    dislikes: string[];
    proof_points: Array<{ name: string; url: string; hero_metric: string }>;
  };
}

export interface CompiledPacket {
  id: string;
  version: number;
  content: CareerPacketJson;
  content_hash: string;
  lightcast_mapped: boolean;
  file_path: string;
}

export interface CompileOptions {
  lightcastMode?: 'llm' | 'skip';
}

// ── Compiler ──────────────────────────────────────────────────────────────────

/**
 * Compile the canonical career-packet.json from local data sources.
 *
 * Reads:
 *   - parseCV() → structured CV data (experiences, projects, skills, education)
 *   - loadProjectFiles() → profile.yml (identity, target_roles, narrative, compensation)
 *   - getActiveCareerPacket() → the markdown packet (for version reference)
 *   - story_bank table → evidence-based capabilities (STAR+R stories)
 *
 * Writes:
 *   - New active row in career_packet_json table (versioned)
 *   - JSON file to <projectRoot>/output/career-packet.json
 *
 * Returns: CompiledPacket with id, version, content, content_hash, file_path.
 */
export async function compileCareerPacketJson(opts: CompileOptions = {}): Promise<CompiledPacket> {
  const lightcastMode = opts.lightcastMode ?? 'llm';

  // ── Gather source data ──────────────────────────────────────────────────────
  const cv = parseCV();
  const { profile, cvMd } = loadProjectFiles();
  const activePacket = getActiveCareerPacket();

  // Compute source_cv_hash from cv.md (for change detection)
  const source_cv_hash = cvMd ? sha256(cvMd) : null;

  // ── Build the packet ────────────────────────────────────────────────────────
  const packet: CareerPacketJson = {
    schema: 'jobops-federation-1.0',
    meta: {
      version: 1, // will be updated after DB insert
      generated_at: new Date().toISOString(),
      source_cv_hash,
      source_packet_version: activePacket?.version ?? null,
      lightcast_mapped: false, // updated below
    },
    basics: buildBasics(cv, profile),
    target_roles: buildTargetRoles(profile),
    taglines: buildTaglines(profile),
    work: await buildWork(cv, lightcastMode),
    projects: buildProjects(cv),
    education: buildEducation(cv),
    skills: await buildSkills(cv, lightcastMode),
    evidence: await buildEvidence(),
    compensation: buildCompensation(profile),
    narrative: buildNarrative(profile),
  };

  // ── Lightcast mapping ───────────────────────────────────────────────────────
  if (lightcastMode === 'llm') {
    const allSkills = packet.skills.flatMap(s => s.items.map(i => i.name));
    const uniqueSkills = [...new Set(allSkills)];
    if (uniqueSkills.length > 0) {
      const mappings = await mapSkillsToLightcast(uniqueSkills);
      // Apply mappings to the packet
      for (const skillCat of packet.skills) {
        for (const item of skillCat.items) {
          const mapping = mappings.find(m => m.name === item.name);
          if (mapping) {
            item.lightcast_id = mapping.lightcast_id;
            item.confidence = mapping.confidence;
          }
        }
      }
      packet.meta.lightcast_mapped = true;
    }
  }

  // ── Persist to DB ───────────────────────────────────────────────────────────
  // Version MUST be set BEFORE computing the content hash, so the hash matches
  // the stored content. embedPacket() and compileSignalSnapshot() both compute
  // their own hash of the content object — if the version in the DB differs from
  // the version used to compute the hash, embedding lookups will always miss.
  const id = randomUUID();
  const result = await runInWriteLock(() => {
    const db = getDb();
    const lastV = (db.prepare(`SELECT COALESCE(MAX(version), 0) AS v FROM career_packet_json`).get() as any)?.v ?? 0;
    const newV = lastV + 1;
    packet.meta.version = newV;

    // Hash the FINAL content (with the correct version baked in)
    const finalContentStr = JSON.stringify(packet, null, 2);
    const content_hash = sha256(finalContentStr);

    db.prepare(`UPDATE career_packet_json SET is_active = 0 WHERE is_active = 1`).run();
    db.prepare(`
      INSERT INTO career_packet_json (id, version, content, content_hash, source_cv_hash, lightcast_mapped, is_active, notes)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?)
    `).run(
      id,
      newV,
      finalContentStr,
      content_hash,
      source_cv_hash,
      packet.meta.lightcast_mapped ? 1 : 0,
      `compiled from cv.md + profile.yml + story_bank (lightcast: ${lightcastMode})`,
    );
    return { version: newV, content_hash };
  });

  // ── Write JSON file ─────────────────────────────────────────────────────────
  const outputDir = resolve(config.projectRoot, 'output');
  mkdirSync(outputDir, { recursive: true });
  const file_path = resolve(outputDir, 'career-packet.json');
  writeFileSync(file_path, JSON.stringify(packet, null, 2), 'utf-8');

  return {
    id,
    version: result.version,
    content: packet,
    content_hash: result.content_hash,
    lightcast_mapped: packet.meta.lightcast_mapped,
    file_path,
  };
}

// ── Builders ──────────────────────────────────────────────────────────────────

function buildBasics(cv: CVData, profile: any): CareerPacketJson['basics'] {
  const loc = profile?.location ?? {};
  return {
    name: cv.name || profile?.candidate?.full_name || 'Candidate',
    email: cv.email || profile?.candidate?.email || '',
    phone: cv.phone || profile?.candidate?.phone || '',
    location: {
      city: loc.city || cv.location || '',
      country: loc.country || '',
      timezone: loc.timezone || '',
    },
    linkedin: cv.linkedin_url || profile?.candidate?.linkedin || '',
    github: cv.portfolio_url || profile?.candidate?.github || '',
    portfolio: profile?.candidate?.portfolio_url || '',
    summary: cv.summary || '',
    headline: (profile?.narrative as any)?.headline || '',
  };
}

function buildTargetRoles(profile: any): CareerPacketJson['target_roles'] {
  const tr = profile?.target_roles ?? {};
  return {
    primary: Array.isArray(tr.primary) ? tr.primary : [],
    archetypes: Array.isArray(tr.archetypes)
      ? tr.archetypes.map((a: any) => ({
          name: a.name || '',
          level: a.level || '',
          fit: a.fit || '',
        }))
      : [],
  };
}

function buildTaglines(profile: any): Record<string, string> {
  const tl = profile?.taglines;
  if (!tl || typeof tl !== 'object' || Array.isArray(tl)) return {};
  return { ...tl };
}

async function buildWork(
  cv: CVData,
  _lightcastMode: string,
): Promise<CareerPacketJson['work']> {
  // For each experience, find related stories from story_bank
  const stories = await getStoriesForExperiences(cv.experiences);

  return cv.experiences.map((exp) => ({
    company: exp.company,
    position: exp.role,
    period: exp.period,
    location: exp.location,
    bullets: exp.bullets,
    evidence: stories[exp.company] || [],
  }));
}

function buildProjects(cv: CVData): CareerPacketJson['projects'] {
  return cv.projects.map((p) => ({
    title: p.title,
    description: p.description,
    tech: p.tech,
  }));
}

function buildEducation(cv: CVData): CareerPacketJson['education'] {
  return cv.education.map((e) => ({
    title: e.title,
    org: e.org,
    year: e.year,
  }));
}

async function buildSkills(
  cv: CVData,
  _lightcastMode: string,
): Promise<CareerPacketJson['skills']> {
  // Skills are mapped to Lightcast IDs in the main compiler function
  return cv.skills.map((cat) => ({
    category: cat.category,
    items: cat.items.split(',').map((s) => ({
      name: s.trim(),
      lightcast_id: null, // filled in by lightcast mapping
      confidence: 0, // filled in by lightcast mapping
    })),
  }));
}

async function buildEvidence(): Promise<CareerPacketJson['evidence']> {
  const rows = getDb()
    .prepare(`
      SELECT s.id, s.story_text, s.reflection, s.competency_tags, s.job_id,
             COALESCE(c.name, j.company_name_raw) AS company_name
      FROM story_bank s
      LEFT JOIN jobs j ON j.id = s.job_id
      LEFT JOIN companies c ON c.id = j.company_id
      ORDER BY datetime(s.created_at) DESC
    `)
    .all() as any[];

  return rows.map((r) => ({
    id: r.id,
    story_text: r.story_text,
    reflection: r.reflection,
    competency_tags: r.competency_tags ? JSON.parse(r.competency_tags) : [],
    source_job_id: r.job_id,
    source_company: r.company_name,
  }));
}

function buildCompensation(profile: any): CareerPacketJson['compensation'] {
  const comp = profile?.compensation ?? {};
  return {
    target_range: comp.target_range || '',
    currency: comp.currency || 'USD',
    minimum: comp.minimum || '',
    location_flexibility: comp.location_flexibility || '',
  };
}

function buildNarrative(profile: any): CareerPacketJson['narrative'] {
  const narr = profile?.narrative ?? {};
  return {
    superpowers: Array.isArray(narr.superpowers) ? narr.superpowers : [],
    likes: Array.isArray(narr.likes) ? narr.likes : [],
    dislikes: Array.isArray(narr.dislikes) ? narr.dislikes : [],
    proof_points: Array.isArray(narr.proof_points)
      ? narr.proof_points.map((p: any) => ({
          name: p.name || '',
          url: p.url || '',
          hero_metric: p.hero_metric || '',
        }))
      : [],
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Match story_bank entries to work experiences by company name.
 * Returns a map: company (original case) → Array<{ story_id, competency_tags }>.
 */
async function getStoriesForExperiences(
  experiences: ExperienceItem[],
): Promise<Record<string, Array<{ story_id: string; competency_tags: string[] }>>> {
  const result: Record<string, Array<{ story_id: string; competency_tags: string[] }>> = {};
  // Build a map of lowercase → original case for lookup
  const companyMap = new Map(experiences.map((e) => [e.company.toLowerCase(), e.company]));

  const rows = getDb()
    .prepare(`
      SELECT s.id, s.competency_tags, COALESCE(c.name, j.company_name_raw) AS company_name
      FROM story_bank s
      LEFT JOIN jobs j ON j.id = s.job_id
      LEFT JOIN companies c ON c.id = j.company_id
      WHERE c.name IS NOT NULL OR j.company_name_raw IS NOT NULL
    `)
    .all() as any[];

  for (const row of rows) {
    const companyName = (row.company_name || '').toLowerCase();
    // Find matching experience company (case-insensitive)
    const matchLower = [...companyMap.keys()].find((c) => companyName.includes(c) || c.includes(companyName));
    if (matchLower) {
      const originalCase = companyMap.get(matchLower)!;
      if (!result[originalCase]) result[originalCase] = [];
      result[originalCase].push({
        story_id: row.id,
        competency_tags: row.competency_tags ? JSON.parse(row.competency_tags) : [],
      });
    }
  }

  return result;
}

function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf-8').digest('hex');
}
