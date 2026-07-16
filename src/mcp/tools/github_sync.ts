import { z } from 'zod';
import { defineTool, errResult, okResult } from '../define.js';
import {
  configureGithub, githubStatus, listGithubProposals, listGithubRepositories,
  reviewGithubProposal, runGithubSync, setGithubRepositoryIncluded,
} from '../../core/github_sync.js';
import { setGithubSchedulerEnabled, status as schedulerStatus } from '../../core/scheduler.js';

const fail = (prefix: string, e: unknown) => errResult(`${prefix}: ${(e as any)?.message ?? String(e)}`);

export const configureGithubSyncTool = defineTool({
  name: 'configure_github_sync', title: 'Configure public GitHub sync',
  description: 'Save a GitHub username for public-repository-only polling. This does not run a sync or enable the scheduler.',
  mutates: true,
  inputSchema: { username: z.string().min(1) },
  handler: async args => { try { return okResult(await configureGithub(args.username)); } catch (e) { return fail('GitHub configuration failed', e); } },
});

export const syncGithubTool = defineTool({
  name: 'sync_github', title: 'Sync public GitHub repositories',
  description: 'Poll configured public repositories and create candidate-reviewed CV proposals for changed projects.',
  mutates: true, inputSchema: {},
  handler: async () => { try { return okResult(await runGithubSync('manual')); } catch (e) { return fail('GitHub sync failed', e); } },
});

export const setGithubAutoSyncTool = defineTool({
  name: 'set_github_auto_sync', title: 'Enable or disable GitHub automatic sync',
  description: 'Explicitly enable or disable only the six-hour GitHub scheduler. Configuration alone leaves it off. Other jobs, history, and pending proposals are preserved.',
  mutates: true, inputSchema: { enabled: z.boolean() },
  handler: async args => okResult({ enabled: await setGithubSchedulerEnabled(args.enabled), frequency_hours: 6, scheduler: schedulerStatus() }),
});

export const githubSyncStatusTool = defineTool({
  name: 'get_github_sync_status', title: 'Get GitHub sync status',
  description: 'Return connection, repository, and pending-proposal counts. Private JobOps surface only.',
  mutates: false, inputSchema: {}, handler: async () => okResult(githubStatus()),
});

export const listGithubRepositoriesTool = defineTool({
  name: 'list_github_repositories', title: 'List synced public GitHub repositories',
  description: 'List only public repositories already admitted to the JobOps GitHub cache.',
  mutates: false, inputSchema: {}, handler: async () => okResult({ repositories: listGithubRepositories() }),
});

export const updateGithubRepositoryTool = defineTool({
  name: 'update_github_repository_settings', title: 'Include or exclude a GitHub repository',
  description: 'Control whether a cached public repository participates in future CV proposal generation.',
  mutates: true,
  inputSchema: { github_repo_id: z.number().int().positive(), included: z.boolean() },
  handler: async args => { try { await setGithubRepositoryIncluded(args.github_repo_id, args.included); return okResult({ ...args }); } catch (e) { return fail('Repository update failed', e); } },
});

export const listGithubProposalsTool = defineTool({
  name: 'list_github_cv_proposals', title: 'List GitHub CV proposals',
  description: 'List candidate-reviewed CV proposals generated from public GitHub evidence.',
  mutates: false,
  inputSchema: { status: z.enum(['pending','approved','edited','rejected','superseded','failed']).optional() },
  handler: async args => okResult({ proposals: listGithubProposals(args.status) }),
});

export const approveGithubProposalTool = defineTool({
  name: 'approve_github_cv_proposal', title: 'Approve a GitHub CV proposal',
  description: 'Agent approval path: recheck repository visibility, version the career packet, update cv.md, and immediately sync LivingCV when connected.',
  mutates: true,
  inputSchema: { proposal_id: z.string().uuid(), edited_packet_content: z.string().min(1).optional() },
  handler: async args => { try { return okResult(await reviewGithubProposal(args.proposal_id, 'approve', args.edited_packet_content)); } catch (e) { return fail('Proposal approval failed', e); } },
});

export const rejectGithubProposalTool = defineTool({
  name: 'reject_github_cv_proposal', title: 'Reject a GitHub CV proposal',
  description: 'Reject a proposal without changing the career packet or cv.md.',
  mutates: true, inputSchema: { proposal_id: z.string().uuid() },
  handler: async args => { try { return okResult(await reviewGithubProposal(args.proposal_id, 'reject')); } catch (e) { return fail('Proposal rejection failed', e); } },
});
