// add_contacts — insert/update one or more network contacts from chat in a single call.
// Complements the bulk import_linkedin CSV path; use it to capture people found during the
// search. Writes to linkedin_connections, so contacts are immediately discoverable by
// find_warm_intros / find_founders.
//
// The CLIENT (Claude) is responsible for parsing free-text / pasted contact info into the
// structured fields below before calling; this tool stores the structured input. Only
// full_name is required — partial contacts are accepted and the per-contact result reports
// which fields were missing/unresolved so the chat can ask the user to fill the gaps.

import { z } from 'zod';

import { defineTool, okResult, errResult } from '../define.js';
import { addContacts, type ContactInput } from '../../core/contacts.js';

const contactSchema = z.object({
  // Everything optional at the schema level so a row missing full_name is SKIPPED+reported
  // rather than rejecting the whole batch (validation happens per-row in the handler).
  full_name:      z.string().optional().describe('REQUIRED in practice — rows without it are skipped + reported.'),
  company:        z.string().optional(),
  position:       z.string().optional().describe('Job title. `title` is accepted as an alias.'),
  title:          z.string().optional().describe('Alias for `position`.'),
  linkedin_url:   z.string().optional(),
  email:          z.string().optional(),
  notes:          z.string().optional(),
  is_recruiter:   z.boolean().optional().describe('Override; if omitted, inferred from the title.'),
  is_engineering: z.boolean().optional().describe('Override; if omitted, inferred from the title.'),
  is_leadership:  z.boolean().optional().describe('Override; if omitted, inferred from the title.'),
}).passthrough();

export const addContactsTool = defineTool({
  name: 'add_contacts',
  title: 'Add or update network contacts',
  description:
    'Insert/update ONE OR MORE network contacts in a single call (array of 1..N). Upsert: matches on '
    + 'linkedin_url if present, else full_name + company — never creates silent duplicates. Company names '
    + 'are resolved with the same alias/normalization as import_linkedin, so contacts attach to the right '
    + 'company row and find_warm_intros / find_founders pick them up. Role flags (is_recruiter/_engineering/'
    + '_leadership) use caller values if given, else are inferred from the title. On update, fields you omit '
    + 'are preserved (merge, not clobber). Only full_name is required; partial contacts are stored and the '
    + 'result reports per-contact what was missing/unresolved. You (the client) parse free-text/pasted info '
    + 'into these structured fields first.',
    mutates: true,
inputSchema: {
    contacts: z.array(contactSchema).min(1).describe('1..N contact objects.'),
  },
  handler: async (args) => {
    const raw = args.contacts as Array<Record<string, unknown>>;
    if (!Array.isArray(raw) || raw.length === 0) return errResult('Provide a non-empty `contacts` array.');

    const inputs: ContactInput[] = raw.map((c) => ({
      full_name:      typeof c.full_name === 'string' ? c.full_name : undefined,
      company:        typeof c.company === 'string' ? c.company : undefined,
      // accept `title` as an alias for `position`
      position:       typeof c.position === 'string' ? c.position : (typeof c.title === 'string' ? c.title : undefined),
      linkedin_url:   typeof c.linkedin_url === 'string' ? c.linkedin_url : undefined,
      email:          typeof c.email === 'string' ? c.email : undefined,
      notes:          typeof c.notes === 'string' ? c.notes : undefined,
      is_recruiter:   typeof c.is_recruiter === 'boolean' ? c.is_recruiter : undefined,
      is_engineering: typeof c.is_engineering === 'boolean' ? c.is_engineering : undefined,
      is_leadership:  typeof c.is_leadership === 'boolean' ? c.is_leadership : undefined,
    }));

    const summary = await addContacts(inputs);
    return okResult({
      ...summary,
      note: summary.skipped
        ? `${summary.skipped} row(s) skipped (see results[].reason). Valid rows were saved.`
        : undefined,
    });
  },
});
