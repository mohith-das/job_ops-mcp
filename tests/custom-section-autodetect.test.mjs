// A `## Heading` in cv.md that isn't one of the 7 standard sections is
// auto-detected and rendered generically once the theme's resume.html
// references {{KEY}}/{{SECTION_KEY}} for it — no server code, no theme JS,
// no config file required.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

let sandbox;
before(async () => {
  sandbox = mkdtempSync(join(tmpdir(), 'jobops-custom-section-'));
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

## Publications
- **Attention Is All You Need** (NeurIPS 2017) — Introduced the Transformer architecture
- **A Second Paper** — no venue, just a description
`);
  writeFileSync(resolve(sandbox, 'config/profile.yml'), `candidate:
  full_name: "Casey Riley"
  email: "casey@example.com"
  location: "Austin, TX"
`);
  writeFileSync(resolve(sandbox, 'portals.yml'), `tracked_companies: []\n`);

  const themeDir = resolve(sandbox, 'themes', 'custom');
  mkdirSync(themeDir, { recursive: true });
  writeFileSync(resolve(themeDir, 'resume.html'), `<!DOCTYPE html>
<html lang="{{LANG}}"><body>
<h1>{{NAME}}</h1>
<div>{{SECTION_SUMMARY}}</div>
<div>{{SUMMARY_TEXT}}</div>
<div class="section-title">{{SECTION_PUBLICATIONS}}</div>
<div>{{PUBLICATIONS}}</div>
</body></html>
`);

  process.env.JOBOPS_DATA_DIR     = resolve(sandbox, 'data');
  process.env.JOBOPS_OUTPUT_DIR   = resolve(sandbox, 'output');
  process.env.JOBOPS_PROJECT_ROOT = sandbox;
  process.env.JOBOPS_TEMPLATE_DIR = resolve(sandbox, 'themes');
  delete process.env.JOBOPS_DEFAULT_TEMPLATE;
});

after(() => { if (sandbox) rmSync(sandbox, { recursive: true, force: true }); });

test('an unrecognized cv.md heading is parsed into CVData.customSections', async () => {
  const { parseCV } = await import('../dist/core/cv_parse.js');
  const cv = parseCV();
  assert.ok(cv.customSections, 'customSections should be populated');
  const pub = cv.customSections.PUBLICATIONS;
  assert.ok(pub, 'PUBLICATIONS key should exist');
  assert.equal(pub.label, 'Publications');
  assert.equal(pub.items.length, 2);
  assert.equal(pub.items[0].title, 'Attention Is All You Need');
  assert.equal(pub.items[0].badge, 'NeurIPS 2017');
  assert.equal(pub.items[0].description, 'Introduced the Transformer architecture');
  assert.equal(pub.items[1].badge, null);
});

test('renderResumeHtml fills {{SECTION_PUBLICATIONS}}/{{PUBLICATIONS}} with generic markup, zero theme config', async () => {
  const { parseCV } = await import('../dist/core/cv_parse.js');
  const { renderResumeHtml } = await import('../dist/core/render.js');
  const cv = parseCV();
  const html = renderResumeHtml(cv, 'custom');

  assert.match(html, /<div class="section-title">Publications<\/div>/, 'auto-derived label from the heading text');
  assert.match(html, /<div class="custom-section-item">/, 'generic item markup is used');
  assert.match(html, /<span class="custom-section-title">Attention Is All You Need<\/span>/);
  assert.match(html, /<span class="custom-section-badge">NeurIPS 2017<\/span>/);
  assert.match(html, /<div class="custom-section-desc">Introduced the Transformer architecture<\/div>/);
  assert.doesNotMatch(html, /\{\{PUBLICATIONS\}\}/, 'placeholder must be substituted, not left literal');
  assert.doesNotMatch(html, /\{\{SECTION_PUBLICATIONS\}\}/);
});
