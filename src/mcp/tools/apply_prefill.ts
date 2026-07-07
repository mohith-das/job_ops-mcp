// apply_prefill — Playwright opens the application form, reads visible fields, drafts
// values for the few fields we can confidently identify from structured profile data,
// takes a screenshot, returns a preview. NEVER auto-submits.
//
// Mapping policy (the heart of this file):
//
//   We maintain a SMALL ALLOWLIST of field kinds we'll fill from structured profile data:
//     first_name, last_name, preferred_name, full_name, email, phone,
//     linkedin, github, portfolio_url, city.
//
//   A field is classified into a kind ONLY when it has a strong, well-defined signal:
//     - autocomplete attribute (e.g. autocomplete="email")
//     - input type attribute (e.g. type="email", type="tel")
//     - exact `name` attribute match (e.g. name="email", name="first_name")
//     - exact / whole-word label match (e.g. label === "Email" or "First Name *")
//
//   Anything else — free-text questions ("Why this company?", "Where did you hear",
//   "Tell us about a project"), dropdowns, custom EEO/demographic fields, ambiguous
//   labels — is left BLANK with source='user_must_provide'. We NEVER fall back to
//   dumping tagline / cover-letter / summary prose into unmapped fields. Resume + cover
//   are returned as localhost links for the user to download and upload manually.
//
//   Visa / work-auth / citizenship / country-of-residence fields are explicitly
//   blocked regardless of any other match.
//
//   The default for an unrecognised field is ALWAYS blank/user_must_provide. We err
//   toward under-filling so a wrong value never lands in a free-text answer.

import { z } from 'zod';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import { config } from '../../config.js';
import { getDb } from '../../db.js';
import { defineTool, okResult, errResult } from '../define.js';
import { loadProjectFiles } from '../../core/profile.js';
import { getJobWithCompany } from '../../core/jobs.js';
import { getSharedBrowser } from '../../core/browser.js';
import { fileUrl } from '../../core/links.js';

const PREVIEW_SUBDIR = 'previews';

// ── Types ────────────────────────────────────────────────────────────────────

export type FieldKind =
  | 'first_name' | 'last_name' | 'preferred_name' | 'full_name'
  | 'email' | 'phone'
  | 'linkedin' | 'github' | 'portfolio_url'
  | 'city';

/** Raw signals scraped from the DOM. Inputs to classification. */
export interface DetectedRaw {
  selector:     string;
  label:        string;
  name:         string;
  autocomplete: string;
  type:         string;
  required:     boolean;
  tag:          'input' | 'textarea' | 'select';
}

export interface FieldClassification {
  kind:    FieldKind | null;
  reason:  string;
}

/** What we return per field in the preview JSON. */
export interface DetectedField {
  selector:    string;
  label:       string;
  type:        string;
  required:    boolean;
  draft_value: string;
  source:      'profile' | 'user_must_provide';
  classification: FieldClassification;
}

// ── Tool ─────────────────────────────────────────────────────────────────────

export const applyPrefillTool = defineTool({
  name: 'apply_prefill',
  title: 'Apply prefill (preview only — never submits)',
  description:
    'Opens the application URL in Playwright, classifies form fields by strong signals ' +
    '(autocomplete, input type, exact name, whole-word label), and fills ONLY a small ' +
    'allowlist of identity fields (name parts, email, phone, LinkedIn, GitHub, ' +
    'portfolio, city) from your profile. Any free-text question, dropdown, or ' +
    'unrecognised field is left BLANK with source=user_must_provide — never auto-filled ' +
    'with tagline / cover-letter / summary text. Visa / work-auth fields are explicitly ' +
    'blocked. Returns a preview + screenshot + your rendered resume/cover URLs for you ' +
    'to download + upload manually. NEVER submits.',
    mutates: true,
inputSchema: {
    job_id: z.string().min(1),
    url:    z.string().url().optional().describe('Override the job source_url (e.g. a different ATS apply URL).'),
  },
  handler: async (args) => {
    const job = getJobWithCompany(args.job_id);
    if (!job) return errResult(`No job ${args.job_id}`);
    const url = args.url ?? job.source_url;
    if (!url || !/^https?:\/\//.test(url)) return errResult(`No usable application URL for job ${args.job_id}`);

    const app = getDb().prepare(`SELECT * FROM applications WHERE job_id = ?`).get(args.job_id) as any;
    const { profile } = loadProjectFiles();
    const identity = (profile?.candidate ?? {}) as Record<string, string | undefined>;

    try {
      const browser = await getSharedBrowser();
      const page = await browser.newPage();
      await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 });
      await page.waitForTimeout(1_500);

      // Detect form inputs. Skip file/password/hidden/submit/button. Gather every
      // signal classification needs: autocomplete, name, type, plus the label.
      const detected: DetectedRaw[] = await page.$$eval(
        'input:not([type="hidden"]):not([type="file"]):not([type="password"]):not([type="submit"]):not([type="button"]), textarea, select',
        (els: any[]) => {
          const lookupLabel = (el: any): string => {
            if (el.getAttribute('aria-label')) return el.getAttribute('aria-label') as string;
            const id = el.getAttribute('id');
            if (id) {
              const lab = document.querySelector(`label[for="${(window as any).CSS.escape(id)}"]`);
              if (lab) return (lab as HTMLElement).innerText.trim();
            }
            const parentLab = el.closest('label');
            if (parentLab) return (parentLab as HTMLElement).innerText.trim();
            return el.getAttribute('placeholder') || el.getAttribute('name') || '';
          };
          const sel = (el: any): string => {
            const id = el.getAttribute('id');
            if (id) return `#${id}`;
            const name = el.getAttribute('name');
            if (name) return `[name="${name}"]`;
            return el.tagName.toLowerCase();
          };
          return els.slice(0, 60).map((el: any) => ({
            selector:     sel(el),
            label:        lookupLabel(el),
            name:         el.getAttribute('name') ?? '',
            autocomplete: el.getAttribute('autocomplete') ?? '',
            type:         (el.getAttribute('type') || el.tagName).toLowerCase(),
            required:     !!el.required || el.getAttribute('aria-required') === 'true',
            tag:          el.tagName.toLowerCase(),
          }));
        },
      ) as DetectedRaw[];

      // Screenshot
      mkdirSync(resolve(config.outputDir, PREVIEW_SUBDIR), { recursive: true });
      const shotPath = `${PREVIEW_SUBDIR}/apply-${args.job_id.slice(0, 8)}-${Date.now()}.png`;
      const absShot = resolve(config.outputDir, shotPath);
      await page.screenshot({ path: absShot, fullPage: true });

      const fields: DetectedField[] = detected.map(d => draftValue(d, identity));

      const previewId = randomUUID();
      const filled = fields.filter(f => f.source === 'profile').length;
      const previewJson = {
        preview_id:    previewId,
        job_id:        args.job_id,
        url,
        company:       job.company_name,
        title:         job.title,
        warning:       'preview only — this tool never submits. Upload resume/cover manually using the localhost links below. Any blank field is intentionally left for you to answer.',
        fields_total:  fields.length,
        fields_auto_filled:    filled,
        fields_user_must_provide: fields.length - filled,
        fields,
        resume_url:    app?.resume_path ? fileUrl(app.resume_path) : null,
        cover_url:     app?.cover_path  ? fileUrl(app.cover_path)  : null,
        screenshot_url: fileUrl(shotPath),
      };
      writeFileSync(absShot.replace(/\.png$/, '.json'), JSON.stringify(previewJson, null, 2), 'utf-8');

      await page.close();
      return okResult(previewJson);
    } catch (e: any) {
      return errResult(`apply_prefill failed: ${e?.message ?? String(e)}`);
    }
    // Shared browser stays alive for the next caller — closed at server shutdown.
  },
});

// ── Classification (pure — exported for tests) ───────────────────────────────

const VISA_PATTERN = /\b(visa|sponsor(ship|ed|s)?|work[\s_-]*(auth|permit|authoriz|authoris)|legally\s*authorized|citizen(ship)?|h-?1-?b|opt\b|stem\s*opt|ead\b|nationality|country[\s_-]*of[\s_-]*(residence|origin|citizenship))\b/i;

/** Classify a detected field by strong signals only. Returns kind=null when unsure. */
export function classifyField(d: DetectedRaw): FieldClassification {
  const label = (d.label ?? '').toLowerCase().trim();
  const name  = (d.name  ?? '').toLowerCase().trim();
  const ac    = (d.autocomplete ?? '').toLowerCase().trim();
  const type  = (d.type ?? '').toLowerCase().trim();

  // Visa / work-auth — explicit block, runs FIRST so no other rule can override.
  if (VISA_PATTERN.test(label) || VISA_PATTERN.test(name)) {
    return { kind: null, reason: 'visa/work-auth field — never auto-fill' };
  }

  // Free-text answer surfaces (textarea, large free-form questions) are NEVER mapped,
  // even if the label happens to contain a kind-keyword as a substring. The point of
  // these fields is to elicit a candidate-written answer.
  if (d.tag === 'textarea') {
    return { kind: null, reason: 'textarea / free-text — never auto-fill' };
  }
  if (d.tag === 'select') {
    return { kind: null, reason: 'select / dropdown — never auto-fill' };
  }

  // ── Email
  if (type === 'email' || ac === 'email'
      || /^(email|email_address|emailaddress|e_mail|emailid)$/.test(name)
      || /^(email|e[\s\-]?mail)( address)?\*?$/.test(label)) {
    return { kind: 'email', reason: 'strong email signal' };
  }
  // ── Phone
  if (type === 'tel' || ac === 'tel'
      || /^(phone|telephone|mobile|tel|phone_number|mobile_number|cellphone)$/.test(name)
      || /^(phone|telephone|mobile|cell)( number)?\*?$/.test(label)) {
    return { kind: 'phone', reason: 'strong phone signal' };
  }
  // ── First name
  if (ac === 'given-name'
      || /^(first|first_name|firstname|givenname|given_name|fname)$/.test(name)
      || /^(first name|given name|first)\*?$/.test(label)) {
    return { kind: 'first_name', reason: 'strong first-name signal' };
  }
  // ── Last name
  if (ac === 'family-name'
      || /^(last|last_name|lastname|familyname|family_name|surname|lname)$/.test(name)
      || /^(last name|family name|surname|last)\*?$/.test(label)) {
    return { kind: 'last_name', reason: 'strong last-name signal' };
  }
  // ── Preferred name / nickname
  if (/^(preferred_name|preferredname|nickname|known_as)$/.test(name)
      || /^(preferred name|nickname|what should we call you|known as)\*?$/.test(label)) {
    return { kind: 'preferred_name', reason: 'preferred-name signal' };
  }
  // ── Full name (kept narrow — "company name", "manager name" must NOT match)
  if (ac === 'name'
      || /^(name|full_name|fullname|your_name|legal_name)$/.test(name)
      || /^(full name|your name|legal name|name)\*?$/.test(label)) {
    return { kind: 'full_name', reason: 'strong full-name signal' };
  }
  // ── LinkedIn
  if (/(^|[_\b])linkedin($|[_\b])/.test(name)
      || /\blinkedin( profile| url)?\*?$/.test(label)) {
    return { kind: 'linkedin', reason: 'linkedin signal' };
  }
  // ── GitHub
  if (/(^|[_\b])github($|[_\b])/.test(name)
      || /\bgithub( profile| url)?\*?$/.test(label)) {
    return { kind: 'github', reason: 'github signal' };
  }
  // ── Portfolio / personal website (only when whole-word, not generic "url")
  if (/^(website|portfolio|personal_site|personal_website|website_url|portfolio_url|portfolio_link)$/.test(name)
      || /^(website|portfolio|personal website|personal site)\*?$/.test(label)) {
    return { kind: 'portfolio_url', reason: 'portfolio signal' };
  }
  // ── City / location (strict whole-word; "where are you LOCATED" is too ambiguous)
  if (ac === 'address-level2'
      || /^(city|current_city|location)$/.test(name)
      || /^(city|current city|location)\*?$/.test(label)) {
    return { kind: 'city', reason: 'city signal' };
  }

  return { kind: null, reason: 'no confident match — left for user' };
}

/**
 * Map a classified field to a draft value from the candidate's profile. Pure function,
 * exported for tests. Returns a DetectedField with source='user_must_provide' for any
 * kind=null OR when the profile lacks the data (e.g. no linkedin in profile.yml).
 */
export function draftValue(d: DetectedRaw, identity: Record<string, string | undefined>): DetectedField {
  const classification = classifyField(d);
  let value = '';

  switch (classification.kind) {
    case 'email':         value = identity.email ?? ''; break;
    case 'phone':         value = identity.phone ?? ''; break;
    case 'first_name':    value = (identity.full_name ?? '').trim().split(/\s+/)[0] ?? ''; break;
    case 'last_name':     value = (identity.full_name ?? '').trim().split(/\s+/).slice(1).join(' ').trim(); break;
    case 'preferred_name': value = (identity.full_name ?? '').trim().split(/\s+/)[0] ?? ''; break;
    case 'full_name':     value = identity.full_name ?? ''; break;
    case 'linkedin':      value = identity.linkedin ?? ''; break;
    case 'github':        value = identity.github ?? ''; break;
    case 'portfolio_url': value = identity.portfolio_url ?? identity.github ?? ''; break;
    case 'city':          value = identity.location ?? ''; break;
    case null:            value = ''; break;
  }

  const source: DetectedField['source'] = (classification.kind && value) ? 'profile' : 'user_must_provide';
  return {
    selector: d.selector,
    label:    d.label,
    type:     d.type,
    required: !!d.required,
    draft_value: value,
    source,
    classification,
  };
}
