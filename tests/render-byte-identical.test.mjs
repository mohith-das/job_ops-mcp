// Regression guard for the "zero visual change" requirement: renderResumeHtml
// output for the bundled `default` theme, given a fixed CVData fixture, must
// hash to exactly the same sha256 it did before the section-registry refactor
// (captured by temporarily exporting the pre-refactor renderResumeHtml and
// hashing its raw output for this same fixture — see the plan for how).
//
// The user's personal ~/job-themes/jakes theme was verified the same way as
// a manual step (not committed here — it lives outside the repo, so a
// portable/CI-safe test can't depend on it). Its pre-refactor hash was
// 6312f49908e33294bac643f2a154a5931ee2c9bbde0a1439e01c2cab395dcded.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const PRE_REFACTOR_SHA256 = {
  default: '31936ef6add9a55c29caae3d41bc287ba393103790dc489e0db8bdb1bd32db1f',
};

let sandbox;
before(async () => {
  sandbox = mkdtempSync(join(tmpdir(), 'jobops-byte-identical-'));
  mkdirSync(resolve(sandbox, 'config'), { recursive: true });
  writeFileSync(resolve(sandbox, 'cv.md'), `# CV — Casey Riley
**Location:** Austin, TX
**Email:** casey@example.com
**Phone:** +1 555 0100
**LinkedIn:** linkedin.com/in/casey
**GitHub:** github.com/casey

## Professional Summary
Builder PM with engineering teeth.

## Work Experience

### Vellum — Product Manager, Agents
Remote · Jan 2024 – Present
- Owned the agentic workflows surface end-to-end
- Shipped a trace-replay tool used daily

### Mosaic — Senior Analyst
NYC · Jun 2021 – Dec 2023
- Built a customer cohort dashboard
- Migrated reporting pipeline from cron to Airflow

## Projects & Open Source
- **Vector Agents** (Open source) — multi-agent eval harness

## Education
- **MS Data Science**, UT Austin — 2021

## Skills
- **AI / LLM Systems:** LangChain, RAG, evals
- **Data:** SQL, Python, Airflow
`);
  writeFileSync(resolve(sandbox, 'config/profile.yml'), `candidate:
  full_name: "Casey Riley"
  email: "casey@example.com"
  phone: "+1 555 0100"
  location: "Austin, TX"
  linkedin: "linkedin.com/in/casey"
  github: "github.com/casey"
`);
  writeFileSync(resolve(sandbox, 'portals.yml'), `tracked_companies: []\n`);

  process.env.JOBOPS_PROJECT_ROOT = sandbox;
  delete process.env.JOBOPS_TEMPLATE_DIR;
  delete process.env.JOBOPS_DEFAULT_TEMPLATE;
});

after(() => { if (sandbox) rmSync(sandbox, { recursive: true, force: true }); });

test('default theme renders byte-identical to the pre-refactor output', async () => {
  const { parseCV } = await import('../dist/core/cv_parse.js');
  const { renderResumeHtml } = await import('../dist/core/render.js');
  const cv = parseCV();

  const html = renderResumeHtml(cv, 'default');
  const hash = createHash('sha256').update(html).digest('hex');
  assert.equal(hash, PRE_REFACTOR_SHA256.default, 'default theme output must not change one byte');
  assert.equal(cv.customSections, undefined, 'a plain cv.md with only standard headings has no custom sections');
});
