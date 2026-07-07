import { z } from 'zod';

import { defineTool, okResult } from '../define.js';
import { JOB_DEFS, disableAll, setEnabledJobs, status, type JobName } from '../../core/scheduler.js';

const JOB_NAMES = Object.keys(JOB_DEFS) as JobName[];

export const schedulerStatusTool = defineTool({
  name: 'scheduler_status',
  title: 'Scheduler status',
  description: 'Returns currently enabled scheduler jobs, available jobs + intervals, and last fire time.',
  inputSchema: {},
  handler: async () => okResult(status()),
mutates: false,
  });

export const schedulerEnableTool = defineTool({
  name: 'scheduler_enable',
  title: 'Enable scheduler jobs (opt-in)',
  description: 'Pass an array of job names to enable. Overrides the previous set. The cron is off until you call this.',
  inputSchema: { jobs: z.array(z.enum(JOB_NAMES as [JobName, ...JobName[]])).min(1) },
  handler: async (args) => {
    const enabled = await setEnabledJobs(args.jobs);
    return okResult({ enabled, status: status() });
  },
  mutates: true,
 
});

export const schedulerDisableTool = defineTool({
  name: 'scheduler_disable',
  title: 'Disable all scheduler jobs',
  description: 'Clears the enabled-jobs list. Process keeps running.',
  inputSchema: {},
  handler: async () => {
    disableAll();
    return okResult({ enabled: [], status: status() });
  },
  mutates: true,
 
});
