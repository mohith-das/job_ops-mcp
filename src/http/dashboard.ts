// Single-page HTML tracker (filter + search + sort + server-side pagination) + a /trash page.
// CRUD actions (status change, soft-delete, restore, purge) call the /api/* endpoints in
// http/app.ts, which share the SAME core logic (core/job_trash.ts + core/tracker_query.ts) as
// the MCP chat tools — no duplicated logic here.
import { getDb } from '../db.js';
import { escapeHtml } from '../core/html.js';
import { themeCss, themeInitScript, themeToggleButton } from './theme.js';
import { JOB_STATUSES, listTrashedJobs } from '../core/job_trash.js';
import { queryTracker, pipelineCounts, distinctCompanies, type TrackerSort, type SortDir } from '../core/tracker_query.js';

const ROLE_CATEGORIES = ['pm', 'ml_eng', 'data_eng', 'analytics_eng', 'swe', 'forward_deployed', 'other'];
const PAGE_SIZES = [25, 50, 100];

// ── shared styling + shell ────────────────────────────────────────────────────

function styles(): string {
  return `${themeCss()}
  body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 0; background: var(--bg-page); color: var(--text); }
  header { padding: 1.4rem 1.6rem; border-bottom: 1px solid var(--border); background: var(--bg-card);
           display: flex; justify-content: space-between; align-items: baseline; gap: 1rem; }
  header h1 { margin: 0; font-size: 1.05rem; letter-spacing: 0.04em; text-transform: uppercase; color: var(--accent); }
  header h1 a { color: inherit; }
  header .meta { color: var(--text-muted); font-size: 0.85rem; }
  main { padding: 1.4rem 1.6rem; max-width: 1180px; margin: 0 auto; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 0.75rem; margin-bottom: 1.4rem; }
  .card { background: var(--bg-card); border: 1px solid var(--border); border-radius: 4px; padding: 0.75rem 0.9rem; box-shadow: var(--shadow); }
  .card .n { font-size: 1.4rem; font-weight: 700; color: var(--text); }
  .card .lbl { color: var(--text-2); font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; }
  table { width: 100%; border-collapse: collapse; background: var(--bg-card); border: 1px solid var(--border); box-shadow: var(--shadow); }
  th, td { text-align: left; padding: 0.55rem 0.7rem; border-bottom: 1px solid var(--border-soft);
           font-size: 0.88rem; vertical-align: top; color: var(--text); }
  th { background: var(--bg-soft); text-transform: uppercase; letter-spacing: 0.04em; font-size: 0.72rem; color: var(--text-2); }
  th a { color: inherit; } th a:hover { color: var(--accent); }
  td.meta { color: var(--text-muted); font-size: 0.8rem; }
  tr.removing { opacity: 0.35; transition: opacity 0.25s; }
  .tier { font-weight: 700; padding: 0.1rem 0.5rem; border-radius: 3px; color: var(--tier-fg); display: inline-block; min-width: 1.6em; text-align: center; }
  .tier.a { background: var(--tier-a); } .tier.b { background: var(--tier-b); }
  .tier.c { background: var(--tier-c); } .tier.d { background: var(--tier-d); }
  .tier.muted { background: transparent; color: var(--text-muted); font-weight: 400; }
  .muted { color: var(--text-muted); }
  code { background: var(--code-bg); padding: 0.05rem 0.4rem; border-radius: 2px; font-size: 0.78em; color: var(--text-2); }
  a { color: var(--link); text-decoration: none; } a:hover { text-decoration: underline; }
  .empty { padding: 3rem; text-align: center; color: var(--text-muted); }
  select.status-sel { font: inherit; font-size: 0.8rem; padding: 0.15rem 0.3rem; background: var(--bg-soft);
           color: var(--text); border: 1px solid var(--border); border-radius: 3px; }
  button.act { font: inherit; font-size: 0.78rem; padding: 0.18rem 0.5rem; border: 1px solid var(--border);
           border-radius: 3px; background: var(--bg-soft); color: var(--text-2); cursor: pointer; }
  button.act:hover { border-color: var(--accent); color: var(--text); }
  button.danger { color: #b42318; border-color: #f0b9b3; } button.danger:hover { background: #fee4e2; color: #912018; }
  .toolbar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem; gap: 1rem; flex-wrap: wrap; }
  .banner { background: var(--bg-soft); border: 1px solid var(--border); border-left: 3px solid var(--accent);
            border-radius: 4px; padding: 0.7rem 0.9rem; font-size: 0.85rem; color: var(--text-2); margin-bottom: 1rem; }
  td.actions { white-space: nowrap; } td.actions button + button { margin-left: 0.3rem; }
  .filters { background: var(--bg-card); border: 1px solid var(--border); border-radius: 4px; padding: 0.8rem 0.9rem;
             margin-bottom: 1rem; display: flex; flex-wrap: wrap; gap: 0.6rem 0.9rem; align-items: flex-end; box-shadow: var(--shadow); }
  .filters .f { display: flex; flex-direction: column; gap: 0.2rem; }
  .filters label { font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-2); }
  .filters input, .filters select { font: inherit; font-size: 0.82rem; padding: 0.25rem 0.4rem; background: var(--bg-soft);
             color: var(--text); border: 1px solid var(--border); border-radius: 3px; }
  .filters input.sc { width: 4rem; } .filters input#q { width: 13rem; } .filters input#company { width: 11rem; }
  .filters select[multiple] { min-width: 11rem; height: 4.6rem; }
  .filters .btns { display: flex; gap: 0.4rem; }
  .pager { display: flex; gap: 0.5rem; align-items: center; font-size: 0.85rem; color: var(--text-2); }
  .pager a, .pager span.cur { padding: 0.2rem 0.55rem; border: 1px solid var(--border); border-radius: 3px; background: var(--bg-soft); }
  .pager a.disabled { opacity: 0.4; pointer-events: none; }
  .pager input { width: 3.2rem; font: inherit; padding: 0.2rem 0.3rem; background: var(--bg-soft); color: var(--text); border: 1px solid var(--border); border-radius: 3px; }`;
}

function shell(title: string, body: string, script: string): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8" /><title>${escapeHtml(title)}</title>
${themeInitScript()}<style>${styles()}</style></head>
<body>${themeToggleButton()}${body}<script>${script}</script></body></html>`;
}

const tier = (s: number | null) => {
  if (s == null) return '<span class="tier muted">—</span>';
  if (s >= 85) return `<span class="tier a">${s}</span>`;
  if (s >= 75) return `<span class="tier b">${s}</span>`;
  if (s >= 60) return `<span class="tier c">${s}</span>`;
  return `<span class="tier d">${s}</span>`;
};

function trashedCount(): number {
  return (getDb().prepare(`SELECT COUNT(*) AS n FROM jobs WHERE trashed_at IS NOT NULL`).get() as { n: number }).n;
}

export const COUNT_CARDS: Array<[label: string, key: string]> = [
  ['Sourced', 'sourced'], ['Ready to apply', 'ready_to_apply'], ['Materials drafted', 'materials_drafted'],
  ['Applied', 'applied'], ['Screen', 'screen'], ['Onsite', 'onsite'], ['Offer', 'offer'], ['Rejected', 'rejected'],
];

/** Full-pipeline status counts for the summary cards + /api/counts (always full totals). */
export function countsJson(): Record<string, number> { return pipelineCounts(); }

// ── query-string parsing (shared shape for filters + pagination + sort) ───────

interface DashParams {
  statuses: string[]; min_score?: number; max_score?: number; company: string;
  role: string; seniority: string; q: string; show_trashed: boolean;
  sort: TrackerSort; dir: SortDir; page: number; page_size: number;
}

const asArr = (v: unknown): string[] => v == null ? [] : Array.isArray(v) ? v.map(String) : [String(v)];
const asStr = (v: unknown): string => v == null ? '' : (Array.isArray(v) ? String(v[0] ?? '') : String(v)).trim();
const asNum = (v: unknown): number | undefined => { const s = asStr(v); if (!s) return undefined; const n = Number(s); return Number.isFinite(n) ? n : undefined; };

function parseParams(raw: Record<string, unknown>): DashParams {
  const sortRaw = asStr(raw.sort);
  const sort: TrackerSort = (['score', 'discovered', 'company'] as const).includes(sortRaw as any) ? sortRaw as TrackerSort : 'score';
  const dir: SortDir = asStr(raw.dir) === 'asc' ? 'asc' : 'desc';
  let page_size = asNum(raw.page_size) ?? 50;
  if (!PAGE_SIZES.includes(page_size)) page_size = 50;
  const page = Math.max(1, Math.floor(asNum(raw.page) ?? 1));
  return {
    statuses: asArr(raw.status).filter(s => (JOB_STATUSES as readonly string[]).includes(s)),
    min_score: asNum(raw.min_score), max_score: asNum(raw.max_score),
    company: asStr(raw.company), role: asStr(raw.role), seniority: asStr(raw.seniority),
    q: asStr(raw.q), show_trashed: asStr(raw.trashed) === '1',
    sort, dir, page, page_size,
  };
}

/** Serialize params to a query string, applying overrides (used for pager + sort links). */
function qs(p: DashParams, over: Partial<Record<string, string | number>> = {}): string {
  const u = new URLSearchParams();
  for (const s of p.statuses) u.append('status', s);
  if (p.min_score != null) u.set('min_score', String(p.min_score));
  if (p.max_score != null) u.set('max_score', String(p.max_score));
  if (p.company) u.set('company', p.company);
  if (p.role) u.set('role', p.role);
  if (p.seniority) u.set('seniority', p.seniority);
  if (p.q) u.set('q', p.q);
  if (p.show_trashed) u.set('trashed', '1');
  u.set('sort', p.sort); u.set('dir', p.dir);
  u.set('page', String(p.page)); u.set('page_size', String(p.page_size));
  for (const [k, v] of Object.entries(over)) { if (v === '' || v == null) u.delete(k); else u.set(k, String(v)); }
  return '/?' + u.toString();
}

// ── main tracker ──────────────────────────────────────────────────────────────

export function renderDashboard(raw: Record<string, unknown> = {}): string {
  const p = parseParams(raw);
  const counts = pipelineCounts();
  const trashN = trashedCount();

  const result = queryTracker({
    statuses: p.statuses.length ? p.statuses : undefined,
    min_score: p.min_score, max_score: p.max_score,
    company: p.company || undefined, role_category: p.role || undefined,
    seniority: p.seniority || undefined, q: p.q || undefined, show_trashed: p.show_trashed,
    sort: p.sort, dir: p.dir, limit: p.page_size, offset: (p.page - 1) * p.page_size,
  });
  const totalPages = Math.max(1, Math.ceil(result.total / p.page_size));
  const page = Math.min(p.page, totalPages);

  const cardsHtml = COUNT_CARDS.map(([label, key]) =>
    `<div class="card"><div class="n" data-count="${key}">${(counts as any)[key] ?? 0}</div><div class="lbl">${label}</div></div>`).join('');

  const statusOptions = JOB_STATUSES.map(s =>
    `<option value="${s}"${p.statuses.includes(s) ? ' selected' : ''}>${s}</option>`).join('');
  const roleOptions = ['', ...ROLE_CATEGORIES].map(r =>
    `<option value="${r}"${p.role === r ? ' selected' : ''}>${r || 'any role'}</option>`).join('');
  const sizeOptions = PAGE_SIZES.map(n => `<option value="${n}"${p.page_size === n ? ' selected' : ''}>${n}/page</option>`).join('');
  const companyList = distinctCompanies(400).map(c => `<option value="${escapeHtml(c)}"></option>`).join('');

  const filters = `
  <form class="filters" method="get" action="/" id="filters">
    <input type="hidden" name="sort" value="${p.sort}"><input type="hidden" name="dir" value="${p.dir}">
    <div class="f"><label>Search title / company</label><input id="q" name="q" value="${escapeHtml(p.q)}" placeholder="e.g. engineer" autocomplete="off"></div>
    <div class="f"><label>Company</label><input id="company" name="company" list="companies" value="${escapeHtml(p.company)}" autocomplete="off"><datalist id="companies">${companyList}</datalist></div>
    <div class="f"><label>Status (multi)</label><select name="status" multiple>${statusOptions}</select></div>
    <div class="f"><label>Min score</label><input class="sc" type="number" name="min_score" min="0" max="100" value="${p.min_score ?? ''}"></div>
    <div class="f"><label>Max score</label><input class="sc" type="number" name="max_score" min="0" max="100" value="${p.max_score ?? ''}"></div>
    <div class="f"><label>Role</label><select name="role">${roleOptions}</select></div>
    <div class="f"><label>Seniority</label><input name="seniority" value="${escapeHtml(p.seniority)}" placeholder="any" style="width:7rem"></div>
    <div class="f"><label>Page size</label><select name="page_size" id="page_size">${sizeOptions}</select></div>
    <div class="f"><label>Trashed</label><label style="text-transform:none;font-size:0.8rem"><input type="checkbox" name="trashed" value="1"${p.show_trashed ? ' checked' : ''} id="trashed"> show</label></div>
    <div class="f btns"><button class="act" type="submit">Apply</button><a class="act" href="/">Reset</a></div>
  </form>`;

  const sortableTh = (label: string, key: TrackerSort) => {
    const active = p.sort === key;
    const nextDir = active && p.dir === 'desc' ? 'asc' : 'desc';
    const arrow = active ? (p.dir === 'desc' ? ' ▾' : ' ▴') : '';
    return `<th><a href="${qs(p, { sort: key, dir: nextDir, page: 1 })}">${label}${arrow}</a></th>`;
  };

  const statusSelect = (id: string, current: string) =>
    `<select class="status-sel" data-id="${id}">` +
    JOB_STATUSES.map(s => `<option value="${s}"${s === current ? ' selected' : ''}>${s}</option>`).join('') + `</select>`;

  const tbody = result.items.map((r) => `
    <tr data-id="${r.job_id}">
      <td>${tier(r.score_total)}</td>
      <td>${escapeHtml(r.company_name)}${r.trashed ? ' <span class="muted">(trashed)</span>' : ''}</td>
      <td><a href="${escapeHtml(r.source_url)}" target="_blank" rel="noopener">${escapeHtml(r.title)}</a></td>
      <td>${escapeHtml(r.role_category ?? '')}</td>
      <td>${escapeHtml(r.seniority ?? '')}</td>
      <td>${statusSelect(r.job_id, r.status)}</td>
      <td>${escapeHtml(r.location ?? '')}</td>
      <td>${r.report_url ? `<a href="${escapeHtml(r.report_url)}">report</a>` : '<span class="muted">—</span>'}</td>
      <td>${[
        r.resume_url ? `<a href="${escapeHtml(r.resume_url)}">Res.</a>` : null,
        r.cover_url ? `<a href="${escapeHtml(r.cover_url)}">Cov.</a>` : null,
        (r.resume_tex_url || r.cover_tex_url) ? `<a href="#" onclick="dlTex(event, [${[r.resume_tex_url, r.cover_tex_url].filter(Boolean).map(u => `'${escapeHtml(u)}'`).join(',')}])">TeX</a>` : null
      ].filter(Boolean).join(' ') || '<span class="muted">—</span>'}</td>
      <td class="meta">${escapeHtml((r.discovered_at ?? '').slice(0, 16))}</td>
      <td class="actions"><button class="act danger trash-btn" data-id="${r.job_id}" data-label="${escapeHtml(r.title)} @ ${escapeHtml(r.company_name)}" title="Move to trash (recoverable)">Trash</button></td>
    </tr>`).join('');

  const first = result.total === 0 ? 0 : (page - 1) * p.page_size + 1;
  const last  = Math.min(page * p.page_size, result.total);
  const pager = `
  <div class="pager">
    <a class="${page <= 1 ? 'disabled' : ''}" href="${qs(p, { page: 1 })}">« first</a>
    <a class="${page <= 1 ? 'disabled' : ''}" href="${qs(p, { page: page - 1 })}">‹ prev</a>
    <span class="cur">page ${page} / ${totalPages}</span>
    <a class="${page >= totalPages ? 'disabled' : ''}" href="${qs(p, { page: page + 1 })}">next ›</a>
    <a class="${page >= totalPages ? 'disabled' : ''}" href="${qs(p, { page: totalPages })}">last »</a>
    <span>jump</span><input type="number" id="jump" min="1" max="${totalPages}" value="${page}">
  </div>`;

  const body = `
<header>
  <h1>jobops tracker</h1>
  <span class="meta">${counts.total ?? 0} active · <a href="/trash">trash (${trashN})</a> · /files from output/</span>
</header>
<main>
  <div class="cards">${cardsHtml}</div>
  ${filters}
  <div class="toolbar">
    <span class="meta"><strong data-total>${result.total}</strong> matching${(p.statuses.length || p.q || p.company || p.min_score != null || p.max_score != null || p.role || p.seniority || p.show_trashed) ? ' (filtered)' : ''} · showing ${first}–${last}</span>
    ${pager}
  </div>
  ${result.total === 0 ? `<div class="empty">No jobs match. <a href="/">Reset filters</a>.</div>` : `
    <table>
      <thead><tr>
        ${sortableTh('Score', 'score')}
        ${sortableTh('Company', 'company')}
        <th>Title</th><th>Role</th><th>Level</th><th>Status</th><th>Location</th><th>Report</th><th>Docs</th>
        ${sortableTh('Discovered', 'discovered')}
        <th></th>
      </tr></thead>
      <tbody>${tbody}</tbody>
    </table>`}
</main>`;

  const baseUrl = qs(p);
  const script = `
  const FORM = document.getElementById('filters');
  window.dlTex = function(e, urls) {
    e.preventDefault();
    urls.forEach((u, i) => setTimeout(() => {
      const a = document.createElement('a');
      a.href = u;
      a.download = u.split('/').pop() || 'file.tex';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    }, i * 150));
  };
  async function api(method, url, body) {
    const r = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    if (!r.ok) { const t = await r.text().catch(()=>''); alert('Action failed (' + r.status + '): ' + t); throw new Error(t); }
    return r.json();
  }
  async function refreshCounts() {
    try { const c = await (await fetch('/api/counts')).json();
      document.querySelectorAll('[data-count]').forEach(el => { el.textContent = c[el.dataset.count] ?? 0; }); } catch {}
  }
  function bumpTotal(delta) { const t = document.querySelector('[data-total]'); if (t) t.textContent = Math.max(0, (parseInt(t.textContent,10)||0) + delta); }
  // Auto-submit on these (resets to page 1 since the form has no page field).
  document.getElementById('page_size').addEventListener('change', () => FORM.submit());
  document.getElementById('trashed').addEventListener('change', () => FORM.submit());
  let t; document.getElementById('q').addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => FORM.submit(), 400); });
  const jump = document.getElementById('jump');
  if (jump) jump.addEventListener('keydown', (e) => { if (e.key === 'Enter') { const n = Math.max(1, parseInt(jump.value,10)||1); location.href = ${JSON.stringify(baseUrl)}.replace(/([?&])page=\\d+/, '$1page=' + n); } });
  // Inline status edit + per-row trash — preserve current filter/page (no reload).
  document.addEventListener('change', async (e) => {
    const sel = e.target.closest('select.status-sel'); if (!sel) return;
    await api('POST', '/api/jobs/' + sel.dataset.id + '/status', { status: sel.value });
    const tr = sel.closest('tr'); tr.style.background = 'var(--bg-soft)'; setTimeout(() => { tr.style.background = ''; }, 600);
    refreshCounts();
  });
  document.addEventListener('click', async (e) => {
    const b = e.target.closest('button.trash-btn'); if (!b) return;
    if (!confirm('Move to trash (recoverable): ' + b.dataset.label + '?')) return;
    await api('POST', '/api/jobs/' + b.dataset.id + '/trash');
    const tr = b.closest('tr'); tr.classList.add('removing'); setTimeout(() => tr.remove(), 250);
    bumpTotal(-1); refreshCounts();
  });`;

  return shell('jobops tracker', body, script);
}

// ── /trash page ─────────────────────────────────────────────────────────────--

export function renderTrashPage(): string {
  const items = listTrashedJobs();
  const tbody = items.map((r: any) => `
    <tr data-id="${r.job_id}">
      <td>${tier(r.score_total)}</td>
      <td>${escapeHtml(r.company ?? '')}</td>
      <td>${escapeHtml(r.title ?? '')}</td>
      <td><code>${escapeHtml(r.status ?? '')}</code></td>
      <td class="meta">${escapeHtml((r.trashed_at ?? '').slice(0, 16))}</td>
      <td class="actions">
        <button class="act restore-btn" data-id="${r.job_id}">Restore</button>
        <button class="act danger purge-btn" data-id="${r.job_id}" data-label="${escapeHtml(r.title ?? '')} @ ${escapeHtml(r.company ?? '')}">Delete permanently</button>
      </td>
    </tr>`).join('');

  const body = `
<header>
  <h1><a href="/">jobops tracker</a> › trash</h1>
  <span class="meta"><a href="/">← back to tracker</a></span>
</header>
<main>
  <div class="banner">
    <strong>Trashed (recoverable).</strong> These jobs are hidden from the tracker but not deleted —
    <em>Restore</em> brings one back to its prior state. <em>Delete permanently</em> and <em>Empty trash</em> are
    irreversible hard deletes (a timestamped backup is written to the project root regardless).
  </div>
  <div class="toolbar">
    <span class="meta">${items.length} job(s) in trash</span>
    ${items.length ? `<button class="act danger" id="empty-trash">Empty trash (delete all ${items.length})</button>` : ''}
  </div>
  ${items.length === 0 ? `<div class="empty">Trash is empty.</div>` : `
    <table>
      <thead><tr><th>Score</th><th>Company</th><th>Title</th><th>Prior status</th><th>Trashed</th><th></th></tr></thead>
      <tbody>${tbody}</tbody>
    </table>`}
</main>`;

  const script = `
  async function api(method, url, body) {
    const r = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    if (!r.ok) { const t = await r.text().catch(()=>''); alert('Action failed (' + r.status + '): ' + t); throw new Error(t); }
    return r.json();
  }
  document.addEventListener('click', async (e) => {
    const restore = e.target.closest('button.restore-btn');
    const purge   = e.target.closest('button.purge-btn');
    const empty   = e.target.closest('#empty-trash');
    if (restore) { await api('POST', '/api/jobs/' + restore.dataset.id + '/restore'); restore.closest('tr').remove(); }
    else if (purge) {
      if (!confirm('PERMANENTLY delete: ' + purge.dataset.label + '?\\n\\nThis cannot be undone (a backup is written first).')) return;
      await api('POST', '/api/jobs/' + purge.dataset.id + '/purge'); purge.closest('tr').remove();
    } else if (empty) {
      if (!confirm('PERMANENTLY delete ALL trashed jobs?\\n\\nThis empties the trash and cannot be undone. A timestamped backup is written to the project root first.')) return;
      const r = await api('POST', '/api/trash/purge-all', { confirm: true });
      alert('Permanently deleted ' + r.purged + ' job(s). Backup: ' + (r.backup_path || '(none)')); location.reload();
    }
  });`;

  return shell('jobops trash', body, script);
}
