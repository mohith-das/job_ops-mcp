// Granular career-packet edits — change or remove ONE item (bullet / project / skill /
// tagline) without re-sending the whole document, plus version history + restore.
// Complements the whole-document update_career_packet. Every change versions the packet
// (history kept, reversible); edits run the visa-leakage scan on the new text.

import { z } from 'zod';

import { defineTool, okResult, errResult } from '../define.js';
import { editPacketItem, removePacketItem, listPacketVersions, restorePacketVersion } from '../../core/profile.js';
import { scanForVisaLeakage } from '../../core/outreach_safety.js';

// `item` is either a 1-based index within the section or a substring of the target item.
const itemArg = z.union([z.number().int().min(1), z.string().min(1)])
  .describe('Which item: a 1-based index within the section, OR a substring that uniquely matches it.');

export const editPacketItemTool = defineTool({
  name: 'edit_packet_item',
  title: 'Edit one career-packet item in place',
  description:
    'Change ONE item (a bullet / project / skill / tagline) in a packet section without re-sending the '
    + 'whole packet. `section` is a number ("3"–"8") or a name (taglines, projects, skills, education); '
    + 'experience spans 3/4/5 — address by number. Versions the packet (history kept) and runs the '
    + 'visa-leakage scan on the new text. For whole-document edits use update_career_packet.',
    mutates: true,
inputSchema: {
    section:  z.string().min(1),
    item:     itemArg,
    new_text: z.string().min(1).describe('Replacement text for the item (no leading "- ").'),
  },
  handler: async (args) => {
    // Hard rule: never let visa/work-auth language into the packet via a granular edit.
    const leaks = scanForVisaLeakage(args.new_text);
    if (leaks.length) {
      return errResult(`Refused: new_text contains visa/work-auth language (${leaks.map(l => l.rule).join(', ')}). The packet must never carry visa content.`);
    }
    try {
      const r = await editPacketItem(args.section, args.item, args.new_text);
      return okResult({ ...r, note: `Section ${r.section} item ${r.item_index_in_section} updated → packet v${r.new_version} (history kept).` });
    } catch (e: any) {
      return errResult(e?.message ?? String(e));
    }
  },
});

export const removePacketItemTool = defineTool({
  name: 'remove_packet_item',
  title: 'Remove one career-packet item',
  description:
    'Remove ONE item (bullet / project / skill / tagline) from a packet section. `section` is a number '
    + '("3"–"8") or a name (taglines, projects, skills, education). `item` is a 1-based index or a unique '
    + 'substring. Echoes the removed item so you can confirm the right one went. Versions the packet '
    + '(history kept — the removed item survives in a prior version and is restorable via restore_packet_version).',
  inputSchema: {
    section: z.string().min(1),
    item:    itemArg,
  },
  handler: async (args) => {
    try {
      const r = await removePacketItem(args.section, args.item);
      return okResult({
        section: r.section, removed_item: r.removed_item, item_index_in_section: r.item_index_in_section,
        new_version: r.new_version,
        note: `Removed from section ${r.section}: "${r.removed_item}" → packet v${r.new_version}. Recoverable: restore_packet_version can bring back the prior version.`,
      });
    } catch (e: any) {
      return errResult(e?.message ?? String(e));
    }
  },
  mutates: true,
 
});

export const restorePacketVersionTool = defineTool({
  name: 'restore_packet_version',
  title: 'List packet versions / restore a prior one',
  description:
    'Career-packet history + restore. Called with no `version`: returns the version list (number, origin, '
    + 'active flag, size, notes, timestamp) so you can pick one. Called with `version`: restores that '
    + 'version by writing its content as a new active version (history is preserved — restore is itself '
    + 'reversible). Use after an unwanted edit/removal.',
  inputSchema: {
    version: z.number().int().min(1).optional().describe('Version to restore. Omit to list available versions.'),
  },
  handler: async (args) => {
    if (args.version === undefined) {
      return okResult({ versions: listPacketVersions(), note: 'Pass `version` to restore one.' });
    }
    try {
      const r = await restorePacketVersion(args.version);
      return okResult({ ...r, note: `Restored content of v${r.restored_from} as new active v${r.new_version}.` });
    } catch (e: any) {
      return errResult(e?.message ?? String(e));
    }
  },
  mutates: true,
 
});
