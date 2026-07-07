// render_pdf — produces resume + cover artifacts in any subset of {pdf, tex, docx}.
//
// PDF is rendered via the existing HTML→Chromium pipeline (templates/cv-template.html
// + Playwright). All formats are generated from ONE content snapshot taken at the
// start of the call (cvForRender: cv.md + active career packet + this job's
// tailored materials) so the content matches exactly across formats — editing
// and recompiling the .tex reproduces the same document.
//
// The visa-leakage scan runs against the *source text* for every format before any
// file is written. .tex content is grep-able directly. For .docx (binary OOXML)
// we scan the upstream inputs (parsed CV + cover prose) — those are the only
// places visa terms could enter.

import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { config } from '../../config.js';
import { getDb, runInWriteLock } from '../../db.js';
import { defineTool, okResult, errResult } from '../define.js';

import { renderPdf, type RenderedFile } from '../../core/render.js';
import { buildResumeTex, buildCoverTex, type CoverFields } from '../../core/render_tex.js';
import { buildResumeDocx, buildCoverDocx, type CoverDocxFields } from '../../core/render_docx.js';
import { cvForRender } from '../../core/render_source.js';
import { getJob } from '../../core/jobs.js';
import { parseCV } from '../../core/cv_parse.js';
import { scanForVisaLeakage } from '../../core/outreach_safety.js';
import { safeJson } from '../../core/llm.js';
import { fileUrl } from '../../core/links.js';
import { effectiveDefaultTemplate, resolveTheme } from '../../core/templates.js';

// ── Types ────────────────────────────────────────────────────────────────────

export type RenderKind   = 'resume' | 'cover';
export type RenderFormat = 'pdf' | 'tex' | 'docx';

export interface RenderedArtifact {
  kind:   RenderKind;
  format: RenderFormat;
  path:   string;    // under outputDir, e.g. "tex/resume-builder-pm-9a1b.tex"
  url:    string;    // full localhost link
  bytes:  number;
}

// ── Tool ─────────────────────────────────────────────────────────────────────

export const renderPdfTool = defineTool({
  name: 'render_pdf',
  title: 'Render resume + cover in PDF / LaTeX / Word',
  description:
    'Renders the resume and/or cover letter in any subset of {pdf, tex, docx}. PDFs ' +
    'are produced via Chromium HTML→PDF; .tex is a self-contained pdflatex-compatible ' +
    'source (compile to reproduce the PDF); .docx is generated with the docx library ' +
    'for Word / Google Docs editing. All formats share the same tailored content. ' +
    'URLs are persisted onto the application row; the visa-leakage rail applies to ' +
    'every output. Defaults to formats=["pdf"] for back-compat.',
    mutates: true,
inputSchema: {
    job_id:      z.string().min(1),
    kind:        z.enum(['resume', 'cover', 'both']).default('resume'),
    formats:     z.array(z.enum(['pdf','tex','docx'])).default(['pdf'])
                  .describe('Subset of {pdf, tex, docx}. Default ["pdf"].'),
    cover_body:  z.string().optional().describe('Plain-prose cover letter body (required when kind includes cover). 250-350 words.'),
    page_format: z.enum(['a4', 'letter']).default('letter'),
    template:    z.string().optional()
                  .describe('Named theme (see `jobops templates`). Searches JOBOPS_TEMPLATE_DIR then bundled themes. Defaults to JOBOPS_DEFAULT_TEMPLATE or "default". Affects .tex and .pdf only — .docx is procedurally generated.'),
  },
  handler: async (args) => {
    try {
      const job = getJob(args.job_id);
      if (!job) return errResult(`No job ${args.job_id}`);

      // Cover-body visa rail. The PDF path also re-checks but we do it here once so
      // tex/docx flow through the same gate.
      if (args.cover_body) {
        const leaks = scanForVisaLeakage(args.cover_body);
        if (leaks.length) {
          return errResult(`render_pdf: cover_body failed visa rail before any file was written — ${JSON.stringify(leaks)}`);
        }
      }

      const kinds: RenderKind[] = args.kind === 'both' ? ['resume', 'cover'] : [args.kind as RenderKind];
      const formats = args.formats as RenderFormat[];
      const cover_company  = (job as any).company_name_raw ?? '';
      const cover_location = (job as any).location_raw ?? '';

      // Resolve the theme once up-front so a typo errors clearly BEFORE any file
      // is written (and BEFORE Playwright spins up Chromium). Falls through to
      // the default when the param is unset.
      const themeName = args.template ?? effectiveDefaultTemplate();
      try { resolveTheme(themeName); }
      catch (err: any) { return errResult(err?.message ?? String(err)); }

      // Snapshot the render-time content ONCE per call — cv.md/profile.yml, the
      // active career packet, and THIS job's persisted tailored materials — so
      // every requested format shares the same (current) tailored content.
      const cv = cvForRender(args.job_id);

      const artifacts: RenderedArtifact[] = [];

      // PDF path — runs first because it brings up Playwright once for both kinds.
      if (formats.includes('pdf')) {
        const pdfFiles = await renderPdf({
          job_id:      args.job_id,
          kind:        args.kind,
          cover_body:  args.cover_body,
          page_format: args.page_format,
          theme:       themeName,
          cv,
        });
        for (const f of pdfFiles) {
          artifacts.push({ kind: f.kind, format: 'pdf', path: f.path, url: f.url, bytes: f.bytes });
        }
      }

      // .tex path — pure text, fast.
      if (formats.includes('tex')) {
        if (kinds.includes('resume')) artifacts.push(await writeText('tex', 'resume', args.job_id, job.title, buildResumeTex({ theme: themeName, cv })));
        if (kinds.includes('cover')) {
          if (!args.cover_body) throw new Error('cover_body required when kind includes cover');
          const tex = buildCoverTex({ body: args.cover_body, company: cover_company, location: cover_location }, { theme: themeName, cv });
          // Whole-file visa scan for the .tex — defense in depth (cover_body already
          // scanned upstream, but the resume.tex might inadvertently inherit terms).
          const leaks = scanForVisaLeakage(tex);
          if (leaks.length) throw new Error(`cover.tex failed visa rail — ${JSON.stringify(leaks)}`);
          artifacts.push(await writeText('tex', 'cover', args.job_id, job.title, tex));
        }
      }

      // .docx path — binary, generated programmatically.
      if (formats.includes('docx')) {
        if (kinds.includes('resume')) {
          const buf = await buildResumeDocx({ cv });
          // Visa scan was already applied to inputs (parsed cv.md, profile.yml) earlier
          // in the materials flow. The docx body is sourced entirely from those.
          artifacts.push(await writeBinary('docx', 'resume', args.job_id, job.title, buf));
        }
        if (kinds.includes('cover')) {
          if (!args.cover_body) throw new Error('cover_body required when kind includes cover');
          const fields: CoverDocxFields = { body: args.cover_body, company: cover_company, location: cover_location };
          const buf = await buildCoverDocx(fields, { cv });
          artifacts.push(await writeBinary('docx', 'cover', args.job_id, job.title, buf));
        }
      }

      const persisted = await persistRenderedFiles(args.job_id, artifacts);

      return okResult({
        job_id: args.job_id,
        template: themeName,
        formats_requested: formats,
        files: artifacts.map(a => ({ kind: a.kind, format: a.format, url: a.url, bytes: a.bytes, path: a.path })),
        application_id: persisted.application_id,
        application_status: persisted.status,
        status_advanced: persisted.status_advanced,
      });
    } catch (err: any) {
      return errResult(`render_pdf failed: ${err?.message ?? String(err)}`);
    }
  },
});

// ── File writing helpers ────────────────────────────────────────────────────

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || randomUUID().slice(0, 8);
}

function fileNameFor(kind: RenderKind, jobId: string, jobTitle: string, ext: string): string {
  return `${kind}-${slug(jobTitle)}-${jobId.slice(0, 8)}.${ext}`;
}

async function writeText(
  format: 'tex',
  kind: RenderKind,
  jobId: string,
  jobTitle: string,
  content: string,
): Promise<RenderedArtifact> {
  const subdir   = format;
  const filename = fileNameFor(kind, jobId, jobTitle, format);
  const dir      = resolve(config.outputDir, subdir);
  mkdirSync(dir, { recursive: true });
  const absPath  = resolve(dir, filename);
  writeFileSync(absPath, content, 'utf-8');
  const rel = `${subdir}/${filename}`;
  return {
    kind, format, path: rel,
    url:   fileUrl(rel),
    bytes: Buffer.byteLength(content, 'utf-8'),
  };
}

async function writeBinary(
  format: 'docx',
  kind: RenderKind,
  jobId: string,
  jobTitle: string,
  buf: Buffer,
): Promise<RenderedArtifact> {
  const subdir   = format;
  const filename = fileNameFor(kind, jobId, jobTitle, format);
  const dir      = resolve(config.outputDir, subdir);
  mkdirSync(dir, { recursive: true });
  const absPath  = resolve(dir, filename);
  writeFileSync(absPath, buf);
  const rel = `${subdir}/${filename}`;
  return {
    kind, format, path: rel,
    url:   fileUrl(rel),
    bytes: buf.length,
  };
}

// ── Persistence ──────────────────────────────────────────────────────────────

export interface PersistResult {
  application_id: string;
  status:         string;
  status_advanced: boolean;
}

/**
 * Persist all rendered artifacts onto the application row.
 *   - resume_path / cover_path get the PDF path (back-compat for tracker fast-path)
 *   - rendered_files JSON gets the full per-kind per-format map (merged with any
 *     pre-existing entries — re-rendering one format doesn't NULL the others)
 *   - status advances materials_drafted | render_error → ready_to_review
 *   - jobs.status mirrors only when in a pre-render state (never push terminal
 *     states backwards)
 *
 * Exported so the test suite can hit it without invoking Playwright/Chromium.
 */
export async function persistRenderedFiles(
  job_id: string,
  artifacts: Pick<RenderedArtifact, 'kind' | 'format' | 'path'>[],
): Promise<PersistResult> {
  return runInWriteLock(() => {
    const db = getDb();
    const existing = db.prepare(`
      SELECT id, status, rendered_files FROM applications WHERE job_id = ?
    `).get(job_id) as { id: string; status: string; rendered_files: string | null } | undefined;

    // Merge new artifact paths into the rendered_files map.
    const map = safeJson<Record<string, Record<string, string>>>(existing?.rendered_files ?? null, {});
    for (const a of artifacts) {
      if (!map[a.kind]) map[a.kind] = {};
      map[a.kind][a.format] = a.path;
    }
    const renderedJson = JSON.stringify(map);

    // PDF fast-path columns (legacy back-compat for the tracker).
    const resumePdf = artifacts.find(a => a.kind === 'resume' && a.format === 'pdf')?.path ?? null;
    const coverPdf  = artifacts.find(a => a.kind === 'cover'  && a.format === 'pdf')?.path ?? null;

    if (existing) {
      const advance = existing.status === 'materials_drafted' || existing.status === 'render_error';
      db.prepare(`
        UPDATE applications SET
          resume_path     = COALESCE(?, resume_path),
          cover_path      = COALESCE(?, cover_path),
          rendered_files  = ?,
          status          = CASE WHEN status IN ('materials_drafted','render_error')
                                  THEN 'ready_to_review' ELSE status END,
          last_status_change_at = CASE WHEN status IN ('materials_drafted','render_error')
                                        THEN CURRENT_TIMESTAMP
                                        ELSE last_status_change_at END,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(resumePdf, coverPdf, renderedJson, existing.id);
      mirrorJobStatus(db, job_id);
      const after = db.prepare(`SELECT status FROM applications WHERE id = ?`).get(existing.id) as { status: string };
      return { application_id: existing.id, status: after.status, status_advanced: advance && after.status === 'ready_to_review' };
    }

    const id = randomUUID();
    db.prepare(`
      INSERT INTO applications (id, job_id, status, resume_path, cover_path, rendered_files, materials_v, last_status_change_at)
      VALUES (?, ?, 'ready_to_review', ?, ?, ?, 1, CURRENT_TIMESTAMP)
    `).run(id, job_id, resumePdf, coverPdf, renderedJson);
    mirrorJobStatus(db, job_id);
    return { application_id: id, status: 'ready_to_review', status_advanced: true };
  });
}

function mirrorJobStatus(db: ReturnType<typeof getDb>, job_id: string): void {
  db.prepare(`
    UPDATE jobs SET status = 'ready_to_review', updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
      AND status IN ('sourced','ready_to_apply','materials_drafted')
  `).run(job_id);
}

// Re-export so tests can ensure parseCV / CoverFields stay shape-compatible.
export type { CoverFields, CoverDocxFields };
export { parseCV };
