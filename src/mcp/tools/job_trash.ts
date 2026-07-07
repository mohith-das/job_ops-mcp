// Job trash workflow (chat): delete_jobs (soft), restore_jobs, list_trashed, purge_jobs (hard).
// All share core/job_trash.ts with the tracker UI endpoints. Soft-delete is recoverable and
// the default; hard purge is explicit, confirmed for purge_all, and backed up first.

import { z } from 'zod';

import { defineTool, okResult, errResult } from '../define.js';
import { JOB_STATUSES, trashJobs, restoreJobs, listTrashedJobs, purgeJobs } from '../../core/job_trash.js';

export const deleteJobsTool = defineTool({
  name: 'delete_jobs',
  title: 'Trash (soft-delete) jobs — recoverable',
  description:
    'Move 1..N jobs to the trash (recoverable soft-delete; NOT a hard delete). Identify by `job_ids` '
    + 'and/or by `statuses` (e.g. trash all "skip"/"discard"/"sourced"). Trashed jobs drop out of the '
    + 'tracker, get_top_jobs, and batch rating but are retained and restorable. Echoes exactly which jobs '
    + '(title + company) were trashed so a wrong selection is catchable. Hard deletion is only via purge_jobs.',
    mutates: true,
inputSchema: {
    job_ids:  z.array(z.string().min(1)).optional(),
    statuses: z.array(z.enum(JOB_STATUSES)).optional().describe('Trash every (non-trashed) job in these statuses.'),
  },
  handler: async (args) => {
    if (!args.job_ids?.length && !args.statuses?.length) {
      return errResult('Provide `job_ids` and/or `statuses` to trash.');
    }
    const r = await trashJobs({ jobIds: args.job_ids, statuses: args.statuses });
    return okResult({
      trashed: r.trashed, results: r.results,
      note: `Trashed ${r.trashed} job(s) (recoverable via restore_jobs; review list_trashed). Nothing was permanently deleted.`,
    });
  },
});

export const restoreJobsTool = defineTool({
  name: 'restore_jobs',
  title: 'Restore trashed jobs',
  description: 'Move trashed jobs back out of the trash to their prior state (their lifecycle status is unchanged by trashing). Echoes what was restored.',
  inputSchema: { job_ids: z.array(z.string().min(1)).min(1) },
  handler: async (args) => {
    const r = await restoreJobs(args.job_ids);
    return okResult({ restored: r.restored, results: r.results });
  },
  mutates: true,
 
});

export const listTrashedTool = defineTool({
  name: 'list_trashed',
  title: 'List trashed jobs',
  description: 'List currently trashed (soft-deleted) jobs — title, company, score, prior status, and when trashed — so you can review them before restoring or purging. Nothing here is permanently deleted yet.',
  inputSchema: {},
  handler: async () => {
    const items = listTrashedJobs();
    return okResult({ count: items.length, items });
  },
mutates: false,
  });

export const purgeJobsTool = defineTool({
  name: 'purge_jobs',
  title: 'Permanently delete (purge) trashed jobs',
  description:
    'HARD delete — permanently removes TRASHED jobs (a job must be trashed first; this never touches '
    + 'live jobs). Two modes: pass `job_ids` to purge specific trashed jobs, or `purge_all: true` to empty '
    + 'the entire trash. A timestamped backup of the affected rows is written to the project root BEFORE '
    + 'deletion. `purge_all` requires `confirm: true`. Echoes exactly what was permanently deleted.',
  inputSchema: {
    job_ids:   z.array(z.string().min(1)).optional(),
    purge_all: z.boolean().optional(),
    confirm:   z.boolean().optional().describe('Required (true) for purge_all.'),
  },
  handler: async (args) => {
    if (args.purge_all) {
      if (!args.confirm) {
        const pending = listTrashedJobs();
        return errResult(
          `purge_all permanently deletes ALL ${pending.length} trashed job(s). This cannot be undone (a backup is written first). `
          + `Re-call with confirm:true to proceed. Pending: ${pending.map(j => `${j.title} @ ${j.company}`).slice(0, 20).join('; ') || '(none)'}`);
      }
      const r = await purgeJobs({ all: true });
      return okResult({ purged: r.purged, backup_path: r.backup_path, results: r.results,
        note: `Permanently deleted ${r.purged} job(s). Backup: ${r.backup_path ?? '(nothing to purge)'}` });
    }
    if (!args.job_ids?.length) return errResult('Provide `job_ids`, or `purge_all: true` (with confirm: true).');
    const r = await purgeJobs({ jobIds: args.job_ids });
    return okResult({ purged: r.purged, backup_path: r.backup_path, results: r.results,
      note: `Permanently deleted ${r.purged} trashed job(s). Backup: ${r.backup_path ?? '(none — nothing matched a trashed job)'}` });
  },
  mutates: true,
 
});
