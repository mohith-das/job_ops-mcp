// Map jobops `CareerPacketJson` to LivingCV's `CareerPacketSchema`.
//
// The contract (Canonical Federation Contract v1) defines the field-level
// translation here. Every optional empty is omitted from the wire body
// instead of being sent as `""` — LivingCV's zod schema treats those as
// valid but they pollute the public site. The `__packet__` schema name
// from the embedder is unrelated to LivingCV's schema name (`classic` /
// `minimal-v1`); LivingCV's `packet.schema` field is the site template.

import type { CareerPacketJson } from './career_packet_json.js';

// ── Output types ──────────────────────────────────────────────────────────────

export interface LcvIdentity {
  fullName: string;
  email?: string;
  phone?: string;
  location?: string;
  linkedinUrl?: string;
  githubUrl?: string;
  portfolioUrl?: string;
}

export interface LcvTagline { archetype: string; text: string }

export interface LcvExperienceBullet { text: string }

export interface LcvExperience {
  company: string;
  title: string;
  startDate?: string;
  endDate?: string;
  bullets: LcvExperienceBullet[];
}

export interface LcvProject {
  slug: string;
  name: string;
  tagline?: string;
}

export interface LcvSkill { name: string; category?: string }

export interface LcvEducation {
  institution: string;
  degree: string;
  endDate?: string;
}

export interface LcvPacket {
  schema: 'career-packet-1';
  identity: LcvIdentity;
  taglines?: LcvTagline[];
  experience?: LcvExperience[];
  projects?: LcvProject[];
  skills?: LcvSkill[];
  education?: LcvEducation[];
  summary?: string;
  version: string;
}

// ── Mapping helpers ───────────────────────────────────────────────────────────

/**
 * "May 2020 - Present" / "Jan 2020 – Present" → { startDate: "2020-05", endDate: undefined }
 * "2018 - 2020"                                → { startDate: "2018",   endDate: "2020"   }
 * Anything unparseable                         → {} (both undefined)
 */
export function splitPeriod(period: string): { startDate?: string; endDate?: string } {
  if (!period) return {};
  const s = String(period).trim();
  if (!s) return {};

  // Two ranges: free-text splits, year-only splits, year-month splits, "Present" end.
  // Be tolerant of: – (en dash), - (hyphen), "to", "—". Lowercase + trim for matching.
  const splitter = /\s+[–—\-]\s+|\s+to\s+/i;
  const parts = s.split(splitter);
  if (parts.length < 2) return {};

  const startRaw = parts[0].trim();
  const endRaw = parts[1].trim();

  const startDate = parseDateToken(startRaw);
  let endDate = parseDateToken(endRaw);
  if (!endDate && /present/i.test(endRaw)) {
    // omit endDate so LivingCV treats it as ongoing (its zod schema is
    // `endDate: z.string().optional()` — undefined == open-ended).
    endDate = undefined;
  }
  // Drop the whole entry if neither side parsed — sending {} startDate/endDate
  // would still validate but yields empty strings in the public site.
  if (!startDate && !endDate) return {};
  return { startDate, endDate };
}

const MONTHS: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

function parseDateToken(token: string): string | undefined {
  const t = (token || '').trim();
  if (!t) return undefined;
  // Year only: "2020"
  if (/^\d{4}$/.test(t)) return t;
  // Year + month: "May 2020", "May-2020" → "2020-05"
  const ym = t.match(/^([A-Za-z]+)[\s\-]*(\d{4})$/);
  if (ym) {
    const m = MONTHS[ym[1].toLowerCase().slice(0, 3)];
    if (m) return `${ym[2]}-${m}`;
  }
  // Year + month reversed: "2020 May" → "2020-05"
  const my = t.match(/^(\d{4})[\s\-]*([A-Za-z]+)$/);
  if (my) {
    const m = MONTHS[my[2].toLowerCase().slice(0, 3)];
    if (m) return `${my[1]}-${m}`;
  }
  return undefined;
}

function slugify(s: string): string {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'project';
}

/** Best-effort "city, country" → empty parts dropped, else empty. */
function joinLocation(city: string, country: string): string | undefined {
  const parts = [city, country].map((p) => (p || '').trim()).filter(Boolean);
  if (parts.length === 0) return undefined;
  return parts.join(', ');
}

function omitUndefined<T extends Record<string, any>>(obj: T): Partial<T> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out as Partial<T>;
}

// ── Public mapping ────────────────────────────────────────────────────────────

/**
 * Translate jobops's compiled career packet into LivingCV's wire schema.
 * Optionals are omitted when empty so LivingCV's site doesn't show empty rows.
 */
export function mapCareerPacketToLivingCV(packet: CareerPacketJson): LcvPacket {
  const basics = packet.basics ?? ({} as CareerPacketJson['basics']);

  const identity: LcvIdentity = {
    fullName:     basics.name || '',
    ...omitUndefined({
      email:        basics.email || undefined,
      phone:        basics.phone || undefined,
      location:     joinLocation(basics.location?.city || '', basics.location?.country || ''),
      linkedinUrl:  basics.linkedin || undefined,
      githubUrl:    basics.github || undefined,
      portfolioUrl: basics.portfolio || undefined,
    }),
  };

  const taglines: LcvTagline[] = Object.entries(packet.taglines || {})
    .filter(([, text]) => !!text)
    .map(([archetype, text]) => ({ archetype, text }));

  const experience: LcvExperience[] = (packet.work || []).map((w) => {
    const dates = splitPeriod(w.period || '');
    const bullets = (w.bullets || []).filter((b: string) => !!b).map((text: string) => ({ text }));
    return omitUndefined({
      company:   w.company,
      title:     w.position,
      startDate: dates.startDate,
      endDate:   dates.endDate,
      bullets,
    }) as LcvExperience;
  });

  const projects: LcvProject[] = (packet.projects || []).flatMap((p) => {
    const name = (p.title || '').trim();
    if (!name) return [];  // LivingCV's validator rejects empty names — drop silently.
    return [omitUndefined({
      slug:    slugify(name),
      name,
      tagline: p.description || undefined,
    }) as LcvProject];
  });

  const skills: LcvSkill[] = [];
  for (const cat of (packet.skills || [])) {
    for (const item of (cat.items || [])) {
      if (!item.name) continue;
      skills.push({ name: item.name, category: cat.category || undefined });
    }
  }

  const education: LcvEducation[] = (packet.education || []).map((e) => {
    return omitUndefined({
      institution: e.org,
      degree:      e.title,
      endDate:     e.year || undefined,
    }) as LcvEducation;
  });

  return {
    schema:    'career-packet-1',
    identity,
    version:   String(packet.meta?.version ?? '0'),
    ...(taglines.length ? { taglines } : {}),
    ...(experience.length ? { experience } : {}),
    ...(projects.length ? { projects } : {}),
    ...(skills.length ? { skills } : {}),
    ...(education.length ? { education } : {}),
    ...(basics.summary ? { summary: basics.summary } : {}),
  };
}

/**
 * Local LivingCV-schema validator (a subset mirror of `CareerPacketSchema`
 * in LivingCV/packages/shared/src/career-packet.ts:59). Importing the real
 * zod schema across repos is impractical (separate package), so this is the
 * canonical minimal-validator — same required fields, same shape constraints.
 *
 * Throws on validation failure with a descriptive message; returns the
 * normalised packet on success.
 */
export function validateLivingCVShape(p: LcvPacket): LcvPacket {
  if (!p || typeof p !== 'object') throw new Error('packet must be an object');
  if (p.schema !== 'career-packet-1') {
    throw new Error(`packet.schema must be "career-packet-1", got ${JSON.stringify(p.schema)}`);
  }
  if (!p.identity || typeof p.identity !== 'object') throw new Error('packet.identity is required');
  if (!p.identity.fullName || typeof p.identity.fullName !== 'string') {
    throw new Error('packet.identity.fullName is required');
  }
  if (typeof p.version !== 'string' || !p.version) throw new Error('packet.version is required (string)');
  for (const t of p.taglines || []) {
    if (!t.archetype || !t.text) throw new Error('packet.taglines entries need archetype + text');
  }
  for (const exp of p.experience || []) {
    if (!exp.company || !exp.title) throw new Error('packet.experience entries need company + title');
    if (!Array.isArray(exp.bullets)) throw new Error('packet.experience.bullets must be array');
    for (const b of exp.bullets) {
      if (typeof b.text !== 'string') throw new Error('packet.experience.bullets[].text must be string');
    }
  }
  for (const proj of p.projects || []) {
    if (!proj.slug || !proj.name) throw new Error('packet.projects entries need slug + name');
  }
  for (const sk of p.skills || []) {
    if (typeof sk.name !== 'string') throw new Error('packet.skills[].name must be string');
  }
  for (const ed of p.education || []) {
    if (!ed.institution || !ed.degree) throw new Error('packet.education entries need institution + degree');
  }
  return p;
}
