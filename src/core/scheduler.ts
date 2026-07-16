// Opt-in scheduler. Lives entirely inside this process — no external cron — but stays
// OFF by default. State persists in `scheduler_state.enabled_jobs` (JSON array of names).
//
// Supported jobs:
//   - scan_portals_4h   → runScan() every 4h
//   - batch_evaluate_30m → batch_evaluate (limit 20) every 30m, only when an LLM is configured
//   - followups_due_1h  → no-op; just stamps activity (the chat reads v_followups_due directly)
//   - daily_digest_morning → stamps digest_state at 08:00 local
//   - github_sync_6h      → poll public GitHub repositories every 6h
//
// Concurrency: one tick at a time per job. Misses are not catched up.

import { getDb, runInWriteLock } from '../db.js';
import { runScan } from './scan_engine.js';
import { llmAvailable } from './llm.js';

export type JobName = 'scan_portals_4h' | 'batch_evaluate_30m' | 'followups_due_1h' | 'daily_digest_morning' | 'github_sync_6h';

export const JOB_DEFS: Record<JobName, { intervalMs: number; description: string; }> = {
  scan_portals_4h:       { intervalMs: 4 * 60 * 60 * 1000, description: 'Run scan_portals across all enabled tracked_companies' },
  batch_evaluate_30m:    { intervalMs: 30 * 60 * 1000,     description: 'Batch-rate up to 20 unrated jobs via the configured LLM' },
  followups_due_1h:      { intervalMs:  1 * 60 * 60 * 1000, description: 'Touch state when followups are due (informational)' },
  daily_digest_morning:  { intervalMs: 60 * 60 * 1000,      description: 'Once-per-day digest stamp (08:00 local window)' },
  github_sync_6h:        { intervalMs: 6 * 60 * 60 * 1000,  description: 'Poll public GitHub repositories and create CV proposals' },
};

interface JobRuntime { name: JobName; timer: NodeJS.Timeout; running: boolean; }

const RUNTIME = new Map<JobName, JobRuntime>();

export function readEnabledJobs(): JobName[] {
  const row = getDb().prepare(`SELECT enabled_jobs FROM scheduler_state WHERE id = 1`).get() as { enabled_jobs: string };
  try { return (JSON.parse(row?.enabled_jobs ?? '[]') as JobName[]).filter(n => n in JOB_DEFS); }
  catch { return []; }
}

export async function setEnabledJobs(jobs: JobName[]): Promise<JobName[]> {
  const filtered = [...new Set(jobs)].filter(j => j in JOB_DEFS);
  if (filtered.includes('github_sync_6h')) {
    const connection = getDb().prepare(`SELECT id FROM github_connection WHERE id=1`).get();
    if (!connection) throw new Error('Configure a GitHub username before enabling github_sync_6h.');
  }
  await runInWriteLock(() => {
    const db = getDb();
    db.prepare(`UPDATE scheduler_state SET enabled_jobs = ? WHERE id = 1`).run(JSON.stringify(filtered));
    db.prepare(`UPDATE github_connection SET enabled=?,updated_at=CURRENT_TIMESTAMP WHERE id=1`).run(filtered.includes('github_sync_6h') ? 1 : 0);
  });
  applyState();
  return filtered;
}

export async function setGithubSchedulerEnabled(enabled: boolean): Promise<boolean> {
  const connection = getDb().prepare(`SELECT id FROM github_connection WHERE id=1`).get();
  if (!connection) throw new Error('Configure a GitHub username before enabling automatic sync.');
  const current = readEnabledJobs();
  const next = enabled
    ? [...new Set([...current, 'github_sync_6h' as const])]
    : current.filter((job) => job !== 'github_sync_6h');
  await setEnabledJobs(next);
  return enabled;
}

export async function disableAll(): Promise<void> {
  await runInWriteLock(() => {
    const db = getDb();
    db.prepare(`UPDATE scheduler_state SET enabled_jobs = '[]' WHERE id = 1`).run();
    db.prepare(`UPDATE github_connection SET enabled=0,updated_at=CURRENT_TIMESTAMP WHERE id=1`).run();
  });
  applyState();
}

// Called once at boot (and after enable/disable) — adds new timers, removes stale ones.
export function applyState(): void {
  const enabled = new Set(readEnabledJobs());
  for (const [name, rt] of RUNTIME) {
    if (!enabled.has(name)) {
      clearInterval(rt.timer);
      RUNTIME.delete(name);
    }
  }
  for (const name of enabled) {
    if (RUNTIME.has(name)) continue;
    const def = JOB_DEFS[name];
    const timer = setInterval(() => { void tick(name); }, def.intervalMs);
    timer.unref();      // never block process exit
    RUNTIME.set(name, { name, timer, running: false });
    if (name === 'github_sync_6h') {
      const row = getDb().prepare(`SELECT last_sync_at FROM github_connection WHERE id=1`).get() as { last_sync_at?: string | null } | undefined;
      const last = row?.last_sync_at ? new Date(row.last_sync_at).getTime() : 0;
      if (last && Date.now() - last >= def.intervalMs) queueMicrotask(() => { void tick(name); });
    }
  }
}

// Job-name → handler dispatch table. Adding a job is now one table entry, not another
// branch in `tick`. Lazy imports keep us free of circular module deps.
const JOB_HANDLERS: Record<JobName, () => Promise<void>> = {
  scan_portals_4h: () => runScan({}, { triggeredBy: 'scheduler:scan_portals_4h' }).then(() => undefined),
  batch_evaluate_30m: async () => {
    if (!llmAvailable()) return;
    const { batchEvaluateTool } = await import('../mcp/tools/batch_evaluate.js');
    await batchEvaluateTool.handler({ limit: 20, concurrency: 2 } as any);
  },
  daily_digest_morning: async () => {
    const hour = new Date().getHours();
    if (hour < 7 || hour > 9) return;
    const { dailyDigestTool } = await import('../mcp/tools/ops.js');
    await dailyDigestTool.handler({ dry_run: false, min_score: 75 } as any);
  },
  followups_due_1h: async () => {
    // Slot exists for future hooks (e.g. desktop notif). No work today.
  },
  github_sync_6h: async () => {
    const { runGithubSync } = await import('./github_sync.js');
    await runGithubSync('scheduler:github_sync_6h');
  },
};

async function tick(name: JobName): Promise<void> {
  const rt = RUNTIME.get(name);
  if (!rt || rt.running) return;
  rt.running = true;
  try {
    await JOB_HANDLERS[name]();
    await runInWriteLock(() => {
      getDb().prepare(`UPDATE scheduler_state SET last_run_at = CURRENT_TIMESTAMP, notes = ? WHERE id = 1`).run(`last fired: ${name}`);
    });
  } catch (e: any) {
    // Surface the error rather than silently swallowing — easier to spot when a
    // scheduled run starts hitting an API rate limit or a broken provider.
    // eslint-disable-next-line no-console
    console.error(`[scheduler] ${name} tick failed:`, e?.message ?? e);
  } finally {
    rt.running = false;
  }
}

export function status() {
  const enabled = readEnabledJobs();
  const last = getDb().prepare(`SELECT last_run_at, notes FROM scheduler_state WHERE id = 1`).get() as any;
  const github = getDb().prepare(`SELECT last_sync_at FROM github_connection WHERE id=1`).get() as { last_sync_at?: string | null } | undefined;
  const githubLastMs = github?.last_sync_at ? new Date(github.last_sync_at).getTime() : null;
  return {
    enabled_jobs: enabled,
    runtime: [...RUNTIME.keys()],
    last_run_at: last?.last_run_at ?? null,
    notes:       last?.notes ?? null,
    github_next_run_at: githubLastMs ? new Date(githubLastMs + JOB_DEFS.github_sync_6h.intervalMs).toISOString() : null,
    available_jobs: Object.entries(JOB_DEFS).map(([name, def]) => ({
      name, interval_ms: def.intervalMs, description: def.description,
    })),
  };
}
