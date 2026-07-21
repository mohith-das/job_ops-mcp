import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { getDb, runInWriteLock } from '../db.js';
import {
  evidenceHash, extractGithubEvidence, getDefaultBranchSha, getGithubUser,
  isPublicRepository, listPublicRepositories, type GithubEvidence, type PublicRepo,
} from './github_client.js';
import {
  editPacketSection, getActiveCareerPacket, syncPacketToSourceFiles, writeGitHubMergedPacket,
} from './profile.js';
import { compileCareerPacketJson } from './career_packet_json.js';
import { syncToLivingCV } from './livingcv_client.js';

export interface GithubSyncResult {
  run_id: string; repositories_seen: number; repositories_changed: number; proposals_created: number;
}

function clean(s: string): string {
  return s.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function projectBullet(repo: PublicRepo, evidence: GithubEvidence): string {
  const title = clean(repo.name.replace(/[-_]+/g, ' '));
  const tech = [...Object.keys(evidence.languages), ...evidence.technologies].slice(0, 6).join(', ');
  const description = clean(evidence.description || evidence.readme_summary || 'Public software project');
  const suffix = evidence.deployment_url ? `; live: ${evidence.deployment_url}` : '';
  return `- **${title}**${tech ? ` (${tech})` : ''} — ${description}. [GitHub](${evidence.repository_url})${suffix}`;
}

function sectionBody(content: string, section: number): string {
  const heading = new RegExp(`^## ${section}\\.[^\\n]*\\n`, 'm').exec(content);
  if (!heading) return '';
  const start = heading.index + heading[0].length;
  const next = /^## /m.exec(content.slice(start));
  return content.slice(start, next ? start + next.index : content.length).trim();
}

function mergeProjectBullet(activeContent: string, repositoryUrl: string, bullet: string): string {
  const current = sectionBody(activeContent, 6);
  const lines = current.split('\n').filter(Boolean);
  const urlIndex = lines.findIndex(line => line.includes(repositoryUrl));
  if (urlIndex >= 0) lines[urlIndex] = bullet;
  else lines.push(bullet);
  return editPacketSection(activeContent, '6', lines.join('\n'));
}

export function proposePacketContent(activeContent: string, repo: PublicRepo, evidence: GithubEvidence): string {
  return mergeProjectBullet(activeContent, evidence.repository_url, projectBullet(repo, evidence));
}

function editedProjectBullet(editedContent: string, repositoryUrl: string): string {
  const line = sectionBody(editedContent, 6)
    .split('\n')
    .map(value => value.trim())
    .find(value => value.includes(repositoryUrl));
  if (!line) {
    throw new Error('Edited proposal must retain the approved repository URL in the Projects section.');
  }
  return line;
}

export async function configureGithub(username: string): Promise<object> {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(username)) throw new Error('Invalid GitHub username.');
  const user = await getGithubUser(username);
  await runInWriteLock(() => getDb().prepare(`
    INSERT INTO github_connection (id, github_username, github_user_id, enabled)
    VALUES (1, ?, ?, 0)
    ON CONFLICT(id) DO UPDATE SET github_username=excluded.github_username,
      github_user_id=excluded.github_user_id,
      last_error=NULL, updated_at=CURRENT_TIMESTAMP
  `).run(user.login, user.id));
  const { status } = await import('./scheduler.js');
  const schedulerEnabled = status().enabled_jobs.includes('github_sync_6h');
  return { username: user.login, github_user_id: user.id, automatic_sync: schedulerEnabled, scheduled_every_hours: schedulerEnabled ? 6 : null };
}

function connection(): any {
  return getDb().prepare(`SELECT * FROM github_connection WHERE id = 1`).get();
}

export function githubStatus(): object {
  const c = connection();
  const repos = getDb().prepare(`SELECT COUNT(*) AS n FROM github_repositories WHERE included = 1`).get() as any;
  const pending = getDb().prepare(`SELECT COUNT(*) AS n FROM github_cv_proposals WHERE status = 'pending'`).get() as any;
  return { configured: !!c, connection: c ?? null, included_repositories: repos.n, pending_proposals: pending.n };
}

export function listGithubRepositories(): object[] {
  return getDb().prepare(`SELECT * FROM github_repositories ORDER BY full_name`).all() as object[];
}

export function listGithubProposals(status?: string): object[] {
  const rows = status
    ? getDb().prepare(`SELECT * FROM github_cv_proposals WHERE status = ? ORDER BY created_at DESC`).all(status)
    : getDb().prepare(`SELECT * FROM github_cv_proposals ORDER BY created_at DESC`).all();
  return (rows as any[]).map(r => ({ ...r, evidence: JSON.parse(r.evidence_json), evidence_json: undefined }));
}

export async function runGithubSync(trigger = 'manual'): Promise<GithubSyncResult> {
  const c = connection();
  const username = c?.github_username || config.githubUsername;
  if (!username) throw new Error('GitHub is not configured. Set JOBOPS_GITHUB_USERNAME or call configure_github_sync.');
  const active = getActiveCareerPacket();
  if (!active) throw new Error('No active career packet. Initialize JobOps first.');

  const runId = randomUUID();
  await runInWriteLock(() => getDb().prepare(`INSERT INTO github_sync_runs (id, trigger, status) VALUES (?, ?, 'running')`).run(runId, trigger));
  let seen = 0, changed = 0, created = 0;
  try {
    const repos = await listPublicRepositories(username);
    // If a cached repository is no longer in the public listing, delete its cached
    // evidence and proposals. This covers public→private/internal transitions without
    // attempting to query or retain the now-inaccessible repository.
    const publicIds = new Set(repos.filter(isPublicRepository).map(r => r.id));
    await runInWriteLock(() => {
      const cached = getDb().prepare(`SELECT github_repo_id FROM github_repositories`).all() as Array<{ github_repo_id: number }>;
      const remove = getDb().prepare(`DELETE FROM github_repositories WHERE github_repo_id=?`);
      for (const row of cached) if (!publicIds.has(row.github_repo_id)) remove.run(row.github_repo_id);
    });
    // One REST request per processed repository (default-branch SHA). Without a token,
    // leave headroom under GitHub's unauthenticated 60/hour limit.
    const processableRepos = config.githubToken ? repos : repos.slice(0, 50);
    for (const repo of processableRepos) {
      if (!isPublicRepository(repo)) continue;
      if ((!config.githubIncludeForks && repo.fork) || (!config.githubIncludeArchived && repo.archived)) continue;
      seen++;
      const previous = getDb().prepare(`SELECT * FROM github_repositories WHERE github_repo_id = ?`).get(repo.id) as any;
      if (previous?.included === 0) continue;
      const sha = await getDefaultBranchSha(repo);
      if (previous?.latest_sha === sha) {
        await runInWriteLock(() => getDb().prepare(`UPDATE github_repositories SET last_checked_at=CURRENT_TIMESTAMP WHERE github_repo_id=?`).run(repo.id));
        continue;
      }
      changed++;
      const evidence = await extractGithubEvidence(repo, sha);
      const hash = evidenceHash(evidence);
      if (previous?.content_hash === hash) {
        await runInWriteLock(() => getDb().prepare(`
          UPDATE github_repositories SET latest_sha=?, latest_pushed_at=?, last_checked_at=CURRENT_TIMESTAMP,
            updated_at=CURRENT_TIMESTAMP WHERE github_repo_id=?
        `).run(sha, repo.pushed_at, repo.id));
        continue;
      }
      const proposed = proposePacketContent(getActiveCareerPacket()?.content ?? active.content, repo, evidence);
      const proposalId = randomUUID();
      await runInWriteLock(() => {
        const db = getDb();
        db.prepare(`
          INSERT INTO github_repositories
            (github_repo_id, full_name, html_url, description, visibility, is_fork, is_archived,
             default_branch, latest_sha, latest_pushed_at, content_hash, included, last_checked_at, updated_at)
          VALUES (?, ?, ?, ?, 'public', ?, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
          ON CONFLICT(github_repo_id) DO UPDATE SET full_name=excluded.full_name, html_url=excluded.html_url,
            description=excluded.description, visibility='public', is_fork=excluded.is_fork,
            is_archived=excluded.is_archived, default_branch=excluded.default_branch,
            latest_sha=excluded.latest_sha, latest_pushed_at=excluded.latest_pushed_at,
            content_hash=excluded.content_hash, last_checked_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
        `).run(repo.id, repo.full_name, repo.html_url, repo.description, repo.fork ? 1 : 0,
          repo.archived ? 1 : 0, repo.default_branch, sha, repo.pushed_at, hash);
        db.prepare(`UPDATE github_cv_proposals SET status='superseded' WHERE github_repo_id=? AND status='pending'`).run(repo.id);
        const info = db.prepare(`
          INSERT OR IGNORE INTO github_cv_proposals
            (id, github_repo_id, source_commit_sha, source_url, evidence_json, proposed_packet_content, packet_diff, confidence)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(proposalId, repo.id, sha, repo.html_url, JSON.stringify(evidence), proposed,
          `Section 6 project update from ${repo.full_name} at ${sha.slice(0, 12)}`, evidence.evidence_sources.length ? 80 : 60);
        if (info.changes) created++;
      });
    }
    await runInWriteLock(() => {
      const db = getDb();
      db.prepare(`UPDATE github_sync_runs SET status='success', repositories_seen=?, repositories_changed=?, proposals_created=?, completed_at=CURRENT_TIMESTAMP WHERE id=?`).run(seen, changed, created, runId);
      db.prepare(`UPDATE github_connection SET last_sync_at=CURRENT_TIMESTAMP, last_success_at=CURRENT_TIMESTAMP, last_error=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=1`).run();
    });
    return { run_id: runId, repositories_seen: seen, repositories_changed: changed, proposals_created: created };
  } catch (e: any) {
    const message = e?.message ?? String(e);
    await runInWriteLock(() => {
      getDb().prepare(`UPDATE github_sync_runs SET status='failed', error=?, completed_at=CURRENT_TIMESTAMP WHERE id=?`).run(message, runId);
      getDb().prepare(`UPDATE github_connection SET last_sync_at=CURRENT_TIMESTAMP, last_error=?, updated_at=CURRENT_TIMESTAMP WHERE id=1`).run(message);
    });
    throw e;
  }
}

export async function reviewGithubProposal(id: string, action: 'approve' | 'reject', editedContent?: string): Promise<object> {
  const proposal = getDb().prepare(`SELECT * FROM github_cv_proposals WHERE id=?`).get(id) as any;
  if (!proposal) throw new Error('GitHub CV proposal not found.');
  if (proposal.status !== 'pending') throw new Error(`Proposal is ${proposal.status}, not reviewable.`);
  if (action === 'reject') {
    await runInWriteLock(() => getDb().prepare(`UPDATE github_cv_proposals SET status='rejected', reviewed_at=CURRENT_TIMESTAMP WHERE id=?`).run(id));
    return { id, status: 'rejected' };
  }

  const c = connection();
  const username = c?.github_username || config.githubUsername;
  const repo = (await listPublicRepositories(username)).find(r => r.id === proposal.github_repo_id);
  if (!repo || !isPublicRepository(repo)) throw new Error('Repository is no longer public; approval refused.');

  const evidence = JSON.parse(proposal.evidence_json) as GithubEvidence;
  const editedBullet = editedContent?.trim()
    ? editedProjectBullet(editedContent, evidence.repository_url)
    : null;
  const claimed = await runInWriteLock(() => getDb().prepare(`UPDATE github_cv_proposals SET status='edited' WHERE id=? AND status='pending'`).run(id));
  if (!claimed.changes) throw new Error('Proposal was already reviewed.');

  let packet: Awaited<ReturnType<typeof writeGitHubMergedPacket>>;
  try {
    packet = await writeGitHubMergedPacket(
      latestContent => editedBullet
        ? mergeProjectBullet(latestContent, evidence.repository_url, editedBullet)
        : proposePacketContent(latestContent, repo, evidence),
      `GitHub proposal ${id}; ${proposal.source_url}; commit ${proposal.source_commit_sha}`,
    );
  } catch (error) {
    await runInWriteLock(() => getDb().prepare(
      `UPDATE github_cv_proposals SET status='pending' WHERE id=? AND status='edited'`,
    ).run(id));
    throw error;
  }
  let cvSyncError: string | null = null;
  let livingcvSyncError: string | null = null;
  if (config.githubAutoSyncCv) {
    try { syncPacketToSourceFiles(); } catch (e: any) { cvSyncError = e?.message ?? String(e); }
  }
  if (config.githubAutoSyncLivingcv && (config.livingcvToken || process.env.JOBOPS_LIVINGCV_INTERNAL_SECRET)) {
    try {
      const compiled = await compileCareerPacketJson({ lightcastMode: 'skip' });
      const result = await syncToLivingCV(compiled.content, false, { approvedByUser: true, proposalId: id });
      if (!result.ok) livingcvSyncError = result.error ?? 'LivingCV sync failed';
    } catch (e: any) { livingcvSyncError = e?.message ?? String(e); }
  }
  await runInWriteLock(() => getDb().prepare(`
    UPDATE github_cv_proposals SET status='approved', reviewed_at=CURRENT_TIMESTAMP,
      applied_packet_version=?, cv_sync_error=?, livingcv_sync_error=? WHERE id=?
  `).run(packet.version, cvSyncError, livingcvSyncError, id));
  return { id, status: 'approved', packet_version: packet.version, cv_synced: !cvSyncError,
    livingcv_synced: config.githubAutoSyncLivingcv && !!(config.livingcvToken || process.env.JOBOPS_LIVINGCV_INTERNAL_SECRET) && !livingcvSyncError,
    cv_sync_error: cvSyncError, livingcv_sync_error: livingcvSyncError };
}

export async function setGithubRepositoryIncluded(repoId: number, included: boolean): Promise<void> {
  await runInWriteLock(() => getDb().prepare(`UPDATE github_repositories SET included=?, updated_at=CURRENT_TIMESTAMP WHERE github_repo_id=?`).run(included ? 1 : 0, repoId));
}
