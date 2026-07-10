// A theme can optionally ship sections.yml to replace the generic default
// markup (and label) for one auto-detected custom section — a declarative,
// no-code override, since most users authoring resumes don't write JS.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

let sandbox;
before(async () => {
  sandbox = mkdtempSync(join(tmpdir(), 'jobops-custom-override-'));
  mkdirSync(resolve(sandbox, 'config'), { recursive: true });
  writeFileSync(resolve(sandbox, 'cv.md'), `# CV — Casey Riley
**Location:** Austin, TX
**Email:** casey@example.com

## Professional Summary
Builder PM with engineering teeth.

## Publications
- **Attention Is All You Need** (NeurIPS 2017) — Introduced the Transformer architecture
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
<div class="section-title">{{SECTION_PUBLICATIONS}}</div>
<div>{{PUBLICATIONS}}</div>
</body></html>
`);
  writeFileSync(resolve(themeDir, 'sections.yml'), `PUBLICATIONS:
  label: "Selected Publications"
  item: |
    <div class="pub"><b>{{title}}</b> — {{badge}} :: {{description}}</div>
  join: "|"
`);

  process.env.JOBOPS_DATA_DIR     = resolve(sandbox, 'data');
  process.env.JOBOPS_OUTPUT_DIR   = resolve(sandbox, 'output');
  process.env.JOBOPS_PROJECT_ROOT = sandbox;
  process.env.JOBOPS_TEMPLATE_DIR = resolve(sandbox, 'themes');
  delete process.env.JOBOPS_DEFAULT_TEMPLATE;
});

after(() => { if (sandbox) rmSync(sandbox, { recursive: true, force: true }); });

test('sections.yml overrides the generic label and item markup', async () => {
  const { parseCV } = await import('../dist/core/cv_parse.js');
  const { renderResumeHtml } = await import('../dist/core/render.js');
  const cv = parseCV();
  const html = renderResumeHtml(cv, 'custom');

  assert.match(html, /<div class="section-title">Selected Publications<\/div>/, 'override label wins over the auto-derived one');
  assert.match(html, /<div class="pub"><b>Attention Is All You Need<\/b> — NeurIPS 2017 :: Introduced the Transformer architecture<\/div>/);
  assert.doesNotMatch(html, /custom-section-item/, 'generic default markup must not appear once an override exists');
});
