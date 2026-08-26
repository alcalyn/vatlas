/**
 * The console stylesheet, inlined into every page.
 *
 * Tokens are copied from site/src/styles/tokens.css rather than shared, to keep the two builds
 * separate. Same palette and type scale.
 *
 * Smaller radii than the site (4-6px), ruled panels and flat chrome: this is a tool used all day.
 *
 * Same constraints as the site: no gradients, no backdrop blur, no webfont. Code panels stay dark in
 * both themes.
 */
export const STYLES = `
:root {
  --bg:#ffffff; --bg-soft:#f7f8fb; --surface:#ffffff; --surface-2:#f2f4fa;
  --border:#e3e7f0; --border-strong:#c9d1e0;
  --text:#0f1219; --text-muted:#3c4457; --text-dim:#59627a;
  --accent:#16457a; --accent-hover:#0f3560; --accent-contrast:#ffffff;
  --accent-soft:#eef2f8; --accent-border:#cdd8e8;
  --success:#2f7a00; --warning:#a35a00; --danger:#c02a20;
  --code-bg:#0d1017; --code-surface:#171b24; --code-border:#262c3a;
  --code-text:#e7eaf3; --code-dim:#8f99b1; --code-str:#b8e94f; --code-flag:#5ad7f5;
  --radius-sm:4px; --radius:6px; --radius-lg:8px;
  --header-h:56px; --sidebar-w:236px;
  --font-sans:system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;
  --font-mono:ui-monospace,SFMono-Regular,'SF Mono',Menlo,Consolas,monospace;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme='light']) {
    --bg:#0b0d12; --bg-soft:#0e1017; --surface:#12151d; --surface-2:#1a1e28;
    --border:#242936; --border-strong:#353c4d;
    --text:#eef1f7; --text-muted:#b6bece; --text-dim:#949db1;
    --accent:#83aee0; --accent-hover:#9cc0ea; --accent-contrast:#0b0d12;
    --accent-soft:#141b26; --accent-border:#2c3d57;
    --success:#a7e34a; --warning:#ffb020; --danger:#ff6a5e;
  }
}
/* The explicit choice, under the same vatlas-theme key as the site. After the media query so the
   toggle wins both ways. */
:root[data-theme='dark'] {
    --bg:#0b0d12; --bg-soft:#0e1017; --surface:#12151d; --surface-2:#1a1e28;
    --border:#242936; --border-strong:#353c4d;
    --text:#eef1f7; --text-muted:#b6bece; --text-dim:#949db1;
    --accent:#83aee0; --accent-hover:#9cc0ea; --accent-contrast:#0b0d12;
    --accent-soft:#141b26; --accent-border:#2c3d57;
    --success:#a7e34a; --warning:#ffb020; --danger:#ff6a5e;
}

*,*::before,*::after { box-sizing:border-box; }
body { margin:0; background:var(--bg); color:var(--text); font-family:var(--font-sans); line-height:1.6; }
a { color:var(--accent); }
h1,h2,h3 { font-weight:700; letter-spacing:-0.01em; line-height:1.3; margin:0 0 .4rem; }
h1 { font-size:1.35rem; }
h2 { font-size:.95rem; }
h3 { font-size:.9rem; }
p { margin:0 0 1rem; }
.muted { color:var(--text-muted); }
.dim { color:var(--text-dim); font-size:.85rem; }
/* Fluid width: tables and JSON bodies use the whole window. */
.container { width:100%; padding-inline:1.25rem; }
.sr-only { position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0 0 0 0); white-space:nowrap; }

/* -- header -- */

header.bar {
  position:sticky; top:0; z-index:50; height:var(--header-h);
  border-bottom:1px solid var(--border); background:var(--surface);
}
.bar__inner { display:flex; align-items:center; gap:1.5rem; height:100%; }
.brand { display:flex; align-items:baseline; gap:.5rem; text-decoration:none; color:var(--text); }
.brand__mark { align-self:center; flex:0 0 auto; border-radius:var(--radius-sm); }
.brand__name { font-weight:700; letter-spacing:-0.01em; font-size:1.05rem; }
/* The host label, secondary to the product name. */
.brand__sub { color:var(--text-dim); font-size:.9rem; font-weight:400; }
.bar nav { display:flex; gap:1.25rem; align-items:center; flex-wrap:wrap; margin-left:auto; }
.bar nav a, .bar nav button {
  color:var(--text-muted); text-decoration:none; background:none;
  border:0; padding:0; font:inherit; font-size:.875rem; cursor:pointer;
}
.bar nav a:hover, .bar nav button:hover { color:var(--text); }
/* The link back to the website, with an arrow. */
.bar__out::after { content:'\\2197'; margin-left:.2rem; font-size:.85em; }

.bar__tools { display:flex; align-items:center; gap:.5rem; }
.iconbtn {
  display:inline-flex; align-items:center; justify-content:center; gap:.5rem;
  min-width:34px; height:34px; padding:0 .5rem;
  border:1px solid var(--border-strong); border-radius:var(--radius-sm);
  background:var(--surface); color:var(--text-muted);
  font-size:.85rem; font-family:var(--font-mono); cursor:pointer; list-style:none;
}
.iconbtn::-webkit-details-marker { display:none; }
.iconbtn:hover { color:var(--accent); border-color:var(--accent); }
.iconbtn:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
.iconbtn__icon { font-size:1rem; line-height:1; font-family:var(--font-sans); }

.langmenu { position:relative; }
.langmenu__list {
  position:absolute; right:0; top:calc(100% + 6px); z-index:60; min-width:168px;
  display:flex; flex-direction:column; padding:.25rem;
  background:var(--surface); border:1px solid var(--border-strong);
  border-radius:var(--radius); box-shadow:0 8px 24px rgb(0 0 0 / 10%);
}
.langmenu__item {
  display:flex; align-items:center; gap:.75rem; width:100%; text-align:left;
  padding:.4rem .6rem; border:0; border-radius:var(--radius-sm); background:none;
  color:var(--text-muted); font:inherit; font-size:.9rem; cursor:pointer;
}
.langmenu__item:hover { background:var(--surface-2); color:var(--text); }
.langmenu__item.is-current { color:var(--accent); font-weight:600; cursor:default; opacity:1; }
/* Flag emoji in the menu and its button. The UI font has no glyph for regional indicator pairs, so
   emoji fonts are listed. Windows has no flag glyphs and shows the two letters. */
.langmenu__flag, .langmenu__code {
  font-family:"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif;
  font-size:1.05rem; line-height:1;
}

/* The account menu: a details dropdown, works without JavaScript. */
.account { position:relative; }
.account > summary {
  display:flex; align-items:center; gap:.5rem; cursor:pointer; list-style:none;
  border:1px solid var(--border); border-radius:var(--radius-sm); padding:.2rem .5rem .2rem .2rem;
  color:var(--text-muted); font-size:.875rem;
}
.account > summary::-webkit-details-marker { display:none; }
.account > summary:hover { color:var(--text); border-color:var(--border-strong); }
.account > summary:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
.account__email { max-width:16rem; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.account__caret { border:solid currentColor; border-width:0 1.5px 1.5px 0; padding:2px; transform:rotate(45deg) translateY(-1px); }
.account[open] > summary { color:var(--text); border-color:var(--border-strong); }
.account[open] .account__caret { transform:rotate(-135deg) translateY(-1px); }
.avatar {
  width:26px; height:26px; border-radius:var(--radius-sm); background:var(--accent-soft);
  border:1px solid var(--accent-border); color:var(--accent);
  display:flex; align-items:center; justify-content:center; font-weight:700; font-size:.8rem;
  flex:0 0 auto; text-transform:uppercase;
}
/* No padding, clipped to its corners, so a highlighted row spans the full width. Rows carry the
   horizontal padding. */
.menu {
  position:absolute; right:0; top:calc(100% + .4rem); z-index:20; min-width:14rem;
  background:var(--surface); border:1px solid var(--border); border-radius:var(--radius);
  box-shadow:0 8px 24px rgb(0 0 0 / 10%); padding:0; overflow:hidden;
  display:flex; flex-direction:column;
}
.menu__head {
  margin:0; padding:.55rem .8rem; font-size:.8rem; color:var(--text-muted);
  border-bottom:1px solid var(--border); overflow:hidden; text-overflow:ellipsis;
}
.bar nav .menu__item {
  display:block; width:100%; text-align:left; padding:.55rem .8rem; border-radius:0;
  color:var(--text); font-size:.875rem;
}
.bar nav .menu__item:hover { background:var(--surface-2); }
.bar nav .menu__item[aria-current='page'] { background:var(--accent-soft); color:var(--accent); }
/* Sign out is separated by a rule, to avoid hitting it by accident. */
.bar nav .menu__item--danger {
  display:flex; align-items:center; gap:.45rem; color:var(--danger); font-size:.8rem;
  padding:.45rem .8rem; border-top:1px solid var(--border);
}
.bar nav .menu__item--danger:hover { background:var(--danger); color:var(--accent-contrast); }
.menu__icon { flex:0 0 auto; }
/* Narrow screens keep the avatar and hide the address, which the menu repeats. */
@media (max-width:640px) { .account__email { display:none; } .brand__sub { display:none; } }

/* -- shell -- */

/* Sidebar and content side by side, scrolling with the page. The sidebar is sticky. */
.shell { display:grid; grid-template-columns:var(--sidebar-w) minmax(0,1fr); align-items:start; }
.sidebar {
  position:sticky; top:var(--header-h); align-self:start;
  height:calc(100vh - var(--header-h)); overflow-y:auto;
  padding:1rem .6rem; border-right:1px solid var(--border); background:var(--bg-soft);
}
.content { padding:1.5rem 1.75rem 4rem; min-width:0; }
.content > :last-child { margin-bottom:0; }

.sidenav { display:flex; flex-direction:column; gap:1px; }
/* The second block: account settings. */
.sidenav__group { margin-top:1.5rem; }
.sidenav__title {
  margin:0 0 .4rem; padding:0 .6rem; font-size:.7rem; font-weight:700;
  text-transform:uppercase; letter-spacing:.08em; color:var(--text-dim);
}
.sidenav__item {
  display:flex; align-items:center; gap:.6rem; width:100%; text-align:left;
  padding:.45rem .6rem; border:0; border-radius:var(--radius-sm); background:none;
  color:var(--text-muted); font:inherit; font-size:.875rem; text-decoration:none; cursor:pointer;
}
.sidenav__item:hover { background:var(--surface-2); color:var(--text); }
.sidenav__item[aria-current='page'] { background:var(--accent-soft); color:var(--accent); font-weight:600; }
.sidenav__item svg { flex:0 0 auto; opacity:.85; }
.sidenav form { display:contents; }

@media (max-width:900px) {
  /* One column, with the sidebar as a horizontal scrolling strip above the content. Not sticky. */
  .shell { grid-template-columns:minmax(0,1fr); }
  .sidebar {
    position:static; height:auto; overflow-x:auto; overflow-y:visible;
    display:flex; gap:.25rem; padding:.5rem .75rem;
    border-right:0; border-bottom:1px solid var(--border);
  }
  .sidenav { flex-direction:row; gap:.25rem; }
  .sidenav__group { margin-top:0; margin-left:.5rem; padding-left:.5rem; border-left:1px solid var(--border); display:flex; }
  .sidenav__title { display:none; }
  .sidenav__item { white-space:nowrap; }
  .content { padding:1.25rem 1rem 3rem; }
}

/* -- page -- */

.page__head { margin-bottom:1.25rem; }
.page__head p { margin:0; }

/* A panel: one hairline box, a ruled header, and a body. Flat, no shadow or tint. */
.panel {
  background:var(--surface); border:1px solid var(--border); border-radius:var(--radius);
  margin-bottom:1.25rem;
}
.panel__head {
  display:flex; align-items:center; justify-content:space-between; gap:1rem; flex-wrap:wrap;
  padding:.7rem 1rem; border-bottom:1px solid var(--border);
}
.panel__head h2 { margin:0; }
.panel__head .dim { margin:0; }
.panel__body { padding:1rem; }
.panel__body > :last-child { margin-bottom:0; }
/* A block ruled off from the one above, inside the same panel. */
.panel__foot { padding:1rem; border-top:1px solid var(--border); }
.panel__foot > :last-child { margin-bottom:0; }
/* Tables fill their panel edge to edge. */
.panel--flush .panel__body { padding:0; }

/* An empty table: enough room for a first-run message and the next step. */
.empty { padding:2.5rem 1.25rem; text-align:center; }
.empty__title { margin:0; font-size:.95rem; color:var(--text); }
.empty__hint { margin:.4rem 0 0; font-size:.85rem; color:var(--text-dim); }

/* Three figures at the top of the dashboard, separated by hairlines. */
.stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(200px,1fr)); }
.stat { padding:1rem; border-right:1px solid var(--border); }
.stat:last-child { border-right:0; }
/* margin:0 to undo the paragraph margin, so the label sits right above its figure. */
.stat__label { font-size:.7rem; text-transform:uppercase; letter-spacing:.08em; color:var(--text-dim); font-weight:700; margin:0; }
.stat__value { font-size:1.5rem; font-weight:700; letter-spacing:-0.02em; margin:.35rem 0 .25rem; }
.stat__value small { font-size:.9rem; font-weight:400; color:var(--text-muted); }
/* The billing panel starts directly with the figure: the panel padding is the gap. */
.panel__body > .stat__value:first-child { margin-top:0; line-height:1.2; }
.stat__foot { font-size:.8rem; color:var(--text-dim); margin:0; }
/* The action for a figure, under it. */
.stat__action { margin-top:.7rem; }
/* The same figure on the right of a panel heading. */
.count { display:flex; align-items:baseline; gap:.3rem; font-weight:700; letter-spacing:-0.02em; }
.count__value { font-size:1.35rem; }
.count__of { font-size:.9rem; font-weight:400; color:var(--text-muted); }
.count--full .count__value { color:var(--danger); }
@media (max-width:640px) { .stat { border-right:0; border-bottom:1px solid var(--border); } }

/* Irreversible actions, ruled off in the danger color. */
.panel--danger { border-color:var(--danger); }
.panel--danger h2 { color:var(--danger); }
/* A collapsible panel: one line when closed. */
.panel--fold > summary {
  list-style:none; cursor:pointer; font-weight:700; font-size:.9rem;
  display:flex; align-items:center; gap:.5rem; color:var(--danger); padding:.7rem 1rem;
}
.panel--fold > summary::-webkit-details-marker { display:none; }
.panel--fold > summary::before { content:'\\25B8'; transition:transform .15s; }
.panel--fold[open] > summary::before { transform:rotate(90deg); }
.panel--fold[open] > summary { border-bottom:1px solid var(--border); }

/* Label above value, in as many columns as fit. */
.facts { display:grid; gap:1.1rem 1.5rem; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); margin:0; }
.facts dt { font-size:.7rem; text-transform:uppercase; letter-spacing:.08em; color:var(--text-dim); font-weight:700; }
.facts dd { margin:.25rem 0 0; font-size:.9rem; overflow-wrap:anywhere; }
/* A list that reads as prose. */
.plain { list-style:none; padding:0; margin:0 0 1.25rem; display:grid; gap:.6rem; }
.plain li { color:var(--text-muted); font-size:.9rem; line-height:1.6; padding-left:1rem; border-left:2px solid var(--border); }

.btn {
  display:inline-block; border:1px solid var(--accent); background:var(--accent);
  color:var(--accent-contrast); border-radius:var(--radius-sm); padding:.5rem 1rem;
  font:inherit; font-weight:600; font-size:.875rem; cursor:pointer; text-decoration:none;
}
.btn:hover { background:var(--accent-hover); border-color:var(--accent-hover); }
.btn--ghost { background:transparent; color:var(--text); border-color:var(--border-strong); }
.btn--ghost:hover { background:var(--surface-2); }
.btn--sm { padding:.3rem .65rem; font-size:.8rem; }
.btn--danger { background:transparent; color:var(--danger); border-color:var(--border-strong); }

label { display:block; font-size:.8rem; font-weight:600; margin-bottom:.3rem; }
/* type=url styled like the other text inputs. */
input[type=text], input[type=email], input[type=url], input[type=password], select {
  width:100%; padding:.5rem .65rem; border:1px solid var(--border-strong);
  border-radius:var(--radius-sm); background:var(--bg); color:var(--text); font:inherit;
  font-size:.9rem;
  /* Set on both so a select lines up with the input next to it: padding alone gives them different
     heights. A fixed line-height plus border-box fixes it. */
  line-height:1.4; box-sizing:border-box; height:2.35rem;
}
/* Chrome renders white on white in dark mode unless the color scheme is set. */
select { color-scheme:inherit; appearance:none; padding-right:2rem;
  background-image:linear-gradient(45deg,transparent 50%,currentColor 50%),linear-gradient(135deg,currentColor 50%,transparent 50%);
  background-position:calc(100% - 1rem) 1.05rem,calc(100% - .7rem) 1.05rem;
  background-size:.3rem .3rem,.3rem .3rem; background-repeat:no-repeat; }
input:focus-visible, select:focus-visible, .btn:focus-visible, a:focus-visible, button:focus-visible {
  outline:2px solid var(--accent); outline-offset:2px;
}
.field { margin-bottom:1rem; }
.field__icon { font-size:.9rem; cursor:help; }
/* The consent checkbox: the text wraps next to the box, not under it. */
.field--check { margin:1.25rem 0; text-align:left; }
.check { display:flex; gap:.6rem; align-items:flex-start; cursor:pointer; font-size:.85rem; line-height:1.55; color:var(--text-muted); }
.check input { flex:none; margin-top:.2rem; width:1rem; height:1rem; accent-color:var(--accent); cursor:pointer; }
.check a { color:var(--accent); }
.grid2 { display:grid; gap:1rem; grid-template-columns:repeat(auto-fit,minmax(200px,1fr)); }
.row { display:flex; gap:.75rem; align-items:flex-end; flex-wrap:wrap; }
.row .field { flex:1 1 220px; max-width:24rem; margin-bottom:0; }
/* Forms keep a readable width inside a fluid panel. */
.panel__body > form, .panel__foot > form { max-width:42rem; }

/* The lookup page's mode switch: three pills choosing the call the field below will make. CSS only,
   no JavaScript.

   The radios hold the state and are moved off-screen rather than hidden, so arrow keys still work.
   The sibling combinator reaches from the checked radio to its label and note, which is why the
   radios are at the top of the form. */
.segmented__radio { position:absolute; width:1px; height:1px; opacity:0; pointer-events:none; }
.segmented {
  display:inline-flex; flex-wrap:wrap; gap:.25rem; margin:0 0 .75rem;
  padding:.25rem; border:1px solid var(--border); border-radius:var(--radius-sm);
  background:var(--bg-soft);
}
.segmented__item {
  /* margin:0 undoes the global label rule. */
  margin:0; padding:.3rem .75rem; border:1px solid transparent; border-radius:var(--radius-sm);
  font-size:.85rem; font-weight:500; color:var(--text-muted); cursor:pointer;
  user-select:none; white-space:nowrap;
}
.segmented__item:hover { color:var(--text); }
/* One rule per option: the sibling combinator must name the label it reaches.

   The lookup form's modes use ids (one switch per page). The answer tabs use the radio value and
   the label class, since the audit trail has one switch per row with different ids. */
#mode-single:checked ~ .segmented [for='mode-single'],
#mode-all:checked ~ .segmented [for='mode-all'],
.segmented__radio[value='formatted']:checked ~ .segmented .segmented__item--formatted,
.segmented__radio[value='json']:checked ~ .segmented .segmented__item--json {
  background:var(--surface); color:var(--accent); font-weight:600;
  border:1px solid var(--accent-border);
}
/* The focus ring the hidden radio cannot draw. Only on the checked one, the only focusable option. */
#mode-single:focus-visible ~ .segmented [for='mode-single'],
#mode-all:focus-visible ~ .segmented [for='mode-all'],
.segmented__radio[value='formatted']:focus-visible ~ .segmented .segmented__item--formatted,
.segmented__radio[value='json']:focus-visible ~ .segmented .segmented__item--json {
  outline:2px solid var(--accent); outline-offset:2px;
}
/* Both notes are in the page, the checked mode's one is shown. */
.lookupform .note { display:none; margin:.6rem 0 0; }
.lookupform .note code { font-size:.85em; }
#mode-single:checked ~ .note--single,
#mode-all:checked ~ .note--all { display:block; }

/* The query parameters under the field: prefer as radios, history as a checkbox, named like the
   API parameters. */
.options {
  /* One row per parameter, name in its own column. display:contents on the groups so every value
     column starts at the same place. */
  display:grid; grid-template-columns:max-content 1fr; align-items:center; gap:.9rem 1.5rem;
  margin:1rem 0 0; padding:1rem 1.1rem;
  border:1px solid var(--border); border-radius:var(--radius-sm); background:var(--bg-soft);
}
.options__group { display:contents; }
.options__choices { display:flex; flex-wrap:wrap; gap:.5rem 1.5rem; align-items:center; }
.options__label {
  font-family:var(--mono); font-size:.8rem; font-weight:600; color:var(--text);
}
.options__choice {
  /* margin:0 undoes the global label rule. */
  display:inline-flex; align-items:center; gap:.35rem; margin:0;
  font-size:.85rem; color:var(--text-muted); cursor:pointer; white-space:nowrap;
}
.options__choice input { width:.95rem; height:.95rem; margin:0; accent-color:var(--accent); cursor:pointer; }
.options__choice:hover { color:var(--text); }
/* On narrow screens the name goes above its values. Groups become blocks again to keep the spacing
   between parameters. */
@media (max-width:560px) {
  .options { display:block; }
  .options__group { display:block; }
  .options__group + .options__group { margin-top:.9rem; }
  .options__label { display:block; margin-bottom:.35rem; }
}
/* prefer only applies to the single lookup. Hidden rather than removed, so switching back keeps the
   choice. */
#mode-all:checked ~ .options .options__group--prefer { display:none; }

/* The result panel's two tabs, same mechanism. Both panes are rendered and CSS shows one.

   The radio name keeps two switches on a page independent. The panes follow the radios, which is
   why the radios are at the top of the block. */
.pane { display:none; }
.segmented__radio[value='formatted']:checked ~ .pane--formatted,
.segmented__radio[value='json']:checked ~ .pane--json { display:block; }

/* -- formatted answer -- */

/* The verdict band, colored by tone: green with a check mark for active. Neutral has no color.

   The register's badge sits right after the verdict, since the source is part of what it means. */
.verdict {
  padding:.7rem .9rem; margin:0 0 1rem;
  border:1px solid var(--border-strong); border-radius:var(--radius-sm);
  background:var(--bg-soft); color:var(--text);
}
.verdict__line { display:flex; align-items:center; gap:.6rem; flex-wrap:wrap; }
.verdict__mark { display:flex; color:var(--text-muted); }
.verdict__label { font-weight:700; font-size:1.05rem; }
.verdict__why { margin:.4rem 0 0; color:var(--text-muted); font-size:.9rem; }
.verdict--ok { border-color:var(--success); }
.verdict--ok .verdict__mark, .verdict--ok .verdict__label { color:var(--success); }
.verdict--bad { border-color:var(--danger); }
.verdict--bad .verdict__mark, .verdict--bad .verdict__label { color:var(--danger); }
.verdict--warn { border-color:var(--warning); }
.verdict--warn .verdict__mark, .verdict--warn .verdict__label { color:var(--warning); }

/* The company record: name as heading, legal form below, then identifiers, then the address as
   written on an envelope. */
.card__name { font-size:1.15rem; font-weight:700; margin:0; }
.card__name--none { font-weight:400; font-size:1rem; color:var(--text-dim); font-style:italic; }
.card__form { margin:.15rem 0 0; color:var(--text-muted); font-size:.9rem; }
.card__ids { display:flex; gap:1.25rem; flex-wrap:wrap; margin:.7rem 0 0; font-size:.85rem; }
.card__id b { font-weight:700; color:var(--text-muted); margin-right:.25rem; }
.card__block { margin:1rem 0 0; }
.card__block h4, .card__meta h4 {
  font-size:.72rem; text-transform:uppercase; letter-spacing:.07em;
  color:var(--text-dim); font-weight:700; margin:0 0 .25rem;
}
.card__block address { font-style:normal; line-height:1.6; }
/* The consultation number, set apart with the accent color (the one hue not used by the verdict
   tones), so it does not read as a fourth status. Its heading is the translated proof type. */
.proof {
  display:flex; align-items:flex-start; gap:.75rem;
  margin:1rem 0 0; padding:.8rem .9rem;
  border:1px solid color-mix(in srgb, var(--accent) 35%, transparent);
  border-radius:var(--radius-sm);
  background:color-mix(in srgb, var(--accent) 6%, var(--surface));
}
.proof__mark { display:flex; color:var(--accent); }
.proof__body { min-width:0; }
.proof__label {
  margin:0; font-size:.72rem; text-transform:uppercase; letter-spacing:.07em;
  font-weight:700; color:var(--accent);
}
/* Long values wrap instead of widening the panel, and select in one gesture. */
.proof__value {
  margin:.2rem 0 0; font-family:var(--font-mono); font-size:.9rem;
  word-break:break-all; user-select:all;
}
.proof__hint { margin:.4rem 0 0; font-size:.8rem; color:var(--text-muted); }
.answer__error { margin:0; color:var(--danger); }
.card__meta { margin:1.25rem 0 0; padding-top:.8rem; border-top:1px solid var(--border); }
.facts { display:flex; gap:1.25rem; flex-wrap:wrap; font-size:.8rem; color:var(--text-dim); }
.facts b { font-weight:700; color:var(--text-muted); margin-right:.25rem; }

/* One panel per register. */
.sources { display:flex; flex-direction:column; gap:1.25rem; }
.source { border:1px solid var(--border); border-radius:var(--radius-sm); padding:.9rem 1rem 1rem; }
.source__head { display:flex; gap:.5rem; align-items:baseline; flex-wrap:wrap; margin-bottom:.5rem; }
/* The register name first and largest, with a small prefix caption. */
.source__prefix {
  font-size:.68rem; text-transform:uppercase; letter-spacing:.08em;
  color:var(--text-dim); font-weight:600;
}
.source__id { font-family:var(--font-mono); font-size:1.05rem; font-weight:700; color:var(--text); }
.source__name { font-size:.85rem; }

/* The timeline rail.

   Each item draws its own segment below its node, and the last item draws none, so the line runs
   from the first dot to the last. A border on the list would overshoot at both ends.

   Every offset is derived from --tl-dot and --tl-gutter. */
.timeline { --tl-dot:12px; --tl-gutter:1.5rem; --tl-head:1.25rem; list-style:none; margin:.8rem 0 0; padding:0; }
.timeline__item { position:relative; padding:0 0 1.1rem var(--tl-gutter); }
.timeline__item:last-child { padding-bottom:0; }
/* The node, centered on the first line of the entry head, colored by the plateau's status. */
.timeline__item::before {
  content:''; position:absolute; left:0; top:calc((var(--tl-head) - var(--tl-dot)) / 2);
  width:var(--tl-dot); height:var(--tl-dot); border-radius:50%; box-sizing:border-box;
  background:var(--surface); border:2px solid var(--border-strong);
}
/* The segment from this node to the next. */
.timeline__item::after {
  content:''; position:absolute; width:2px; background:var(--border);
  left:calc(var(--tl-dot) / 2 - 1px);
  top:calc((var(--tl-head) - var(--tl-dot)) / 2 + var(--tl-dot)); bottom:0;
}
.timeline__item:last-child::after { display:none; }
/* The current entry: filled instead of hollow. */
.timeline__item--latest::before { background:var(--border-strong); }
.timeline__item--latest.timeline__item--ok::before { background:var(--success); }
.timeline__item--latest.timeline__item--bad::before { background:var(--danger); }
.timeline__item--latest.timeline__item--warn::before { background:var(--warning); }
.timeline__item--ok::before { border-color:var(--success); }
.timeline__item--bad::before { border-color:var(--danger); }
.timeline__item--warn::before { border-color:var(--warning); }
.timeline__head {
  display:flex; gap:.6rem; align-items:center; flex-wrap:wrap;
  min-height:var(--tl-head); margin-bottom:.4rem;
}
.timeline__when { font-family:var(--font-mono); font-size:.8rem; color:var(--text-muted); }

/* The file a plateau was read from, as a small footnote. One row per part, long URLs may break. */
.plateau__file {
  display:grid; grid-template-columns:auto 1fr; gap:.1rem .5rem;
  margin:.9rem 0 0; font-size:.72rem; color:var(--text-dim);
}
.plateau__file dt { font-weight:700; white-space:nowrap; }
.plateau__file dt::after { content:' :'; }
.plateau__file dd { margin:0; overflow-wrap:anywhere; }

/* What changed, shown as a diff. The margin separates it from the card above on the current entry. */
.diffs { display:flex; flex-direction:column; gap:.5rem; margin-top:1.1rem; }
.diffs__head { margin:0 0 .1rem; font-size:.78rem; color:var(--text-muted); }
.diffs__head b { font-weight:700; color:var(--text); }
/* Entries that are only a diff keep their top edge. */
.timeline__body > .diffs:first-child { margin-top:0; }
.diff__field {
  display:block; font-size:.72rem; text-transform:uppercase; letter-spacing:.06em;
  color:var(--text-dim); font-weight:700;
}
.diff__values { display:flex; flex-direction:column; gap:.1rem; font-size:.88rem; }
.diff del, .diff ins {
  padding:.1rem .4rem; border-radius:var(--radius-sm); text-decoration:none;
  overflow-wrap:anywhere;
}
.diff del {
  color:var(--danger); background:color-mix(in srgb, var(--danger) 10%, transparent);
  text-decoration:line-through;
}
.diff del::before, .diff ins::before {
  font-family:var(--font-mono); font-weight:700; margin-right:.4rem; opacity:.7;
}
.diff del::before { content:'−'; }
.diff ins::before { content:'+'; }
.diff ins { color:var(--success); background:color-mix(in srgb, var(--success) 12%, transparent); }
/* A removed field: not colored as an addition. */
.diff ins.diff--none { color:var(--text-dim); background:none; font-style:italic; }

@media (max-width:640px) {
  .card__ids, .facts { gap:.75rem 1rem; }
}

.code {
  background:var(--code-bg); color:var(--code-text); border:1px solid var(--code-border);
  border-radius:var(--radius-sm); padding:.9rem 1rem; overflow-x:auto; font-family:var(--font-mono);
  font-size:.82rem; line-height:1.7; margin:0;
}
.code .flag { color:var(--code-flag); }
.code .str { color:var(--code-str); }
.copywrap { position:relative; }
/* On the dark code panel, so the button uses the panel's colors. */
.copywrap:not(.copywrap--inline) .btn {
  position:absolute; top:.5rem; right:.5rem;
  background:var(--code-surface); border-color:var(--code-border); color:var(--code-text);
}
.copywrap:not(.copywrap--inline) .btn:hover { background:var(--code-border); }
/* Next to the value, for a key in a table cell. */
.copywrap--inline { position:static; display:inline-flex; align-items:center; gap:.5rem; }
.copywrap--inline .btn { position:static; }
.key { font-family:var(--font-mono); font-size:.82rem; }
.key--masked { color:var(--text-dim); }
.key--copy { cursor:pointer; border-radius:var(--radius-sm); padding:.1rem .25rem; margin:-.1rem -.25rem; }
.key--copy:hover { background:var(--accent-soft); color:var(--accent); }
.key--copy:focus-visible { outline:2px solid var(--accent); outline-offset:1px; }

.secret {
  display:block; background:var(--code-bg); color:var(--code-text); border:1px solid var(--code-border);
  border-radius:var(--radius-sm); padding:.8rem 1rem; font-family:var(--font-mono);
  font-size:.9rem; word-break:break-all;
}

table { width:100%; border-collapse:collapse; font-size:.875rem; }
.table-wrap { overflow-x:auto; }
th, td { text-align:left; padding:.55rem 1rem; border-bottom:1px solid var(--border); white-space:nowrap; }
th { font-size:.7rem; text-transform:uppercase; letter-spacing:.08em; color:var(--text-dim); font-weight:700; background:var(--bg-soft); }
tbody tr:last-child td { border-bottom:0; }
tr.is-revoked td { color:var(--text-dim); }
td.mono { font-family:var(--font-mono); font-size:.82rem; }

.meter { height:6px; border-radius:999px; background:var(--surface-2); overflow:hidden; border:1px solid var(--border); }
.meter__fill { height:100%; background:var(--accent); }
.meter__fill.is-full { background:var(--danger); }

.notice { border:1px solid var(--accent-border); background:var(--accent-soft); border-radius:var(--radius-sm); padding:.8rem 1rem; margin-bottom:1.25rem; font-size:.9rem; }
.notice--error { border-color:var(--danger); background:transparent; }
/* The "verify your address" banner: warning color, not danger, with the resend button on the same
   line. */
.notice--warn { border-color:var(--warning); background:transparent; }
.verify-banner { display:flex; gap:.75rem 1rem; align-items:center; justify-content:space-between; flex-wrap:wrap; }
.verify-banner p { margin:0; }
.inline-form { display:inline-block; margin-left:.5rem; vertical-align:middle; }
.notice > :last-child { margin-bottom:0; }

.badge { display:inline-block; font-size:.7rem; font-weight:700; text-transform:uppercase; letter-spacing:.06em;
  padding:.1rem .45rem; border-radius:var(--radius-sm); border:1px solid var(--border-strong); color:var(--text-muted); }

/* The audit trail: one block per answer, since the response body never fits a table cell. The
   badge carries the status color. */
.badge--ok { border-color:var(--success); color:var(--success); }
.badge--warn { border-color:var(--warning); color:var(--warning); }
.badge--danger { border-color:var(--danger); color:var(--danger); }
.entry { border-bottom:1px solid var(--border); padding:1rem; }
.entry:last-child { border-bottom:0; }
.entry__head { display:flex; gap:.75rem; align-items:baseline; flex-wrap:wrap; margin-bottom:.4rem; }
.entry__name { font-weight:700; margin:0 0 .25rem; }
.entry__facts { display:flex; gap:1.25rem; flex-wrap:wrap; font-size:.8rem; color:var(--text-dim); margin:.4rem 0 .6rem; }
.entry__facts b { font-weight:700; color:var(--text-muted); }
/* The stored envelope, in a tab next to the answer. It scrolls instead of widening the panel. */
.entry .pane--json .code { margin:0; white-space:pre; overflow-x:auto; }
/* Verdict and tags at the end of the row, on one line. */
.row-result { white-space:nowrap; }
/* Company names can be very long and used to widen the table past the panel. Truncated with an
   ellipsis on an inline-block (max-width on a cell is ignored with table-layout:auto). The full
   name is in the title attribute and on the number's page.
   (No backticks in here: this stylesheet is a template literal.) */
.row-company {
  display:inline-block; max-width:26ch; overflow:hidden; text-overflow:ellipsis;
  white-space:nowrap; vertical-align:bottom;
}
/* A clickable row: the whole row for the mouse, the link in the last column for the keyboard. Soft
   gray hover, not the accent. */
tr.row-link { cursor:pointer; }
tr.row-link:hover td { background:var(--bg-soft); }
.row-action { text-align:right; white-space:nowrap; }
.row-action a { font-weight:600; }

.chart { width:100%; height:auto; overflow:visible; }
.chart .bar { fill:var(--accent); }
.chart .bar-bg { fill:var(--surface-2); }
.chart .lbl { fill:var(--text-dim); font-size:10px; font-family:var(--font-sans); }
/* The current month: hatched, since it is a partial figure. */
.chart .bar--current { fill:var(--accent); opacity:.55; }

.center { max-width:26rem; margin:4rem auto; padding-inline:1.25rem; }
/* Sign-in, sign-up and reset forms: one column, full-width button. */
.btn--block { display:block; width:100%; text-align:center; }
.field__hint { margin:.35rem 0 0; }
.auth__aside { text-align:right; font-size:.85rem; margin:-.25rem 0 1rem; }
.auth__alt { margin-top:1.5rem; font-size:.9rem; color:var(--text-muted); }
.auth__migrated { margin-top:2rem; font-size:.85rem; }
/* The first-steps card: tinted and edged in the accent color, so it reads as a guide. */
.onboarding { background:var(--accent-soft); border:1px solid var(--accent-border); border-left:4px solid var(--accent);
  border-radius:var(--radius); padding:1.5rem 1.5rem 1.25rem; margin-bottom:1.5rem; }
.onboarding h2 { margin:.15rem 0 .4rem; font-size:1.35rem; }
.onboarding > .muted { margin:0 0 1.25rem; max-width:44rem; }
.onboarding__eyebrow { margin:0; font-size:.7rem; font-weight:700; text-transform:uppercase; letter-spacing:.08em; color:var(--accent); }
.onboarding__steps { list-style:none; padding:0; margin:0; display:grid; gap:1.25rem; }
.onboarding__step { display:flex; gap:.9rem; align-items:flex-start; }
.onboarding__num { flex:none; width:1.75rem; height:1.75rem; border-radius:999px; background:var(--accent); color:var(--accent-contrast);
  display:grid; place-items:center; font-weight:700; font-size:.85rem; }
.onboarding__stepbody { flex:1; min-width:0; }
.onboarding__stepbody > p { margin:.2rem 0 .6rem; font-weight:600; }
.onboarding__stepbody .copywrap { margin:0; }
.onboarding__foot { margin-top:1.25rem; padding-top:1rem; border-top:1px solid var(--accent-border); }

/* -- personal data -- */
/* One panel per data category: the values, then why we hold them. */
.datagrid { display:grid; gap:.85rem 1.5rem; grid-template-columns:repeat(auto-fit,minmax(230px,1fr)); margin:0; }
.datagrid dt { font-size:.7rem; text-transform:uppercase; letter-spacing:.08em; color:var(--text-dim); font-weight:700; }
.datagrid dd { margin:.2rem 0 0; font-size:.9rem; overflow-wrap:anywhere; }
.datagrid dd.is-empty { color:var(--text-dim); }
/* Purpose, legal basis, retention and use, ruled off from the values above. */
.why { border-top:1px solid var(--border); margin-top:1.1rem; padding-top:.9rem; display:grid; gap:.55rem; }
.why__row { display:grid; grid-template-columns:8.5rem minmax(0,1fr); gap:.9rem; }
.why__label { font-size:.7rem; text-transform:uppercase; letter-spacing:.08em; color:var(--text-dim); font-weight:700; padding-top:.15rem; }
.why__value { font-size:.85rem; color:var(--text-muted); line-height:1.55; }
/* The three blocks: personal data, account data, data about looked-up companies. */
.tier { margin:2rem 0 1rem; }
.tier:first-of-type { margin-top:1.25rem; }
.tier h2 { font-size:1.05rem; }
.tier p { margin:.2rem 0 0; }
.actions { display:flex; gap:.6rem; flex-wrap:wrap; align-items:center; margin-top:1.1rem; }
.actions form { margin:0; max-width:none; }
@media (max-width:640px) {
  .why__row { grid-template-columns:minmax(0,1fr); gap:.1rem; }
}
`;
