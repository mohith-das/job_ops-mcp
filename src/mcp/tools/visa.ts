// G4 — visa: import_h1b, import_linkedin, visa_signal.
//
// Importers accept CSV files only (avoid xlsx dep). LinkedIn Connections.csv is the
// official export shape. DOL OFLC H1B quarterly CSV column names are mapped via header
// lookup with fallbacks — DOL renames columns across fiscal years, so we accept aliases.

import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { readFileSync, existsSync, statSync } from 'node:fs';

import { getDb, runInWriteLock } from '../../db.js';
import { defineTool, okResult, errResult } from '../define.js';
import { parseCsv, findLinkedinHeader, pickHeader, parseMaybeNumber, expandUserPath } from '../../core/csv.js';
import { upsertCompany, findCompanyByName } from '../../core/jobs.js';
import { createCapture } from '../../http/elicit.js';

const MAX_FILE_BYTES = 200 * 1024 * 1024;  // 200 MB — full DOL quarterly is < this.

// ── visa_signal ──────────────────────────────────────────────────────────────

export const visaSignalTool = defineTool({
  name: 'visa_signal',
  title: 'Visa-friendliness signal for a company',
  description:
    'Aggregates h1b_filings via v_company_h1b_signal. Returns a band: strong / mixed / weak / none. ' +
    'INTERNAL ONLY — do NOT echo this into a resume, cover letter, or outreach.',
  inputSchema: { company: z.string().min(1) },
  handler: async (args) => {
    const c = findCompanyByName(args.company);
    const row = c
      ? getDb().prepare(`SELECT * FROM v_company_h1b_signal WHERE company_id = ?`).get(c.id) as any
      : null;

    if (!row || !row.total_filings) {
      return okResult({
        company: args.company,
        band: 'none',
        note: 'No matching H1B filings on file. Either the company has no LCAs in our imported dataset, or the name does not match our companies row.',
        total_filings: 0, certified: 0,
      });
    }
    const certified = Number(row.certified_count ?? 0);
    const total = Number(row.total_filings ?? 0);
    const recent = Number(row.most_recent_fy ?? 0);
    const thisFy = new Date().getFullYear();
    const recentlyActive = recent >= thisFy - 1;
    let band: 'strong' | 'mixed' | 'weak' = 'weak';
    if (certified >= 25 && recentlyActive) band = 'strong';
    else if (certified >= 5) band = 'mixed';
    return okResult({
      company: row.company_name,
      band,
      total_filings: total,
      certified,
      most_recent_fy: recent,
      last_decision_date: row.last_decision_date,
      note: 'INTERNAL ONLY — never surface in a resume, cover letter, or outreach.',
    });
  },
mutates: false,
  });

// ── import_linkedin ──────────────────────────────────────────────────────────

export const importLinkedinTool = defineTool({
  name: 'import_linkedin',
  title: 'Import a LinkedIn Connections.csv export',
  description:
    'Bulk-loads linkedin_connections from the standard LinkedIn export (Settings → Data Privacy → ' +
    'Export your data → Connections). The file path is sensitive: when you omit `path` and your ' +
    'client supports URL-mode elicitation, the server gives you a one-time local URL to enter the ' +
    'path directly — so it never passes through the MCP client/chat transcript.',
  inputSchema: {
    path:      z.string().min(1).optional().describe('Absolute path to Connections.csv. ~ is expanded. Omit to capture it out-of-band via URL-mode elicitation.'),
    dry_run:   z.boolean().default(false),
  },
  handler: async (args, ctx) => {
    // Resolve the path: explicit arg wins; else capture out-of-band when the client
    // supports URL-mode elicitation; else instruct the user to pass `path`.
    let rawPath = args.path;
    if (!rawPath) {
      if (ctx?.bridge?.canElicitUrl()) {
        const cap = createCapture({ label: 'Absolute path to your LinkedIn Connections.csv', field: 'path' });
        try {
          const r = await ctx.bridge.elicitUrl({
            message: 'Open this link on the machine running jobops and enter the absolute path to your '
                   + 'LinkedIn Connections.csv. The path goes straight to your local server, not through this chat.',
            url: cap.url,
          });
          // An explicit decline/cancel aborts. Some clients return the value inline in
          // `content` instead of driving the user to the local form — honor that too.
          if (r.action === 'decline' || r.action === 'cancel') {
            return errResult(`LinkedIn path capture ${r.action} — import aborted.`);
          }
          const inline = r.content?.path ?? r.content?.value;
          if (typeof inline === 'string' && inline.trim()) rawPath = inline.trim();
        } catch { /* client may not resolve URL elicitation with content; await the local form below */ }
        if (!rawPath) {
          try { rawPath = await cap.promise; }
          catch (e: any) { return errResult(`No path submitted: ${e?.message ?? e}`); }
        }
      } else {
        return errResult('Provide `path` (absolute path to Connections.csv). Your client does not support URL-mode elicitation for out-of-band capture.');
      }
    }
    const file = expandUserPath(rawPath);
    if (!existsSync(file)) return errResult(`file not found: ${file}`);
    if (statSync(file).size > MAX_FILE_BYTES) return errResult(`file too large (> ${MAX_FILE_BYTES} bytes)`);
    const allRows = parseCsv(readFileSync(file, 'utf-8'));
    const headerIdx = findLinkedinHeader(allRows);
    const dataRows = allRows.slice(headerIdx);
    if (dataRows.length < 2) return errResult('no data rows after header detection');
    const get = pickHeader(dataRows[0]);
    const rows = dataRows.slice(1);

    if (args.dry_run) return okResult({ dry_run: true, total_rows: rows.length, file });

    const summary = await runInWriteLock(() => {
      const db = getDb();
      const tx = db.transaction(() => {
        let inserted = 0, updated = 0, skipped = 0;
        const insertStmt = db.prepare(`
          INSERT INTO linkedin_connections (
            id, first_name, last_name, full_name, email, linkedin_url,
            company_id, company_raw, position, connected_on,
            is_recruiter, is_engineering, is_leadership
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        const updateStmt = db.prepare(`
          UPDATE linkedin_connections SET
            first_name = ?, last_name = ?, full_name = ?,
            email = COALESCE(NULLIF(?, ''), email),
            company_id = ?, company_raw = ?, position = ?, connected_on = ?,
            is_recruiter = ?, is_engineering = ?, is_leadership = ?,
            updated_at = CURRENT_TIMESTAMP
          WHERE linkedin_url = ?
        `);
        const existsStmt = db.prepare(`SELECT id FROM linkedin_connections WHERE linkedin_url = ?`);
        for (const r of rows) {
          const first    = get(r, 'First Name');
          const last     = get(r, 'Last Name');
          const url      = get(r, 'URL', 'Profile URL');
          const email    = get(r, 'Email Address', 'Email');
          const company  = get(r, 'Company');
          const position = get(r, 'Position');
          const connected = get(r, 'Connected On');
          if (!url || (!first && !last)) { skipped++; continue; }
          const full = `${first} ${last}`.trim();
          const lower = position.toLowerCase();
          const is_recruiter   = /(recruit|talent|sourcer|head of talent)/i.test(lower) ? 1 : 0;
          const is_engineering = /(engineer|developer|swe|sre|ml|data|backend|frontend|fullstack|platform)/i.test(lower) ? 1 : 0;
          const is_leadership  = /(chief|founder|ceo|cto|cpo|cmo|vp|director|head of|principal)/i.test(lower) ? 1 : 0;
          let company_id: string | null = null;
          if (company) {
            try { company_id = upsertCompany(company, { source: 'linkedin' }); } catch { /* ignore */ }
          }
          const existing = existsStmt.get(url) as { id: string } | undefined;
          if (existing) {
            updateStmt.run(first, last, full, email, company_id, company, position, connected,
                            is_recruiter, is_engineering, is_leadership, url);
            updated++;
          } else {
            insertStmt.run(randomUUID(), first, last, full, email, url, company_id, company, position, connected,
                            is_recruiter, is_engineering, is_leadership);
            inserted++;
          }
        }
        return { inserted, updated, skipped };
      });
      return tx();
    });
    return okResult({ file, rows_in_csv: rows.length, ...summary });
  },
  mutates: true,
 
});

// ── import_h1b ───────────────────────────────────────────────────────────────
//
// DOL OFLC quarterly LCA disclosure CSV. Recent files use these columns (subset of the
// 95 columns DOL ships). We pass-through unknowns into raw_json.

export const importH1bTool = defineTool({
  name: 'import_h1b',
  title: 'Import a DOL OFLC H1B LCA quarterly CSV',
  description:
    'Bulk-loads h1b_filings from a DOL OFLC LCA disclosure CSV (download the quarterly file from foreignlaborcert.doleta.gov/performancedata.cfm). ' +
    'Maps employer_name to companies via name_normalized; unmatched names are kept as employer_name_raw only.',
  mutates: true,
  inputSchema: {
    path:        z.string().min(1),
    fiscal_year: z.number().int().min(2010).max(2099).optional()
                  .describe('Override the fiscal_year column when missing; defaults to current FY.'),
    dry_run:     z.boolean().default(false),
    batch_size:  z.number().int().min(100).max(50_000).default(5_000),
  },
  handler: async (args) => {
    const file = expandUserPath(args.path);
    if (!existsSync(file)) return errResult(`file not found: ${file}`);
    if (statSync(file).size > MAX_FILE_BYTES) return errResult(`file too large (> ${MAX_FILE_BYTES} bytes)`);
    const allRows = parseCsv(readFileSync(file, 'utf-8'));
    if (allRows.length < 2) return errResult('empty CSV');
    const header = allRows[0];
    const get = pickHeader(header);
    const dataRows = allRows.slice(1);
    if (args.dry_run) return okResult({ dry_run: true, total_rows: dataRows.length, file });

    const fy = args.fiscal_year ?? new Date().getFullYear();

    const summary = await runInWriteLock(() => {
      const db = getDb();
      const insertStmt = db.prepare(`
        INSERT OR IGNORE INTO h1b_filings (
          case_number, case_status, visa_class, employer_id, employer_name_raw,
          job_title, soc_code, soc_title, work_city, work_state, work_postal_code,
          wage_rate_from, wage_rate_to, wage_unit, prevailing_wage,
          received_date, decision_date, employment_start, employment_end,
          full_time, new_employment, fiscal_year, raw_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const tx = db.transaction((batch: string[][]) => {
        let inserted = 0, skipped = 0, matched_company = 0;
        for (const r of batch) {
          const caseNum = get(r, 'CASE_NUMBER', 'Case Number');
          if (!caseNum) { skipped++; continue; }
          const employerRaw = get(r, 'EMPLOYER_NAME', 'Employer Name');
          let employerId: string | null = null;
          if (employerRaw) { try { employerId = upsertCompany(employerRaw, { source: 'h1b' }); matched_company++; } catch {} }
          insertStmt.run(
            caseNum,
            get(r, 'CASE_STATUS', 'Case Status') || 'Unknown',
            get(r, 'VISA_CLASS', 'Visa Class') || null,
            employerId,
            employerRaw,
            get(r, 'JOB_TITLE', 'Job Title') || null,
            get(r, 'SOC_CODE') || null,
            get(r, 'SOC_TITLE') || null,
            get(r, 'WORKSITE_CITY', 'Worksite City') || null,
            get(r, 'WORKSITE_STATE', 'Worksite State') || null,
            get(r, 'WORKSITE_POSTAL_CODE', 'Worksite Postal Code') || null,
            parseMaybeNumber(get(r, 'WAGE_RATE_OF_PAY_FROM', 'Wage Rate of Pay From')),
            parseMaybeNumber(get(r, 'WAGE_RATE_OF_PAY_TO',   'Wage Rate of Pay To')),
            get(r, 'WAGE_UNIT_OF_PAY', 'Wage Unit Of Pay') || null,
            parseMaybeNumber(get(r, 'PREVAILING_WAGE')),
            get(r, 'RECEIVED_DATE') || null,
            get(r, 'DECISION_DATE') || null,
            get(r, 'BEGIN_DATE', 'Period of Employment Begin Date') || null,
            get(r, 'END_DATE',   'Period of Employment End Date')   || null,
            get(r, 'FULL_TIME_POSITION') === 'Y' ? 1 : (get(r, 'FULL_TIME_POSITION') === 'N' ? 0 : null),
            get(r, 'NEW_EMPLOYMENT') === '1'    ? 1 : (get(r, 'NEW_EMPLOYMENT') === '0' ? 0 : null),
            Number(get(r, 'FISCAL_YEAR') || fy),
            // raw_json — we materialize a slim row object once per record (still bounded).
            JSON.stringify(Object.fromEntries(header.map((h, i) => [h, r[i] ?? '']))).slice(0, 8000),
          );
          inserted++;
        }
        return { inserted, skipped, matched_company };
      });

      let inserted = 0, skipped = 0, matched_company = 0;
      for (let i = 0; i < dataRows.length; i += args.batch_size) {
        const r = tx(dataRows.slice(i, i + args.batch_size));
        inserted += r.inserted; skipped += r.skipped; matched_company += r.matched_company;
      }
      return { inserted, skipped, matched_company };
    });
    return okResult({ file, rows_in_csv: dataRows.length, fiscal_year: fy, ...summary });
  },
});
