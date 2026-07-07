import { z } from 'zod';

import { getLatestReport } from '../../core/reports.js';
import { fileUrl } from '../../core/links.js';
import { defineTool, okResult, errResult } from '../define.js';

export const getReportTool = defineTool({
  name: 'get_report',
  title: 'Get the latest eval report for a job',
  description: 'Returns the localhost HTML report link and metadata for the latest eval_report row for a job_id.',
  inputSchema: { job_id: z.string().min(1) },
  handler: async (args) => {
    const row = getLatestReport(args.job_id);
    if (!row) return errResult(`No eval report for job ${args.job_id}. Run evaluate_job first.`);
    return okResult({
      job_id: args.job_id,
      report_id: row.id,
      archetype_detected: row.archetype_detected,
      keywords: row.keywords,
      url: fileUrl(row.html_path),
      created_at: row.created_at,
    });
  },
mutates: false,
  });
