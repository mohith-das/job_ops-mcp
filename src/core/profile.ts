// Loads cv.md + config/profile.yml + portals.yml from the configured project root,
// and rebuilds the active career_packet from those files.
//
// The packet content is built from THREE inputs:
//   1. modes/career_packet.md — the structural template (sections, hard rules)
//   2. config/profile.yml      — identity → Section 1
//   3. cv.md                   — parsed via parseCV() → Sections 3-8 (work, projects,
//                                 skills, education) so the chat sees real bullets,
//                                 not <TODO> placeholders.
//
// The hard rule from the brief stays intact: NOTHING in the packet is invented; every
// bullet, project, skill, and degree comes verbatim from cv.md.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import yaml from 'js-yaml';

import { config } from '../config.js';
import { getDb, runInWriteLock } from '../db.js';
import { resolveModePath } from './modes.js';
import { parseCV, type CVData, type ExperienceItem, type ProjectItem, type EducationItem, type SkillCategory } from './cv_parse.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface Profile {
  candidate: {
    full_name?:    string;
    email?:        string;
    phone?:        string;
    location?:     string;
    linkedin?:     string;
    portfolio_url?:string;
    github?:       string;
    twitter?:      string;
  };
  target_roles?: unknown;
  narrative?:    unknown;
  compensation?: unknown;
  location?:     unknown;
  /**
   * Optional map of target archetype → one-line tagline. When present, `reseed`
   * auto-populates Section 2 (tagline alternatives) of the career packet from
   * these instead of leaving the <…> placeholders that must be re-stamped by
   * hand each reseed. Accepted shapes (both normalize to the same thing):
   *   taglines:
   *     "Builder PM": "ships product with engineering teeth"
   *     "Applied AI Engineer": "..."
   * or a list:
   *   taglines:
   *     - { archetype: "Builder PM", tagline: "..." }
   * Absent → Section 2 is left exactly as the template ships (back-compat).
   */
  taglines?:     Record<string, string> | Array<{ archetype?: string; name?: string; tagline?: string }>;
  cv?:           { output_format?: 'html' | 'latex' };
  language?:     { modes_dir?: string };
}

export interface ProjectFiles {
  cvMd:        string | null;
  profile:     Profile | null;
  portalsYml:  string | null;
}

// ── Loaders ──────────────────────────────────────────────────────────────────

export function pathInProject(...parts: string[]): string {
  return resolve(config.projectRoot, ...parts);
}

export function readIfExists(p: string): string | null {
  return existsSync(p) ? readFileSync(p, 'utf-8') : null;
}

export function loadProjectFiles(): ProjectFiles {
  const cvMd       = readIfExists(pathInProject('cv.md'));
  const profileRaw = readIfExists(pathInProject('config', 'profile.yml'));
  const portalsYml = readIfExists(pathInProject('portals.yml'));

  let profile: Profile | null = null;
  if (profileRaw) {
    const parsed = yaml.load(profileRaw);
    if (parsed && typeof parsed === 'object') {
      profile = parsed as Profile;
    }
  }
  return { cvMd, profile, portalsYml };
}

// ── Structured profile update (feeds the elicitation flow) ────────────────────

export interface ProfileUpdate {
  candidate?: Partial<NonNullable<Profile['candidate']>>;
  /** Archetype → tagline map; merged into the existing taglines. */
  taglines?:  Record<string, string>;
}

/**
 * Merge structured updates into config/profile.yml and write it back. Used by the
 * `update_profile` tool (elicitation form mode) so a user can set identity fields +
 * taglines through their MCP client instead of hand-editing YAML.
 *
 * NB: this rewrites the YAML from the parsed object, so hand-written comments in
 * profile.yml are not preserved — the data is. Empty-string values are ignored (so a
 * blank form field never wipes an existing value). Returns the path + counts so the
 * caller can report and decide whether to reseed.
 */
export function applyProfileUpdate(update: ProfileUpdate): {
  path: string; candidate_fields_set: number; taglines_set: number;
} {
  const path = pathInProject('config', 'profile.yml');
  const raw  = readIfExists(path);
  const base: any = raw ? (yaml.load(raw) ?? {}) : {};

  let candidateFieldsSet = 0;
  if (update.candidate) {
    base.candidate = base.candidate ?? {};
    for (const [k, v] of Object.entries(update.candidate)) {
      if (typeof v === 'string' && v.trim()) { base.candidate[k] = v.trim(); candidateFieldsSet++; }
    }
  }

  let taglinesSet = 0;
  if (update.taglines && Object.keys(update.taglines).length) {
    base.taglines = (base.taglines && typeof base.taglines === 'object' && !Array.isArray(base.taglines))
      ? base.taglines : {};
    for (const [archetype, tagline] of Object.entries(update.taglines)) {
      const a = archetype.trim(); const t = (tagline ?? '').trim();
      if (a && t) { base.taglines[a] = t; taglinesSet++; }
    }
  }

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, yaml.dump(base, { lineWidth: 100, noRefs: true }), 'utf-8');
  return { path, candidate_fields_set: candidateFieldsSet, taglines_set: taglinesSet };
}

// ── Staleness detection ──────────────────────────────────────────────────────

const TODO_MARKER = /<TODO[\s>]/g;
const MIN_REAL_CV_BYTES = 500;     // anything smaller is probably still the example

/** True when the packet body still has 3+ literal `<TODO ...>` markers (template-y). */
export function isPlaceholderPacket(content: string | null | undefined): boolean {
  if (!content) return true;
  return (content.match(TODO_MARKER) || []).length >= 3;
}

/** True when cv.md exists with non-trivial, non-example content. */
export function cvHasRealContent(cvMd: string | null | undefined): boolean {
  if (!cvMd) return false;
  if (cvMd.length < MIN_REAL_CV_BYTES) return false;
  // The example template has every bullet starting with `<...>` (placeholder).
  // A real CV has at least a few bullets that don't start with an angle bracket.
  const realBullets = (cvMd.match(/^[ \t]*-[ \t]+[^<\n]/gm) || []).length;
  return realBullets >= 3;
}

export type PacketStatus =
  | 'ok'                        // packet matches the current cv.md
  | 'no_packet'                 // DB has no active row
  | 'packet_chat_edited'        // active packet was edited via chat — intentionally ahead of cv.md
  | 'no_cv'                     // cv.md missing
  | 'cv_is_example'             // cv.md present but still the <…> example template
  | 'cv_edited_since_seed'      // cv.md hash differs from packet.source_cv_hash → reseed needed
  | 'packet_is_template';       // packet still has TODO markers in its body

export function packetStatus(args: {
  active: { content: string; source_cv_hash: string | null; origin?: PacketOrigin } | null;
  cvMd:   string | null;
}): PacketStatus {
  if (!args.active) return 'no_packet';
  // Chat-edited packets are intentionally ahead of cv.md — that's the chat-driven workflow,
  // NOT a staleness problem. This dominates the cv.md-hash check so doctor stops nagging.
  if (args.active.origin === 'chat_edit' || args.active.origin === 'github_sync') return 'packet_chat_edited';
  if (!args.cvMd)   return 'no_cv';
  if (!cvHasRealContent(args.cvMd)) return 'cv_is_example';
  // cv has real content — now check it matches what we built the packet from.
  if (args.active.source_cv_hash && sha256(args.cvMd) !== args.active.source_cv_hash) {
    return 'cv_edited_since_seed';
  }
  if (isPlaceholderPacket(args.active.content)) return 'packet_is_template';
  return 'ok';
}

// ── Active-packet accessor ──────────────────────────────────────────────────

export type PacketOrigin = 'seed' | 'reseed' | 'chat_edit' | 'github_sync';

export function getActiveCareerPacket(): {
  id: string; version: number; content: string; source_cv_hash: string | null; origin: PacketOrigin;
} | null {
  const row = getDb()
    .prepare(`SELECT id, version, content, source_cv_hash, origin FROM career_packet WHERE is_active = 1`)
    .get() as any;
  if (!row) return null;
  // Defensive: a DB that predates migration 004 (shouldn't happen — migrations run on open)
  // or a NULL would leave origin undefined; treat unknown as 'reseed'.
  row.origin = (row.origin as PacketOrigin) ?? 'reseed';
  return row;
}

// ── Seed / reseed ────────────────────────────────────────────────────────────

export interface SeedResult {
  version:        number;
  created:        boolean;            // true = wrote a new row, false = no change
  reused:         boolean;            // true when ensureActive saw existing row + force=false
  /**
   * true when reseed was REFUSED because the active packet is chat-edited and force was not
   * set. The active packet is left untouched; nothing was written. The caller should surface
   * `blocked_reason` and tell the user to pass force / sync-back first.
   */
  blocked:        boolean;
  blocked_reason: string | null;
  bytes:          number;
  sections_with_cv_content: number;  // 0..6 — how many of S3-S8 got real cv.md content
  preview:        string;             // first ~400 chars for confirmation
}

/**
 * Rebuild the active career packet from cv.md + profile.yml using the template at
 * modes/career_packet.md. Always writes a NEW row (bumps version, demotes previous)
 * unless `mode: 'ensure_active'` and an active row already exists.
 *
 *   mode='reseed'        — writes a new version. The default. SAFE by default: if the active
 *                          packet was chat-edited (origin='chat_edit'), reseed is REFUSED
 *                          (returns blocked) unless `force: true` — so cv.md→packet never
 *                          silently destroys chat edits.
 *   mode='ensure_active' — only seeds if no active row exists (used by first-run boot).
 */
export async function seedCareerPacketFromFiles(
  opts: { mode?: 'reseed' | 'ensure_active'; force?: boolean } = {},
): Promise<SeedResult> {
  const mode = opts.mode ?? 'reseed';
  const db = getDb();

  if (mode === 'ensure_active') {
    const existing = db.prepare(`SELECT version, content FROM career_packet WHERE is_active = 1`).get() as
      { version: number; content: string } | undefined;
    if (existing) {
      return {
        version: existing.version, created: false, reused: true, blocked: false, blocked_reason: null,
        bytes: existing.content.length, sections_with_cv_content: countSectionsWithCvContent(existing.content),
        preview: existing.content.slice(0, 400),
      };
    }
  }

  // Non-destructive guard: never overwrite chat edits without an explicit force.
  if (mode === 'reseed' && !opts.force) {
    const active = getActiveCareerPacket();
    if (active?.origin === 'chat_edit' || active?.origin === 'github_sync') {
      return {
        version: active.version, created: false, reused: false,
        blocked: true,
        blocked_reason:
          `Active career_packet v${active.version} has chat edits (made via update_career_packet) ` +
          `that are NOT in cv.md. Reseeding from cv.md would overwrite them. Re-run with force ` +
          `to rebuild from cv.md anyway, or run sync_packet_to_cv first to write your edits back ` +
          `into cv.md so a reseed reproduces them.`,
        bytes: active.content.length,
        sections_with_cv_content: countSectionsWithCvContent(active.content),
        preview: active.content.slice(0, 400),
      };
    }
  }

  const { content, sectionsWithContent, cvHash } = buildPacketContent();
  const id = randomUUID();
  const origin: PacketOrigin = mode === 'ensure_active' ? 'seed' : 'reseed';

  const result = await runInWriteLock(() => {
    const lastV = (db.prepare(`SELECT COALESCE(MAX(version), 0) AS v FROM career_packet`).get() as any).v as number;
    const newV = lastV + 1;
    db.prepare(`UPDATE career_packet SET is_active = 0 WHERE is_active = 1`).run();
    db.prepare(`
      INSERT INTO career_packet (id, version, content, taglines, is_active, source_cv_hash, notes, origin)
      VALUES (?, ?, ?, NULL, 1, ?, ?, ?)
    `).run(id, newV, content, cvHash,
            origin === 'seed' ? 'seeded on first run' : 'reseeded from cv.md + profile.yml', origin);
    return { version: newV };
  });

  return {
    version: result.version, created: true, reused: false, blocked: false, blocked_reason: null,
    bytes: content.length, sections_with_cv_content: sectionsWithContent,
    preview: content.slice(0, 400),
  };
}

/** Back-compat thin wrapper around seedCareerPacketFromFiles for boot-time callers. */
export async function ensureActiveCareerPacket(): Promise<{ version: number; created: boolean }> {
  const r = await seedCareerPacketFromFiles({ mode: 'ensure_active' });
  return { version: r.version, created: r.created };
}

// ── Chat edit (packet is the edit surface) ────────────────────────────────────

/**
 * Write a chat-edited packet as a NEW active version, marking origin='chat_edit' so a
 * later reseed won't silently overwrite it. `source_cv_hash` is NULL — a chat edit is not
 * derived from cv.md. History is retained (the previous active row is demoted, not deleted).
 */
export async function writeChatEditedPacket(
  content: string, notes?: string | null,
): Promise<{ id: string; version: number; bytes: number }> {
  const db = getDb();
  const id = randomUUID();
  const result = await runInWriteLock(() => {
    const lastV = (db.prepare(`SELECT COALESCE(MAX(version), 0) AS v FROM career_packet`).get() as any).v as number;
    const newV = lastV + 1;
    db.prepare(`UPDATE career_packet SET is_active = 0 WHERE is_active = 1`).run();
    db.prepare(`
      INSERT INTO career_packet (id, version, content, taglines, is_active, source_cv_hash, notes, origin)
      VALUES (?, ?, ?, NULL, 1, NULL, ?, 'chat_edit')
    `).run(id, newV, content, notes ?? 'chat edit via update_career_packet');
    return { version: newV };
  });
  return { id, version: result.version, bytes: content.length };
}

/**
 * Atomically merge an approved GitHub change into the latest active packet.
 *
 * The callback runs while the DB write lock is held and receives the active
 * packet content at that exact point in time. This prevents two approvals
 * created from the same scan from replacing one another with stale full-packet
 * snapshots.
 */
export async function writeGitHubMergedPacket(
  merge: (latestContent: string) => string,
  notes: string,
): Promise<{ id: string; version: number; bytes: number }> {
  const db = getDb();
  const id = randomUUID();
  const replacePacket = db.transaction(() => {
    const active = db.prepare(
      `SELECT content FROM career_packet WHERE is_active = 1 ORDER BY version DESC LIMIT 1`,
    ).get() as { content: string } | undefined;
    if (!active) throw new Error('No active career packet.');

    const content = merge(active.content);
    const lastV = (db.prepare(`SELECT COALESCE(MAX(version), 0) AS v FROM career_packet`).get() as any).v as number;
    const newV = lastV + 1;
    db.prepare(`UPDATE career_packet SET is_active = 0 WHERE is_active = 1`).run();
    db.prepare(`
      INSERT INTO career_packet (id, version, content, taglines, is_active, source_cv_hash, notes, origin)
      VALUES (?, ?, ?, NULL, 1, NULL, ?, 'github_sync')
    `).run(id, newV, content, notes);
    return { version: newV, bytes: content.length };
  });
  const result = await runInWriteLock(() => replacePacket());
  return { id, version: result.version, bytes: result.bytes };
}

// ── Sync-back (packet → source files) ─────────────────────────────────────────

export interface SyncBackResult {
  cv_path:      string;
  profile_path: string;
  cv_bytes:     number;
  roles:        number;
  projects:     number;
  skills:       number;
  education:    number;
  taglines:     number;
  identity_fields: number;
}

/**
 * Write the active packet's content back into the source files (`cv.md` + `config/profile.yml`)
 * so a subsequent reseed reproduces it. The inverse of reseed — explicit and non-destructive
 * to the packet (it only writes the source files; the active chat-edited packet stays active).
 *
 *   Sections 3–8 (experience / projects / skills / education) → cv.md (parseCV grammar)
 *   Section 2 (taglines)                                       → profile.yml `taglines:` (replaced)
 *   Section 1 (identity)                                       → profile.yml `candidate:` (merged)
 *
 * After this, `reseed_career_packet` (which is still blocked by the chat_edit guard) can be
 * run with force to rebuild a reseed-origin packet from the now-synced cv.md.
 */
export function syncPacketToSourceFiles(): SyncBackResult {
  const active = getActiveCareerPacket();
  if (!active) throw new Error('No active career_packet to sync.');
  const sections = splitNumberedSections(active.content);

  // ── Build cv.md from Sections 3–8 ──
  const { profile } = loadProjectFiles();
  const { markdown: cvMarkdown, roles, projects, skills, education } =
    cvMarkdownFromPacket(active.content, profile);
  const cvPath = pathInProject('cv.md');
  mkdirSync(dirname(cvPath), { recursive: true });
  writeFileSync(cvPath, cvMarkdown, 'utf-8');

  // ── Write Section 1 identity (merge) + Section 2 taglines (replace) → profile.yml ──
  const profilePath = pathInProject('config', 'profile.yml');
  const raw = readIfExists(profilePath);
  const base: any = raw ? (yaml.load(raw) ?? {}) : {};

  const identity = parseIdentity(sections.get('1.') ?? '');
  let identityFields = 0;
  if (Object.keys(identity).length) {
    base.candidate = base.candidate ?? {};
    for (const [k, v] of Object.entries(identity)) {
      if (v && v.trim()) { base.candidate[k] = v.trim(); identityFields++; }
    }
  }

  const taglineMap = parseTaglines(sections.get('2.') ?? '');
  const taglineCount = Object.keys(taglineMap).length;
  if (taglineCount) base.taglines = taglineMap;   // REPLACE so removed taglines don't resurrect on reseed

  mkdirSync(dirname(profilePath), { recursive: true });
  writeFileSync(profilePath, yaml.dump(base, { lineWidth: 100, noRefs: true }), 'utf-8');

  return {
    cv_path: cvPath, profile_path: profilePath, cv_bytes: cvMarkdown.length,
    roles, projects, skills, education, taglines: taglineCount, identity_fields: identityFields,
  };
}

export interface PacketCvMarkdown {
  markdown:  string;
  roles:     number;
  projects:  number;
  skills:    number;
  education: number;
}

/**
 * Render a packet's Sections 3–8 as cv.md-grammar markdown (parseCV-compatible).
 * Shared by syncPacketToSourceFiles (which writes it to cv.md) and the render
 * pipeline (which parses it in memory so a chat-edited packet reaches renders
 * without requiring an explicit sync-back first).
 */
export function cvMarkdownFromPacket(packetContent: string, profile: Profile | null): PacketCvMarkdown {
  const sections = splitNumberedSections(packetContent);
  const name = (profile?.candidate?.full_name) || parseIdentity(sections.get('1.') ?? '').full_name || 'Candidate';
  const headline = (profile?.narrative as any)?.headline as string | undefined;

  const roleBlocks = ['3.', '4.', '5.'].flatMap(s => parseRoleBlocks(sections.get(s) ?? ''));
  const projectLines = bulletLines(sections.get('6.') ?? '');
  const skillLines   = bulletLines(sections.get('7.') ?? '');
  // Education is re-emitted in cv.md grammar (`- **Title**, Org — Desc (Year)`) so parseCV
  // captures the institution as `org`; the packet's render form (`— Org (Year). Desc`) would
  // otherwise parse the org into an empty string.
  const eduLines     = bulletLines(sections.get('8.') ?? '').map(packetEduToCvLine);

  const parts: string[] = [`# CV — ${name}`];
  if (profile?.candidate?.location) parts.push(`**Location:** ${profile.candidate.location}`);
  if (profile?.candidate?.email)    parts.push(`**Email:** ${profile.candidate.email}`);
  if (headline) parts.push(`\n## Professional Summary\n${headline}`);

  if (roleBlocks.length) {
    parts.push('\n## Work Experience\n');
    for (const r of roleBlocks) {
      parts.push(`### ${r.company} — ${r.role}`);
      if (r.meta) parts.push(r.meta);
      parts.push(...r.bullets.map(b => `- ${b}`));
      parts.push('');
    }
  }
  if (projectLines.length) parts.push('## Projects & Open Source\n\n' + projectLines.join('\n') + '\n');
  if (eduLines.length)     parts.push('## Education\n\n' + eduLines.join('\n') + '\n');
  if (skillLines.length)   parts.push('## Skills\n\n' + skillLines.join('\n') + '\n');

  const markdown = parts.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
  return {
    markdown,
    roles: roleBlocks.length, projects: projectLines.length,
    skills: skillLines.length, education: eduLines.length,
  };
}

interface PacketRole { company: string; role: string; meta: string; bullets: string[]; }

/** Parse renderRoleSection output (`**Company** — Role  \n_meta_\n\n- bullets`) back to items. */
function parseRoleBlocks(body: string): PacketRole[] {
  const lines = body.split('\n');
  const roles: PacketRole[] = [];
  let cur: PacketRole | null = null;
  for (let i = 0; i < lines.length; i++) {
    const h = lines[i].match(/^\*\*(.+?)\*\*\s*[—–\-|]\s*(.+?)\s*$/);
    if (h) {
      if (cur) roles.push(cur);
      const next = lines.slice(i + 1).find(l => l.trim() !== '') ?? '';
      const mm = next.trim().match(/^_(.+)_$/);
      cur = { company: h[1].trim(), role: h[2].trim(), meta: mm ? mm[1].trim() : '', bullets: [] };
      continue;
    }
    if (cur && /^\s*-\s+/.test(lines[i])) cur.bullets.push(lines[i].replace(/^\s*-\s+/, '').trim());
  }
  if (cur) roles.push(cur);
  return roles;
}

/** Keep only top-level markdown bullet lines (`- ...`), dropping indented continuations. */
function bulletLines(body: string): string[] {
  return body.split('\n').filter(l => /^- \S/.test(l)).map(l => l.replace(/\s+$/, ''));
}

/**
 * Convert a packet education bullet (renderEducationBank form `- **Title** — Org (Year). Desc`)
 * into cv.md grammar (`- **Title**, Org — Desc (Year)`) so parseCV's parseEducation captures
 * Org/Year/Desc faithfully and a reseed reproduces the same rendered line. Lines that don't
 * look like an education bullet pass through unchanged.
 */
function packetEduToCvLine(line: string): string {
  const m = line.match(/^-\s+\*\*(.+?)\*\*\s*(.*)$/);
  if (!m) return line;
  const title = m[1].trim();
  let rest = m[2].trim();
  let org = '', year = '', desc = '';
  const dash = rest.match(/^[—–-]\s*(.*)$/);   // leading "— Org…" (org present)
  if (dash) rest = dash[1].trim();
  const ym = rest.match(/\((\d{4}(?:[-–]\d{4})?)\)/);
  if (ym) { year = ym[1]; rest = (rest.slice(0, ym.index) + rest.slice(ym.index! + ym[0].length)).trim(); }
  const pm = rest.match(/^(.*?)\.\s+(.+)$/);   // "Org. Desc"
  if (pm) { org = pm[1].trim(); desc = pm[2].trim(); }
  else org = rest.replace(/[.\s]+$/, '').trim();
  let out = `- **${title}**`;
  if (org)  out += `, ${org}`;
  if (desc) out += ` — ${desc}`;
  if (year) out += ` (${year})`;
  return out;
}

/** Parse a rendered Section 1 identity block (`- **Name:** X`) into candidate fields. */
function parseIdentity(body: string): Record<string, string> {
  const LABELS: Record<string, string> = {
    name: 'full_name', email: 'email', phone: 'phone', location: 'location',
    linkedin: 'linkedin', portfolio: 'portfolio_url', github: 'github', twitter: 'twitter',
  };
  const out: Record<string, string> = {};
  for (const line of body.split('\n')) {
    const m = line.match(/^-\s+\*\*([^:*]+):\*\*\s*(.+?)\s*$/);
    if (!m) continue;
    const key = LABELS[m[1].trim().toLowerCase()];
    if (key && !(key in out)) out[key] = m[2].trim();   // first occurrence wins (resume-header name)
  }
  return out;
}

/** Parse a rendered Section 2 taglines block (`- **Archetype** — "tagline"`) into a map. */
function parseTaglines(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of body.split('\n')) {
    const m = line.match(/^-\s+\*\*(.+?)\*\*\s*[—–-]\s*"?(.+?)"?\s*$/);
    if (m) out[m[1].trim()] = m[2].trim();
  }
  return out;
}

// ── Packet building ─────────────────────────────────────────────────────────

interface BuildResult {
  content: string;
  sectionsWithContent: number;
  cvHash: string | null;
}

function buildPacketContent(): BuildResult {
  const { cvMd, profile } = loadProjectFiles();
  // Prefer the user-edited modes/career_packet.md (project root) over the bundled default.
  const templatePath = resolveModePath('career_packet.md').path;
  let content = readIfExists(templatePath) ?? '# Career Packet (empty template)';

  // Always inject identity from profile.yml into Section 1.
  content = replaceSectionBody(content, '1.', renderIdentityBlock(profile));

  // Section 2 — tagline alternatives. If profile.yml declares per-archetype
  // taglines, auto-fill them so the user doesn't have to re-stamp Section 2 by
  // hand on every reseed. When the field is absent we leave Section 2 exactly as
  // the template ships (back-compat).
  const taglines = normalizeTaglines(profile?.taglines);
  if (taglines.length) {
    content = replaceSectionBody(content, '2.', renderTaglines(taglines));
  }

  let sectionsWithContent = 0;
  if (cvMd) {
    const cv = parseCV();   // parseCV reads cv.md via loadProjectFiles() internally

    // Sections 3, 4, 5 — experience bullet banks. The template ships three: most recent,
    // previous, earlier. If cv.md has more roles, fold the extras into Section 5.
    const exp = cv.experiences;
    if (exp[0]) {
      content = replaceSectionBody(content, '3.', renderRoleSection(exp[0])); sectionsWithContent++;
    }
    if (exp[1]) {
      content = replaceSectionBody(content, '4.', renderRoleSection(exp[1])); sectionsWithContent++;
    }
    if (exp.slice(2).length) {
      content = replaceSectionBody(content, '5.', exp.slice(2).map(renderRoleSection).join('\n\n')); sectionsWithContent++;
    }

    // Section 6 — projects bank.
    if (cv.projects.length) {
      content = replaceSectionBody(content, '6.', renderProjectsBank(cv.projects)); sectionsWithContent++;
    }
    // Section 7 — skills bank.
    if (cv.skills.length) {
      content = replaceSectionBody(content, '7.', renderSkillsBank(cv.skills)); sectionsWithContent++;
    }
    // Section 8 — education.
    if (cv.education.length) {
      content = replaceSectionBody(content, '8.', renderEducationBank(cv.education)); sectionsWithContent++;
    }
  }

  return {
    content,
    sectionsWithContent,
    cvHash: cvMd ? sha256(cvMd) : null,
  };
}

function countSectionsWithCvContent(content: string): number {
  // Heuristic: count Sections 3-8 whose body still contains a <TODO marker (meaning NOT
  // populated from cv.md). Real sections = 6 - count(TODO sections).
  const sections = splitNumberedSections(content);
  let withContent = 0;
  for (const n of ['3.', '4.', '5.', '6.', '7.', '8.']) {
    const body = sections.get(n) ?? '';
    if (body && !TODO_MARKER.test(body)) withContent++;
    TODO_MARKER.lastIndex = 0;   // reset global regex
  }
  return withContent;
}

// ── Section parsing + rewriting ─────────────────────────────────────────────

/** Replace the body of `## N. ...` (keep the heading line) with newBody. */
function replaceSectionBody(content: string, prefix: string, newBody: string): string {
  // Match the heading line (## N. ...) and capture everything after it until the next
  // `## ` heading or end-of-document. We anchor the prefix to start-of-line.
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // JavaScript has no `\\z` end-of-string anchor. `(?![\\s\\S])` is an explicit
  // end-of-input assertion that works alongside multiline `^## ` boundaries.
  const re = new RegExp(`(^## ${escaped}[^\\n]*\\n)([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, 'm');
  if (!re.test(content)) return content;        // section not in template — leave content alone
  return content.replace(re, (_match, heading) => `${heading}\n${newBody.trim()}\n\n`);
}

/**
 * Replace ONE numbered section's body in a packet, for ergonomic chat edits ("change my
 * tagline", "remove project X") without re-sending the whole packet. `section` accepts
 * "2", "2.", or "## 2. Foo" forms. Throws if the section heading isn't present (so a typo'd
 * section number fails loudly instead of silently no-op'ing).
 */
export function editPacketSection(packetContent: string, section: string, newBody: string): string {
  const m = section.trim().match(/(\d+)/);
  if (!m) throw new Error(`Invalid section "${section}" — expected a number like "2" or "6".`);
  const prefix = `${m[1]}.`;
  const headingRe = new RegExp(`^## ${prefix.replace('.', '\\.')}[^\\n]*$`, 'm');
  if (!headingRe.test(packetContent)) {
    const have = [...packetContent.matchAll(/^## (\d+)\./gm)].map(x => x[1]).join(', ');
    throw new Error(`Section ${prefix} not found in the packet. Sections present: ${have || '(none)'}.`);
  }
  return replaceSectionBody(packetContent, prefix, newBody);
}

// ── Granular item-level packet edits (one bullet/project/skill/tagline) ────────

const SECTION_ALIASES: Record<string, string> = {
  identity: '1.', taglines: '2.', tagline: '2.',
  projects: '6.', project: '6.', skills: '7.', skill: '7.', education: '8.',
};

/** Resolve a section argument ("6", "projects", "taglines", …) to a `## N.` prefix that exists. */
function resolveSectionPrefix(packetContent: string, section: string): string {
  const s = section.trim().toLowerCase();
  const num = s.match(/^(\d+)\.?$/);
  const prefix = num ? `${num[1]}.` : SECTION_ALIASES[s];
  if (!prefix) {
    throw new Error(`Unknown section "${section}". Use a number (e.g. "6") or one of: taglines, projects, skills, education `
      + `(experience spans sections 3/4/5 — address those by number).`);
  }
  const headingRe = new RegExp(`^## ${prefix.replace('.', '\\.')}[^\\n]*$`, 'm');
  if (!headingRe.test(packetContent)) {
    const have = [...packetContent.matchAll(/^## (\d+)\./gm)].map(x => x[1]).join(', ');
    throw new Error(`Section ${prefix} not found. Sections present: ${have || '(none)'}.`);
  }
  return prefix;
}

const isBullet = (line: string) => /^\s*-\s+/.test(line);
const bulletText = (line: string) => line.replace(/^\s*-\s+/, '').trim();

/** Find the single bullet line index in `bodyLines` matching `item` (1-based index or substring). */
function resolveItemLine(bodyLines: string[], item: string | number): number {
  const bulletIdxs = bodyLines.map((l, i) => (isBullet(l) ? i : -1)).filter(i => i >= 0);
  if (!bulletIdxs.length) throw new Error('That section has no list items to edit.');

  if (typeof item === 'number' || /^\d+$/.test(String(item).trim())) {
    const n = Number(item);
    if (n < 1 || n > bulletIdxs.length) {
      throw new Error(`Item ${n} is out of range — the section has ${bulletIdxs.length} item(s).`);
    }
    return bulletIdxs[n - 1];
  }
  const needle = String(item).trim().toLowerCase();
  const matches = bulletIdxs.filter(i => bodyLines[i].toLowerCase().includes(needle));
  if (matches.length === 0) throw new Error(`No item matching "${item}" in that section.`);
  if (matches.length > 1) {
    const list = matches.map(i => `"${bulletText(bodyLines[i]).slice(0, 60)}"`).join('; ');
    throw new Error(`"${item}" matches ${matches.length} items — be more specific. Matches: ${list}`);
  }
  return matches[0];
}

export interface PacketItemEdit { section: string; item_index_in_section: number; old_item: string; new_item?: string; removed_item?: string; new_version: number; }

/** Replace ONE item (bullet/project/skill/tagline) in a section, in place. Versions the packet. */
export async function editPacketItem(section: string, item: string | number, newText: string): Promise<PacketItemEdit> {
  const active = getActiveCareerPacket();
  if (!active) throw new Error('No active career_packet to edit.');
  const prefix = resolveSectionPrefix(active.content, section);
  const body = splitNumberedSections(active.content).get(prefix) ?? '';
  const lines = body.split('\n');
  const idx = resolveItemLine(lines, item);
  const old_item = bulletText(lines[idx]);
  const indent = (lines[idx].match(/^\s*/) ?? [''])[0];
  lines[idx] = `${indent}- ${newText.trim()}`;
  const newContent = replaceSectionBody(active.content, prefix, lines.join('\n'));
  const r = await writeChatEditedPacket(newContent, `edited item in section ${prefix} (chat)`);
  return { section: prefix, item_index_in_section: lines.slice(0, idx).filter(isBullet).length + 1,
           old_item, new_item: newText.trim(), new_version: r.version };
}

/** Remove ONE item from a section. Versions the packet. Echoes the removed item. */
export async function removePacketItem(section: string, item: string | number): Promise<PacketItemEdit> {
  const active = getActiveCareerPacket();
  if (!active) throw new Error('No active career_packet to edit.');
  const prefix = resolveSectionPrefix(active.content, section);
  const body = splitNumberedSections(active.content).get(prefix) ?? '';
  const lines = body.split('\n');
  const idx = resolveItemLine(lines, item);
  const removed_item = bulletText(lines[idx]);
  const itemNo = lines.slice(0, idx).filter(isBullet).length + 1;
  lines.splice(idx, 1);
  const newContent = replaceSectionBody(active.content, prefix, lines.join('\n'));
  const r = await writeChatEditedPacket(newContent, `removed item from section ${prefix} (chat)`);
  return { section: prefix, item_index_in_section: itemNo, old_item: removed_item, removed_item, new_version: r.version };
}

// ── Packet version history + restore (reversibility) ──────────────────────────

export interface PacketVersionInfo { version: number; origin: PacketOrigin; is_active: boolean; bytes: number; notes: string | null; created_at: string; }

export function listPacketVersions(): PacketVersionInfo[] {
  return (getDb().prepare(`
    SELECT version, origin, is_active, length(content) AS bytes, notes, created_at
    FROM career_packet ORDER BY version DESC
  `).all() as any[]).map(r => ({
    version: r.version, origin: (r.origin ?? 'reseed') as PacketOrigin, is_active: !!r.is_active,
    bytes: r.bytes, notes: r.notes, created_at: r.created_at,
  }));
}

/** Restore a prior packet version by writing its content as a NEW active version (history kept). */
export async function restorePacketVersion(version: number): Promise<{ restored_from: number; new_version: number }> {
  const row = getDb().prepare(`SELECT content FROM career_packet WHERE version = ?`).get(version) as { content: string } | undefined;
  if (!row) throw new Error(`No career_packet version ${version}. Use list (no version) to see available versions.`);
  const r = await writeChatEditedPacket(row.content, `restored from v${version}`);
  return { restored_from: version, new_version: r.version };
}

function splitNumberedSections(content: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /^## (\d+\.)[^\n]*$/gm;
  const matches: { prefix: string; start: number; end: number }[] = [];
  let m;
  while ((m = re.exec(content))) {
    matches.push({ prefix: m[1], start: m.index + m[0].length, end: -1 });
  }
  for (let i = 0; i < matches.length; i++) {
    matches[i].end = i + 1 < matches.length ? matches[i + 1].start - (`## ${matches[i + 1].prefix}`.length + 1) : content.length;
    out.set(matches[i].prefix, content.slice(matches[i].start, matches[i].end).trim());
  }
  return out;
}

// ── Renderers ───────────────────────────────────────────────────────────────

function renderIdentityBlock(profile: Profile | null): string {
  if (!profile?.candidate) return '_No `config/profile.yml` found — populate it to enrich._';
  const c = profile.candidate;
  const lines: string[] = [];
  if (c.full_name)    lines.push(`- **Name:** ${c.full_name}`);
  if (c.email)        lines.push(`- **Email:** ${c.email}`);
  if (c.phone)        lines.push(`- **Phone:** ${c.phone}`);
  if (c.location)     lines.push(`- **Location:** ${c.location}`);
  if (c.linkedin)     lines.push(`- **LinkedIn:** ${c.linkedin}`);
  if (c.portfolio_url)lines.push(`- **Portfolio:** ${c.portfolio_url}`);
  if (c.github)       lines.push(`- **GitHub:** ${c.github}`);
  if (c.twitter)      lines.push(`- **Twitter:** ${c.twitter}`);
  return lines.length ? lines.join('\n') : '_Profile present but no candidate fields filled._';
}

/**
 * Coerce the two accepted `taglines` shapes (map or list) into an ordered list of
 * { archetype, tagline } pairs, dropping anything without both fields. Map insertion
 * order is preserved (js-yaml keeps key order). Returns [] for absent/empty input so
 * callers can fall back to the template's Section 2.
 */
export function normalizeTaglines(
  raw: Profile['taglines'] | undefined | null,
): Array<{ archetype: string; tagline: string }> {
  if (!raw) return [];
  const out: Array<{ archetype: string; tagline: string }> = [];
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;
      const archetype = String(item.archetype ?? item.name ?? '').trim();
      const tagline   = String(item.tagline ?? '').trim();
      if (archetype && tagline) out.push({ archetype, tagline });
    }
  } else if (typeof raw === 'object') {
    for (const [archetype, tagline] of Object.entries(raw)) {
      const a = String(archetype).trim();
      const t = typeof tagline === 'string' ? tagline.trim() : '';
      if (a && t) out.push({ archetype: a, tagline: t });
    }
  }
  return out;
}

function renderTaglines(taglines: Array<{ archetype: string; tagline: string }>): string {
  const intro =
    'The job rater picks ONE based on detected `role_category`. Auto-filled from ' +
    '`config/profile.yml` → `taglines` on the last reseed.';
  const lines = taglines.map(({ archetype, tagline }) => {
    // Strip surrounding quotes the user may have wrapped the tagline in.
    const clean = tagline.replace(/^["']|["']$/g, '');
    return `- **${archetype}** — "${clean}"`;
  });
  return `${intro}\n\n${lines.join('\n')}`;
}

function renderRoleSection(exp: ExperienceItem): string {
  const meta = [exp.location, exp.period].filter(Boolean).join(' · ');
  const head = `**${exp.company}** — ${exp.role}` + (meta ? `  \n_${meta}_` : '');
  const bullets = exp.bullets.length
    ? exp.bullets.map(b => `- ${b}`).join('\n')
    : '- _(no bullets in cv.md for this role)_';
  return `${head}\n\n${bullets}`;
}

function renderProjectsBank(projects: ProjectItem[]): string {
  return projects.map(p => {
    const badge = p.badge ? ` (${p.badge})` : '';
    const tech  = p.tech  ? `  \n  _${p.tech}_` : '';
    return `- **${p.title}**${badge} — ${p.description}${tech}`;
  }).join('\n');
}

function renderSkillsBank(skills: SkillCategory[]): string {
  return skills.map(s => `- **${s.category}:** ${s.items}`).join('\n');
}

function renderEducationBank(edus: EducationItem[]): string {
  return edus.map(e => {
    const year = e.year ? ` (${e.year})` : '';
    const desc = e.desc ? `. ${e.desc}` : '';
    const orgPart = e.org ? ` — ${e.org}` : '';
    return `- **${e.title}**${orgPart}${year}${desc}`;
  }).join('\n');
}

function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf-8').digest('hex');
}

// Used by callers (CLI doctor, MCP tool) — preview = first ~400 chars of the active packet.
export function packetPreview(content: string, max = 400): string {
  const trimmed = content.trim();
  return trimmed.length <= max ? trimmed : trimmed.slice(0, max) + '\n…';
}
