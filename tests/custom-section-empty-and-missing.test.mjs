// Two edge cases for the auto-detect fallback:
//   (a) a heading exists in cv.md but has no parseable bullet items — the
//       placeholder must resolve to an empty string, never leak literal
//       "{{...}}" text into a real resume.
//   (b) a placeholder with no matching cv.md heading at all is left intact —
//       same graceful degradation the template contract has always had.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

let sandbox;
before(async () => {
  sandbox = mkdtempSync(join(tmpdir(), 'jobops-custom-edge-'));
  mkdirSync(resolve(sandbox, 'config'), { recursive: true });
  writeFileSync(resolve(sandbox, 'cv.md'), `# CV — Casey Riley
**Location:** Austin, TX
**Email:** casey@example.com

## Professional Summary
Builder PM with engineering teeth.

## Volunteering
Helped out at the local shelter most weekends. No bullets here, just prose.
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
<div class="section-title">{{SECTION_VOLUNTEERING}}</div>
<div class="v">{{VOLUNTEERING}}</div>
<div class="section-title">{{SECTION_PATENTS}}</div>
<div class="p">{{PATENTS}}</div>
</body></html>
`);

  process.env.JOBOPS_DATA_DIR     = resolve(sandbox, 'data');
  process.env.JOBOPS_OUTPUT_DIR   = resolve(sandbox, 'output');
  process.env.JOBOPS_PROJECT_ROOT = sandbox;
  process.env.JOBOPS_TEMPLATE_DIR = resolve(sandbox, 'themes');
  delete process.env.JOBOPS_DEFAULT_TEMPLATE;
});

after(() => { if (sandbox) rmSync(sandbox, { recursive: true, force: true }); });

test('a heading with zero parseable bullets renders empty, not a leaked placeholder', async () => {
  const { parseCV } = await import('../dist/core/cv_parse.js');
  const { renderResumeHtml } = await import('../dist/core/render.js');
  const cv = parseCV();

  assert.ok(cv.customSections?.VOLUNTEERING, 'heading is still registered');
  assert.equal(cv.customSections.VOLUNTEERING.items.length, 0);

  const html = renderResumeHtml(cv, 'custom');
  assert.doesNotMatch(html, /\{\{VOLUNTEERING\}\}/);
  assert.match(html, /<div class="v"><\/div>/, 'body placeholder resolves to empty string');
  assert.doesNotMatch(html, /custom-section-item/);
});

test('a placeholder with no matching cv.md heading is left intact', async () => {
  const { parseCV } = await import('../dist/core/cv_parse.js');
  const { renderResumeHtml } = await import('../dist/core/render.js');
  const cv = parseCV();

  assert.equal(cv.customSections?.PATENTS, undefined);

  const html = renderResumeHtml(cv, 'custom');
  assert.match(html, /\{\{SECTION_PATENTS\}\}/, 'unknown SECTION_ placeholder stays literal');
  assert.match(html, /\{\{PATENTS\}\}/, 'unknown placeholder stays literal, no crash, no error');
});
