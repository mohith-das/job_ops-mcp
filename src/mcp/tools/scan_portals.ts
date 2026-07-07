import { z } from 'zod';

import { runScan, knownProviderIds } from '../../core/scan_engine.js';
import { defineTool, okResult, errResult } from '../define.js';

export const scanPortalsTool = defineTool({
  name: 'scan_portals',
  title: 'Scan job portals',
  description:
    'Fan out across configured ATS endpoints. Greenhouse / Ashby / Lever / Workday hit JSON APIs; ' +
    'Google + custom playwright_generic use Chromium. Content-hash dedupes across sources. ' +
    'Reads tracked_companies from portals.yml in the project root.',
    mutates: true,
inputSchema: {
    sources:   z.array(z.string()).optional().describe(`Restrict to a subset of providers. Known: ${knownProviderIds().join(', ')}.`),
    companies: z.array(z.string()).optional().describe('Restrict to companies whose name contains any of these substrings.'),
    title_positive: z.array(z.string()).optional(),
    title_negative: z.array(z.string()).optional(),
    location_allow: z.array(z.string()).optional(),
    location_block: z.array(z.string()).optional(),
  },
  handler: async (args) => {
    try {
      const result = await runScan({
        sources:        args.sources,
        companies:      args.companies,
        title_positive: args.title_positive,
        title_negative: args.title_negative,
        location_allow: args.location_allow,
        location_block: args.location_block,
      }, { triggeredBy: 'scan_portals' });
      return okResult(result);
    } catch (err: any) {
      return errResult(`scan_portals failed: ${err?.message ?? String(err)}`);
    }
  },
});
