// Contact backup / portability + safe deletion.
//   export_contacts — full-fidelity CSV + JSON dump (the backup/portability path)
//   import_contacts — upsert/merge from a JSON/CSV file (never delete-and-replace; backup first)
//   delete_contacts — soft-delete (archive) 1..N contacts; recoverable; backup first; echoes matches

import { z } from 'zod';

import { defineTool, okResult, errResult } from '../define.js';
import { exportContacts, importContacts, deleteContacts, type DeleteIdentifier } from '../../core/contacts.js';

export const exportContactsTool = defineTool({
  name: 'export_contacts',
  title: 'Export all contacts (CSV + JSON backup)',
  description:
    'Writes ALL contacts (every field — classification flags, notes, email, resolved company, ids, '
    + 'archived state) to timestamped CSV and JSON files in the project root. The backup / portability '
    + 'path: re-importing the JSON reproduces the same DB with zero loss and zero duplicates.',
    mutates: true,
inputSchema: {},
  handler: async () => {
    const r = exportContacts();
    return okResult({ ...r, note: `Exported ${r.count} contact(s). Re-import with import_contacts to restore/merge (non-destructive).` });
  },
});

export const importContactsTool = defineTool({
  name: 'import_contacts',
  title: 'Import contacts from a JSON/CSV file (merge, non-destructive)',
  description:
    'Imports contacts from a JSON or CSV file (e.g. a prior export_contacts file, or any compatible file). '
    + 'UPSERT/MERGE only — NEVER delete-and-replace: matches existing rows (linkedin_url, else full_name + '
    + 'company) and COALESCE-merges so blank/absent fields never overwrite richer existing data; inserts new '
    + 'rows. Idempotent (re-importing an export creates no duplicates and loses nothing). A timestamped '
    + 'backup of the contacts table is written BEFORE any change.',
  inputSchema: {
    path: z.string().min(1).describe('Absolute path to the .json or .csv file. ~ is expanded.'),
  },
  handler: async (args) => {
    try {
      const r = await importContacts(args.path);
      return okResult({
        source: r.source,
        backup_path: r.backup_path,
        parsed_rows: r.parsed_rows,
        inserted: r.summary.inserted,
        updated:  r.summary.updated,
        skipped:  r.summary.skipped,
        results:  r.summary.results,
        note: `Backup written to ${r.backup_path} before import. Merge-only — nothing was deleted or overwritten with blanks.`,
      });
    } catch (e: any) {
      return errResult(`import_contacts failed: ${e?.message ?? String(e)}`);
    }
  },
  mutates: true,
 
});

const identifierSchema = z.object({
  id:           z.string().optional(),
  linkedin_url: z.string().optional(),
  full_name:    z.string().optional(),
  company:      z.string().optional(),
}).describe('Identify a contact by id, OR linkedin_url, OR full_name (+ optional company).');

export const deleteContactsTool = defineTool({
  name: 'delete_contacts',
  title: 'Delete (archive) one or more contacts',
  description:
    'Soft-deletes 1..N contacts (array). Each identified by id, linkedin_url, or full_name + company. '
    + 'Archived contacts are hidden from find_warm_intros / find_founders but stay recoverable in the row '
    + '(not hard-deleted). A timestamped backup is written first. Returns per-identifier results echoing '
    + 'EXACTLY which rows matched (name + company + url) so a wrong fuzzy match is catchable, plus '
    + 'not-found entries. Show the user the matched rows to confirm.',
  inputSchema: {
    contacts: z.array(identifierSchema).min(1).describe('1..N contact identifiers to archive.'),
  },
  handler: async (args) => {
    const ids = (args.contacts as DeleteIdentifier[]) ?? [];
    if (!ids.length) return errResult('Provide a non-empty `contacts` array of identifiers.');
    const r = await deleteContacts(ids);
    return okResult({
      archived: r.archived,
      not_found: r.not_found,
      backup_path: r.backup_path,
      results: r.results,
      note: `Soft-deleted (archived) ${r.archived} contact(s) — hidden from warm-intro/founder discovery but recoverable. `
          + `Backup written to ${r.backup_path}. Review results[].matched to confirm the right rows were removed.`,
    });
  },
  mutates: true,
 
});
