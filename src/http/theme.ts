// Shared light/dark theme primitives for the web-served HTML surfaces ONLY:
//   - the tracker dashboard at `/`
//   - the eval report HTML at `/files/reports/*.html`
//
// NOT for PDF templates (templates/cv-template.html / cover-template.html) — those must
// stay light/white-background for printing and sending to employers.
//
// Three exports — drop them into any page:
//
//   themeInitScript()    → goes into <head> BEFORE any styles. Sets data-theme on <html>
//                          synchronously to prevent flash-of-wrong-theme (FOUC).
//   themeCss()           → CSS variables for :root (light) + [data-theme="dark"]. Tokens
//                          everything downstream references via var(--*).
//   themeToggleButton()  → fixed-position sun/moon button (top-right). Inline onclick
//                          flips the attribute + writes to localStorage. No framework.
//
// The toggle state is shared across dashboard + reports because both pages read the same
// localStorage key (`jobops-theme`) on load.

const STORAGE_KEY = 'jobops-theme';

/** Goes into <head> BEFORE styles. Runs synchronously to set the attribute pre-paint. */
export function themeInitScript(): string {
  const favicon = `data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="white" rx="20"/><text x="50" y="52" font-family="Arial, sans-serif" font-weight="bold" font-size="70" dominant-baseline="middle" text-anchor="middle"><tspan fill="red">J</tspan><tspan fill="violet">O</tspan></text></svg>`;
  return `<link rel="icon" href='${favicon}' type="image/svg+xml">
<script>(function(){try{var t=localStorage.getItem('${STORAGE_KEY}');if(!t){t=window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';}document.documentElement.setAttribute('data-theme',t);}catch(e){}})();</script>`;
}

/** CSS variables. Everything else in the page references var(--*) — no hardcoded colours. */
export function themeCss(): string {
  return `
:root {
  --bg-page:     #fafbfc;
  --bg-card:     #ffffff;
  --bg-soft:     #f6f6f8;
  --text:        #1a1a2e;
  --text-2:      #555;
  --text-muted:  #777;
  --border:      #e2e2e2;
  --border-soft: #f0f0f0;
  --accent:      hsl(187, 74%, 32%);
  --accent-soft: hsl(187, 40%, 92%);
  --accent-fg:   #ffffff;
  --link:        hsl(270, 70%, 45%);
  --code-bg:     #f0f0f3;
  --code-border: #d0d0d4;
  --pre-bg:      #f6f6f8;
  --pre-border:  #cccccc;
  --shadow:      0 1px 2px rgba(0,0,0,0.04);
  --tier-a:      hsl(140, 60%, 38%);
  --tier-b:      hsl(195, 60%, 42%);
  --tier-c:      hsl(36,  80%, 45%);
  --tier-d:      hsl(8,   55%, 50%);
  --tier-fg:     #ffffff;
  color-scheme:  light;
}

[data-theme="dark"] {
  --bg-page:     #15181c;
  --bg-card:     #1d2026;
  --bg-soft:     #23272f;
  --text:        #e8e8ec;
  --text-2:      #aab2c0;
  --text-muted:  #7a8290;
  --border:      #2c3038;
  --border-soft: #23272f;
  --accent:      hsl(187, 60%, 60%);
  --accent-soft: hsla(187, 60%, 60%, 0.14);
  --accent-fg:   #0e1115;
  --link:        hsl(270, 80%, 75%);
  --code-bg:     #2a2e36;
  --code-border: #3a3f48;
  --pre-bg:      #1a1d22;
  --pre-border:  #2c3038;
  --shadow:      0 1px 2px rgba(0,0,0,0.4);
  --tier-a:      hsl(140, 50%, 50%);
  --tier-b:      hsl(195, 60%, 55%);
  --tier-c:      hsl(36,  75%, 55%);
  --tier-d:      hsl(8,   55%, 58%);
  --tier-fg:     #0e1115;
  color-scheme:  dark;
}

/* ── theme toggle (fixed top-right on both pages) ───────────────────────── */
.theme-toggle {
  position: fixed;
  top: 0.9rem;
  right: 0.9rem;
  z-index: 100;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  border: 1px solid var(--border);
  background: var(--bg-card);
  color: var(--text-2);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  box-shadow: var(--shadow);
  transition: background 0.15s, color 0.15s, border-color 0.15s, transform 0.15s;
  padding: 0;
}
.theme-toggle:hover    { color: var(--accent); border-color: var(--accent); transform: scale(1.05); }
.theme-toggle:focus    { outline: 2px solid var(--accent); outline-offset: 2px; }
.theme-toggle svg      { width: 18px; height: 18px; }
.theme-toggle .icon-sun  { display: none; }
.theme-toggle .icon-moon { display: inline; }
[data-theme="dark"] .theme-toggle .icon-sun  { display: inline; }
[data-theme="dark"] .theme-toggle .icon-moon { display: none; }
`;
}

/** Sun/moon button with inline onclick — flips data-theme + persists. */
export function themeToggleButton(): string {
  const onclick =
    `(function(){var d=document.documentElement,c=d.getAttribute('data-theme')==='dark'?'light':'dark';d.setAttribute('data-theme',c);try{localStorage.setItem('${STORAGE_KEY}',c);}catch(e){}})()`;
  // SVGs are sized via .theme-toggle svg in themeCss().
  return `
<button class="theme-toggle" type="button" aria-label="Toggle light/dark theme" title="Toggle light/dark theme" onclick="${onclick}">
  <svg class="icon-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z"/></svg>
  <svg class="icon-sun"  viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>
</button>
`;
}
