# Authoring custom resume / cover-letter themes

`jobops` ships with a default theme that produces ATS-clean, pdflatex-compatible
output. You can author your own themes — for visual style, alternate layouts, multiple
target roles — and the renderer will substitute the same tailored content into them.

This guide is the reference for the placeholder contract a theme must satisfy.

## Quick start

1. Pick a directory to hold your themes, e.g. `~/job-themes/`.
2. Export it:

   ```bash
   export JOBOPS_TEMPLATE_DIR=~/job-themes
   ```

3. Create a theme dir, e.g. `~/job-themes/compact/`, and add any subset of:

   ```
   resume.tex     # LaTeX resume template
   cover.tex      # LaTeX cover-letter template
   resume.html    # HTML resume template (rendered to PDF via Chromium)
   cover.html     # HTML cover-letter template
   ```

4. List what the loader sees:

   ```bash
   npx @mohith_das/jobops templates
   ```

5. Render with it:

   ```jsonc
   // Via the render_pdf MCP tool
   { "job_id": "...", "kind": "both", "formats": ["pdf","tex"], "template": "compact",
     "cover_body": "..." }
   ```

   Or pin it as the default for every call:

   ```bash
   export JOBOPS_DEFAULT_TEMPLATE=compact
   ```

## Search order

When you request `template=<name>`, the loader checks in this order:

1. `$JOBOPS_TEMPLATE_DIR/<name>/`        ← your dir, highest priority
2. `<install>/templates/themes/<name>/`   ← bundled themes

Same-name themes shadow: a `default/` folder in your dir **overrides** the bundled
default for every call (unless an explicit `template=...` argument overrides it again).

## Placeholder contract

Every placeholder the renderer fills is listed below. The substitution is single-pass
and case-sensitive: `{{NAME}}` works, `{{Name}}` is left alone. **A placeholder your
template doesn't reference is simply ignored — drop a placeholder to drop that
section.** A placeholder the renderer doesn't fill becomes empty string.

In `.tex` templates, commenting a placeholder out also drops the section: a
placeholder sitting after an unescaped `%` on its line (e.g. `% {{SUMMARY_SECTION}}`)
is left verbatim instead of substituted, so you can toggle sections on and off
without deleting the line.

The content the renderer injects is already **LaTeX-escaped / HTML-escaped** for the
target format. You should NOT wrap the placeholder in another escape pass.

### `resume.tex`

| Placeholder                  | What gets injected                                                                                                                                                                                                                          |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `{{HEADER}}`                 | `{\huge\bfseries <name>}\\[2pt]\n{\small <contact>}\\[1pt]\n{\small <links>}` — full identity block. Renderer escapes specials and emits `\href{…}{…}` for links.                                                                            |
| `{{SUMMARY_SECTION}}`        | `\section*{Summary}\n<prose>\n` — or empty string when `cv.summary` is empty.                                                                                                                                                               |
| `{{SKILLS_SECTION}}`         | `\section*{Skills}\n<per-category lines>\n` — or empty when no skills.                                                                                                                                                                      |
| `{{EXPERIENCE_SECTION}}`     | `\section*{Experience}\n<per-role blocks>\n`. Each role: company \hfill period, role + location, then `\begin{itemize}…\end{itemize}` bullets.                                                                                              |
| `{{PROJECTS_SECTION}}`       | `\section*{Projects}\n<per-project blocks>\n`. Each project: bold title, optional badge, em-dash, description, optional tech footnote.                                                                                                      |
| `{{EDUCATION_SECTION}}`      | `\section*{Education}\n<per-school blocks>\n`.                                                                                                                                                                                              |
| `{{CERTIFICATIONS_SECTION}}` | Empty by default — `jobops` does not surface certifications from `cv.md` at this layer. Custom themes that want a hard-coded section can ignore this placeholder and write the section verbatim, or omit it.                          |

Minimal valid `resume.tex`:

```tex
\documentclass[letterpaper,11pt]{article}
\usepackage[T1]{fontenc}
\usepackage[utf8]{inputenc}
\usepackage{enumitem}
\usepackage[hidelinks]{hyperref}
\setlength{\parindent}{0pt}
\sloppy
\setlength{\emergencystretch}{3em}
\pagestyle{empty}
\raggedright
\begin{document}
{{HEADER}}

{{SUMMARY_SECTION}}
{{EXPERIENCE_SECTION}}
{{EDUCATION_SECTION}}
\end{document}
```

That theme drops Skills + Projects entirely. The renderer doesn't complain — degrading
gracefully is the point.

### `cover.tex`

| Placeholder       | What gets injected                                                                              |
| ----------------- | ----------------------------------------------------------------------------------------------- |
| `{{HEADER}}`      | `{\large\bfseries <name>}\\` followed by `{\small <contact>}`                                   |
| `{{DATE}}`        | A formatted absolute date, e.g. `January 5, 2026`                                               |
| `{{ADDRESS}}`     | `Hiring Team\\<Company, Location>` — LaTeX-escaped                                              |
| `{{GREETING}}`    | `Dear Hiring Manager,`                                                                          |
| `{{BODY}}`        | Cover body split into paragraphs (double-blank line separated). Each paragraph LaTeX-escaped.   |
| `{{SIGNATURE}}`   | `Best regards,\\<name>` — LaTeX-escaped                                                         |

### `resume.html`

The HTML resume uses fine-grained placeholders so a theme author can rearrange
markup freely. The CSS lives inside `<style>` blocks in the template — the renderer
does not touch it.

| Placeholder | Content |
| --- | --- |
| `{{LANG}}` | `"en"` |
| `{{NAME}}` | Candidate name (HTML-escaped via container; emit the raw placeholder) |
| `{{PHONE}}` | Plain phone string |
| `{{EMAIL}}` | Plain email string |
| `{{LINKEDIN_URL}}`, `{{LINKEDIN_DISPLAY}}` | URL + display label for the link |
| `{{PORTFOLIO_URL}}`, `{{PORTFOLIO_DISPLAY}}` | URL + display label |
| `{{LOCATION}}` | Candidate location |
| `{{PAGE_WIDTH}}` | CSS length used in the default page wrapper (`7.4in`) |
| `{{SECTION_SUMMARY}}`, `{{SECTION_COMPETENCIES}}`, `{{SECTION_EXPERIENCE}}`, `{{SECTION_PROJECTS}}`, `{{SECTION_EDUCATION}}`, `{{SECTION_CERTIFICATIONS}}`, `{{SECTION_SKILLS}}` | Section title strings — change these if you want different labels |
| `{{SUMMARY_TEXT}}` | Prose summary (already HTML-escaped) |
| `{{COMPETENCIES}}` | Pre-rendered `<span class="competency-tag">…</span>` chips, joined |
| `{{EXPERIENCE}}` | Pre-rendered `.job` blocks |
| `{{PROJECTS}}` | Pre-rendered `.project` blocks |
| `{{EDUCATION}}` | Pre-rendered `.edu-item` blocks |
| `{{CERTIFICATIONS}}` | Pre-rendered `.cert-item` blocks (or a single muted dash when none) |
| `{{SKILLS}}` | Pre-rendered `.skills-grid` |

The pre-rendered blocks reference the CSS classes used by the bundled default. If
your CSS uses different class names, you'll need to copy the bundled markup as a
starting point and adapt — the block markup is part of the renderer, not the
template, so a single class change in your theme won't reach the inner elements.

### `cover.html`

| Placeholder | Content |
| --- | --- |
| `{{NAME}}` | Candidate name |
| `{{CONTACT_LINE}}` | `phone · email · linkedin · portfolio`, HTML-escaped, ` &nbsp;·&nbsp; ` separated |
| `{{DATE}}` | ISO date (`2026-06-02`) |
| `{{COMPANY}}` | Company name (HTML-escaped) |
| `{{COMPANY_LOCATION}}` | `, Remote` or empty — prefixed comma already included |
| `{{BODY}}` | Paragraph-broken cover body wrapped in `<p>…</p>` per paragraph |

## Adding a custom section (Publications, Patents, Volunteering, …)

`resume.html` isn't limited to the 7 placeholders above. Any `## Heading` you add
to your own `cv.md` that isn't one of the standard sections (Summary, Work
Experience, Projects, Education, Certifications, Skills) is **auto-detected** and
becomes available as a placeholder — no code, no theme file, no new dependency.
This is entirely markdown + HTML; nothing here requires knowing JavaScript.

### The two-step version

1. Add a heading + bullets to `cv.md`, using the same bullet grammar Projects
   already uses:

   ```markdown
   ## Publications
   - **Attention Is All You Need** (NeurIPS 2017) — Introduced the Transformer architecture
   - **A Second Paper** — description with no venue/badge is fine too
   ```

2. Reference it in your theme's `resume.html`, wherever you want it to appear:

   ```html
   <div class="section">
     <div class="section-title">{{SECTION_PUBLICATIONS}}</div>
     {{PUBLICATIONS}}
   </div>
   ```

Render a resume and the section appears — title, optional `(badge)`, and
description per bullet, `**bold**` rendered as `<strong>`, everything escaped.
Style it with a `.custom-section-item` / `.custom-section-title` /
`.custom-section-badge` / `.custom-section-desc` rule in your theme's `<style>`
block, same as any other section.

### How the heading becomes a placeholder name

Uppercase the heading, turn every run of non-alphanumeric characters into `_`,
trim leading/trailing underscores: `"Publications"` → `PUBLICATIONS`,
`"Open Source Contributions"` → `OPEN_SOURCE_CONTRIBUTIONS`. The label
placeholder is always `SECTION_` + that key, and defaults to the heading text
exactly as you wrote it. A heading with no bullets that parse still registers
the section (so `{{SECTION_X}}` still fills in) but `{{X}}` renders as an empty
string — it never leaves a literal `{{X}}` in a PDF you're about to send out. A
placeholder with **no** matching heading at all is left untouched, same as any
placeholder your template references that nothing fills.

### Optional: custom markup via `sections.yml`

If you want different HTML per item than the generic block above — no code,
still just markup — drop a `sections.yml` (or `.yaml`) next to `resume.html` in
your theme directory:

```yaml
PUBLICATIONS:
  label: "Selected Publications"     # optional — overrides the auto-derived label
  item: |
    <div class="publication">
      <span class="publication-title">{{title}}</span>
      <span class="publication-venue">{{badge}}</span>
      <div class="publication-desc">{{description}}</div>
    </div>
  join: "\n    "                      # optional — how items are joined; defaults to this
```

`{{title}}`, `{{badge}}`, `{{description}}` (lowercase — distinct from the
page-level `{{ALL_CAPS}}` placeholders) are filled per bullet item, escaped the
same way the bundled sections are. This only overrides the *markup* for
auto-detected sections — it can't restyle the structure of the 7 standard
sections, which are already themable via CSS against their existing class names
(see the `resume.html` table above).

### Worked example: fixing your own dangling placeholder

If your `resume.html` already references a placeholder that's never rendered
anything — for example a `jakes`-style theme with `{{SECTION_ENTREPRENEURIAL}}`
and `{{ENTREPRENEURIAL}}` in the markup but no matching `## Entrepreneurial`
section in `cv.md` — today those placeholders just sit there unfilled. Add the
heading to your `cv.md`:

```markdown
## Entrepreneurial
- **Side Project Co** (Founder, 2019–2021) — Built and sold a small SaaS tool
```

Render again and the section appears — no theme edit, no server update, just
the heading.

## .docx

`docx` artifacts are generated programmatically and **do not use themes**. The Word
file follows a fixed Calibri / heading-style layout for ATS friendliness. If you need
visual variation for .docx, edit the resulting file in Word.

This is intentional — Word's binary OOXML doesn't templatize well, and a third
template format would split the placeholder contract.

## Hard rules — what themes cannot bypass

These run regardless of which theme you select:

- **Visa-leakage scan** (`scanForVisaLeakage`) — applied to `cover_body` **before**
  any file is written. A theme cannot inject visa/work-auth language because the
  scan runs on the *inputs*, not the *outputs*. The renderer also re-scans the
  full `cover.tex` after substitution for defence-in-depth.
- **ATS-clean / light-background PDFs** — the bundled default uses light background
  + dark text. Custom themes that set a dark page background may fail ATS parsers
  that strip backgrounds before OCR. Test against your target ATS before relying
  on a dark theme for submitted applications.
- **No template injection** — placeholders are matched against the strict pattern
  `\{\{[A-Z0-9_]+\}\}` and substituted single-pass, so a value that happens to
  contain `{{X}}` is treated as literal text. There is no recursive expansion.

## Error semantics

| What | Behaviour |
| --- | --- |
| Theme directory not found | `Unknown template theme "<name>". Available: <list>. Searched <dirs>.` Tool returns this string, no partial output is written. |
| Theme present but missing the requested file (e.g. asked for `cover.html`, theme only ships `resume.tex`) | `Theme "<name>" (<source>, at <dir>) is missing <file>. Files present: <list>.` |
| Template empty / no `\documentclass` / no `\begin{document}` / no `<html>` tag | Single-line error naming the theme + file path. The renderer **never** ships a half-broken artifact to disk. |
| Template references a placeholder the renderer doesn't fill | `.tex`: replaced with empty string. `resume.html`: an unrecognized, non-custom-section placeholder is left in the output verbatim (for debugging); a recognized custom-section placeholder whose heading has no parseable bullets renders as empty string. Neither case is an error. |
| Renderer fills a placeholder the template doesn't reference | Silently dropped. No error. |
| `sections.yml`/`.yaml` present but not a mapping, or an entry missing a string `item` | `Theme "<name>" sections.yml at <path>: ...` — single-line error naming the theme + file, same style as the other template errors. No partial output is written. |
| Configured `JOBOPS_DEFAULT_TEMPLATE` doesn't exist on disk | Stderr warning, falls back to `"default"`. The server still boots. |

## Verifying a custom theme

Before relying on a theme for real applications:

```bash
# 1. Render through the tool, both kinds, all formats.
#    (Inside your MCP client / chat client — render_pdf with template="<name>".)

# 2. Compile the .tex with vanilla pdflatex and confirm zero overfull \hbox.
pdflatex -interaction=nonstopmode resume.tex
grep -c 'Overfull \\hbox' resume.log    # expect 0

# 3. Open the .pdf and visually check that:
#    - Header, contact line, links are readable
#    - All experience bullets are present + un-truncated
#    - No content runs off the page
#    - Light background, dark text (ATS)

# 4. Test against your target ATS if you have one (Greenhouse / Workday parsers
#    are publicly accessible test endpoints for parser-side previews).
```

The bundled `scripts/layout-check.mjs` exercises the default theme with both short
and long content and asserts zero overfull boxes. Copy it as a starting point if
you want CI verification for your own themes.

## Where to ask for help

If a custom theme produces a non-obvious error, run with `JOBOPS_DEBUG=1` (TODO)
or paste the renderer's error line into an issue. The error always quotes the
theme name + the file path, so issues with the loader are unambiguous to triage.
