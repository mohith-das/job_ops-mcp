import { createHash } from 'node:crypto';
import { config } from '../config.js';

const API = 'https://api.github.com';
const MAX_FILE_BYTES = 200_000;
const EVIDENCE_FILES = ['README.md', 'package.json', 'pyproject.toml', 'requirements.txt', 'Cargo.toml', 'go.mod', 'pom.xml', 'build.gradle'];

export interface PublicRepo {
  id: number; name: string; full_name: string; html_url: string; description: string | null;
  private: boolean; visibility: string; fork: boolean; archived: boolean;
  default_branch: string; pushed_at: string | null; topics?: string[]; homepage?: string | null;
}

export interface GithubEvidence {
  repository: string; repository_url: string; commit_sha: string; description: string;
  topics: string[]; languages: Record<string, number>; technologies: string[];
  readme_summary: string; deployment_url: string | null; evidence_sources: string[];
}

function headers(): Record<string, string> {
  const h: Record<string, string> = {
    Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'jobops-public-github-sync',
  };
  if (config.githubToken) h.Authorization = `Bearer ${config.githubToken}`;
  return h;
}

async function api<T>(path: string): Promise<T> {
  const res = await fetch(`${API}${path}`, { headers: headers(), signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`GitHub API ${res.status} for ${path}`);
  return await res.json() as T;
}

export function isPublicRepository(repo: Pick<PublicRepo, 'private' | 'visibility'>): boolean {
  return repo.private === false && repo.visibility === 'public';
}

export async function getGithubUser(username: string): Promise<{ id: number; login: string }> {
  return api(`/users/${encodeURIComponent(username)}`);
}

export async function listPublicRepositories(username: string): Promise<PublicRepo[]> {
  const all: PublicRepo[] = [];
  for (let page = 1; page <= 10; page++) {
    const rows = await api<PublicRepo[]>(`/users/${encodeURIComponent(username)}/repos?type=public&sort=updated&per_page=100&page=${page}`);
    all.push(...rows.filter(isPublicRepository));
    if (rows.length < 100) break;
  }
  return all;
}

export async function getDefaultBranchSha(repo: PublicRepo): Promise<string> {
  const branch = await api<{ commit: { sha: string } }>(`/repos/${repo.full_name}/branches/${encodeURIComponent(repo.default_branch)}`);
  return branch.commit.sha;
}

async function getTextFile(fullName: string, path: string, ref: string): Promise<string | null> {
  // raw.githubusercontent.com does not consume the REST API quota. `ref` is a commit
  // SHA obtained from the public branch endpoint, so the content is immutable.
  const safePath = path.split('/').map(encodeURIComponent).join('/');
  const res = await fetch(`https://raw.githubusercontent.com/${fullName}/${encodeURIComponent(ref)}/${safePath}`, {
    headers: { 'User-Agent': 'jobops-public-github-sync' }, signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub raw content ${res.status} reading ${fullName}/${path}`);
  const size = Number(res.headers.get('content-length') ?? '0');
  if (size > MAX_FILE_BYTES) return null;
  return (await res.text()).slice(0, MAX_FILE_BYTES);
}

function detectTechnologies(files: Map<string, string>): string[] {
  const out = new Set<string>();
  const pkg = files.get('package.json');
  if (pkg) try {
    const parsed = JSON.parse(pkg);
    for (const k of Object.keys({ ...(parsed.dependencies ?? {}), ...(parsed.devDependencies ?? {}) })) out.add(k);
  } catch { /* malformed public manifest: ignore */ }
  const joined = [...files.values()].join('\n').toLowerCase();
  for (const name of ['fastapi','django','flask','postgresql','pytest','pytorch','tensorflow','react','next.js','typescript','docker','kubernetes']) {
    if (joined.includes(name)) out.add(name);
  }
  return [...out].slice(0, 30);
}

export async function extractGithubEvidence(repo: PublicRepo, sha: string): Promise<GithubEvidence> {
  if (!isPublicRepository(repo)) throw new Error('Refusing to extract a non-public GitHub repository.');
  const files = new Map<string, string>();
  for (const path of EVIDENCE_FILES) {
    const text = await getTextFile(repo.full_name, path, sha);
    if (text != null) files.set(path, text);
  }
  let languages: Record<string, number> = {};
  // Skip this optional API call for unauthenticated users to preserve the 60/hour quota.
  if (config.githubToken) {
    try { languages = await api<Record<string, number>>(`/repos/${repo.full_name}/languages`); } catch { /* optional */ }
  }
  const readme = files.get('README.md') ?? '';
  const summary = readme.replace(/```[\s\S]*?```/g, ' ').replace(/<[^>]+>/g, ' ')
    .replace(/[#*_`>\[\]()]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 600);
  return {
    repository: repo.full_name, repository_url: repo.html_url, commit_sha: sha,
    description: repo.description?.trim() ?? '', topics: repo.topics ?? [], languages,
    technologies: detectTechnologies(files), readme_summary: summary,
    deployment_url: repo.homepage?.trim() || null, evidence_sources: [...files.keys()],
  };
}

export function evidenceHash(evidence: GithubEvidence): string {
  return createHash('sha256').update(JSON.stringify(evidence)).digest('hex');
}
