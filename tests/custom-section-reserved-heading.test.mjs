// Headings already owned by a dedicated parser (Summary, Work Experience,
// Projects, Education, Certifications, Skills — including their aliases)
// must never leak into CVData.customSections, even when a genuinely new
// heading is present alongside them in the same cv.md.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

let sandbox;
before(async () => {
  sandbox = mkdtempSync(join(tmpdir(), 'jobops-reserved-heading-'));
  mkdirSync(resolve(sandbox, 'config'), { recursive: true });
  writeFileSync(resolve(sandbox, 'cv.md'), `# CV — Casey Riley
**Location:** Austin, TX
**Email:** casey@example.com

## Professional Summary
Builder PM with engineering teeth.

## Work Experience
### Vellum — Product Manager
Remote · 2024 – Present
- Owned the agentic workflows surface

## Projects & Open Source
- **Vector Agents** (Open source) — multi-agent eval harness

## Education
- **MS Data Science**, UT Austin — 2021

## Certifications
- **AWS Certified**, Amazon — 2022

## Skills
- **AI / LLM Systems:** LangChain, RAG, evals

## Publications
- **Attention Is All You Need** (NeurIPS 2017) — Introduced the Transformer architecture
`);
  writeFileSync(resolve(sandbox, 'config/profile.yml'), `candidate:
  full_name: "Casey Riley"
  email: "casey@example.com"
  location: "Austin, TX"
`);
  writeFileSync(resolve(sandbox, 'portals.yml'), `tracked_companies: []\n`);

  process.env.JOBOPS_DATA_DIR     = resolve(sandbox, 'data');
  process.env.JOBOPS_OUTPUT_DIR   = resolve(sandbox, 'output');
  process.env.JOBOPS_PROJECT_ROOT = sandbox;
  delete process.env.JOBOPS_TEMPLATE_DIR;
  delete process.env.JOBOPS_DEFAULT_TEMPLATE;
});

after(() => { if (sandbox) rmSync(sandbox, { recursive: true, force: true }); });

test('standard section headings never appear in customSections', async () => {
  const { parseCV } = await import('../dist/core/cv_parse.js');
  const cv = parseCV();

  assert.ok(cv.customSections, 'the one genuinely new heading is still detected');
  assert.deepEqual(Object.keys(cv.customSections), ['PUBLICATIONS']);
  for (const reserved of ['SUMMARY', 'EXPERIENCE', 'WORK_EXPERIENCE', 'PROJECTS', 'EDUCATION', 'CERTIFICATIONS', 'SKILLS']) {
    assert.equal(cv.customSections[reserved], undefined, `${reserved} must not be a custom section`);
  }
  // And the standard parsers still populated their typed fields normally.
  // (parseCertifications is a pre-existing no-op stub — see cv_parse.ts — so
  // the heading being reserved is what we're asserting, not that it parses.)
  assert.equal(cv.experiences.length, 1);
  assert.equal(cv.projects.length, 1);
  assert.equal(cv.education.length, 1);
  assert.equal(cv.certifications.length, 0);
  assert.equal(cv.skills.length, 1);
});
