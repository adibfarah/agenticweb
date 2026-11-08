/** The single-page review UI. Plain HTML + JS, no build step. */
export function reviewHtml(token: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agent branch review</title>
<style>
:root{--bg:#f7f7f5;--card:#fff;--text:#1b1b1a;--muted:#6b6b66;--line:#e4e4df;--accent:#1f5eff;--on:#127a3a;--off:#9a9a94;--warn:#a15c00}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--card:#1e1e1c;--text:#ecece8;--muted:#9c9c96;--line:#2e2e2b;--accent:#7aa2ff;--on:#4ccb7f;--off:#76766f;--warn:#e0a24a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
header{padding:20px 24px;border-bottom:1px solid var(--line);background:var(--card)}h1{font-size:20px;margin:0 0 4px}header p{margin:0;color:var(--muted)}
nav{display:flex;gap:4px;padding:12px 24px;border-bottom:1px solid var(--line);background:var(--card);position:sticky;top:0;flex-wrap:wrap}
nav button{font:inherit;border:0;background:none;color:var(--muted);padding:6px 12px;border-radius:6px;cursor:pointer}nav button.active{background:var(--bg);color:var(--text);font-weight:600}
main{max-width:980px;margin:0 auto;padding:20px 16px 60px}.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin-bottom:10px}
.row{display:flex;justify-content:space-between;gap:12px;align-items:flex-start}.title{font-weight:600}.meta{color:var(--muted);font-size:13px}
.pill{display:inline-block;font-size:12px;padding:1px 8px;border-radius:99px;border:1px solid var(--line);color:var(--muted);margin-right:4px}
.toggle{font:inherit;font-size:13px;border:1px solid var(--line);background:var(--bg);color:var(--text);padding:4px 10px;border-radius:6px;cursor:pointer;white-space:nowrap}
.toggle.on{border-color:var(--on);color:var(--on)}.toggle.off{color:var(--off)}.hidden{opacity:.55}
pre{white-space:pre-wrap;font-size:12px;background:var(--bg);padding:10px;border-radius:6px;max-height:240px;overflow:auto;margin:10px 0 0}
select,textarea,input{font:inherit;font-size:13px;background:var(--bg);color:var(--text);border:1px solid var(--line);border-radius:6px;padding:4px 6px}textarea{width:100%;margin-top:8px}
.warn{color:var(--warn);font-size:13px;margin-top:6px}.stats{display:flex;gap:16px;flex-wrap:wrap;margin-top:8px}.stats div{font-size:13px;color:var(--muted)}.stats b{color:var(--text);font-size:18px;display:block}
details summary{cursor:pointer;color:var(--accent);font-size:13px;margin-top:6px}#toast{position:fixed;bottom:16px;left:50%;transform:translateX(-50%);background:var(--text);color:var(--bg);padding:8px 14px;border-radius:8px;font-size:13px;opacity:0;transition:opacity .2s}
</style>
</head>
<body>
<header><h1 id="name">Loading…</h1><p id="desc"></p><div class="stats" id="stats"></div></header>
<nav><button data-tab="actions" class="active">Actions</button><button data-tab="data">Data</button><button data-tab="pages">Pages</button><button data-tab="suggestions">Suggestions</button><button data-tab="activity">Activity</button><button data-tab="changes">Changes</button></nav>
<main id="main"></main>
<div id="toast"></div>
<script>
const TOKEN = ${JSON.stringify(token)};
let graph, tab = "actions", activity = null, changes = [], suggestions = [];
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"})[c]);
const api = (path, body) => fetch(path, { method: body ? "POST" : "GET", headers: { "content-type": "application/json", "x-review-token": TOKEN }, body: body ? JSON.stringify(body) : undefined }).then((r) => r.json());
function toast(msg) { const t = $("#toast"); t.textContent = msg; t.style.opacity = 1; setTimeout(() => (t.style.opacity = 0), 1800); }
async function load() { [graph, activity, changes, suggestions] = await Promise.all([api("/api/graph"), api("/api/activity"), api("/api/changes"), api("/api/suggestions")]); render(); }
function bars(rows, empty) {
  if (!rows || !rows.length) return '<p class="meta">' + empty + '</p>';
  const max = Math.max(...rows.map((r) => r[1]));
  return rows.map(([k, n]) => '<div style="display:flex;gap:10px;align-items:center;margin:4px 0"><div style="flex:0 0 40%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + esc(k) + '">' + esc(k) + '</div><div style="flex:1;background:var(--bg);border-radius:4px"><div style="width:' + Math.max(4, (n / max) * 100) + '%;background:var(--accent);height:10px;border-radius:4px"></div></div><div class="meta" style="width:3em;text-align:right">' + n + '</div></div>').join("");
}
function activityView() {
  const s = activity;
  if (!s || (!s.requests && !s.actions.length)) return '<p class="meta">No agent activity yet. Activity is recorded while <code>agenticweb serve</code> runs, and printed as JSON logs by deployed servers.</p>';
  return '<div class="card"><div class="stats"><div><b>' + s.requests + '</b>Requests (7 days)</div><div><b>' + s.p50ms + ' ms</b>Median response</div><div><b>' + s.actions.reduce((a, x) => a + x.done, 0) + '</b>Completed actions</div></div></div>' +
    '<div class="card"><div class="title">Agents</div>' + bars(s.byAgent, "None yet") + '</div>' +
    '<div class="card"><div class="title">Top questions</div>' + bars(s.topQuestions, "No questions yet") + '</div>' +
    (s.unanswered.length ? '<div class="card"><div class="title">Questions your site couldn\\'t answer</div><p class="meta">Adding this information to your site helps agents send you customers.</p>' + bars(s.unanswered, "") + '</div>' : "") +
    '<div class="card"><div class="title">Actions</div>' + (s.actions.length ? s.actions.map((a) => '<div class="row" style="margin:6px 0"><div>' + esc(a.action) + '</div><div class="meta">' + a.started + ' started · ' + a.done + ' completed (' + a.completionRate + '%) · ' + a.declined + ' declined · ' + a.expired + ' expired</div></div>').join("") : '<p class="meta">No actions yet</p>') + '</div>';
}
function suggestionsView() {
  const head = '<div class="row" style="margin-bottom:10px"><p class="meta" style="margin:0">Questions agents asked that your site couldn’t answer, with a drafted answer. Edit it, approve it, then add it to your page with the HTML below. The next build picks it up from your site, so people and agents see the same answer.</p><button class="toggle" data-refresh="1">Look for new questions</button></div>';
  if (!suggestions.length) return head + '<p class="meta">No suggestions yet. They come from unanswered questions (recorded by <code>agenticweb serve</code> or your deployed logs) and from failed <code>agenticweb test</code> tasks.</p>';
  const order = { new: 0, approved: 1, live: 2, dismissed: 3 };
  const label = { new: "Needs you", approved: "Approved: add it to your site", live: "Live on your site", dismissed: "Dismissed" };
  return head + suggestions.slice().sort((a, b) => order[a.status] - order[b.status] || b.asked - a.asked).map((s) => {
    const editable = s.status === "new";
    const holes = s.draft.toLowerCase().includes("[[fill in:");
    return '<div class="card ' + (s.status === "dismissed" ? "hidden" : "") + '"><div class="row"><div style="flex:1"><div class="title">' + esc(s.question) + '</div><div class="meta">' + (s.asked ? "Asked " + s.asked + " time" + (s.asked === 1 ? "" : "s") + " · " : "") + (s.from === "readiness" ? "failed readiness task · " : "") + (s.page ? "belongs on " + esc(s.page.title) : "") + (s.covers.length ? " · also answers: " + s.covers.map(esc).join("; ") : "") + '</div>' +
      (editable ? '<textarea rows="3" data-draft="' + esc(s.id) + '">' + esc(s.draft) + '</textarea>' + (holes ? '<div class="warn">Replace each [[fill in: …]] with the real answer before approving.' + (s.missingFacts.length ? " Needed: " + s.missingFacts.map(esc).join(", ") + "." : "") + '</div>' : "") : '<p>' + esc(s.draft) + '</p>') +
      (s.status === "approved" ? '<details open><summary>HTML to add to ' + esc(s.page ? s.page.url : "your page") + '</summary><pre>' + esc(s.snippet) + '</pre><button class="toggle" data-copy="' + esc(s.id) + '">Copy HTML</button></details>' : "") +
      '</div><div style="display:flex;flex-direction:column;gap:6px;align-items:flex-end"><span class="pill">' + label[s.status] + '</span>' +
      (editable ? '<button class="toggle on" data-approve="' + esc(s.id) + '">Approve</button><button class="toggle off" data-dismiss="' + esc(s.id) + '">Dismiss</button>' : s.status === "live" ? "" : '<button class="toggle" data-reopen="' + esc(s.id) + '">Edit again</button>') +
      '</div></div></div>';
  }).join("");
}
function changesView() {
  if (!changes.length) return '<p class="meta">No syncs yet. Run <code>agenticweb sync</code> to rebuild from your live site and see what changed.</p>';
  const list = (label, xs) => xs.length ? '<div class="meta"><b>' + label + ':</b> ' + xs.map(esc).join(", ") + '</div>' : "";
  return changes.map((d) => '<div class="card"><div class="title">' + new Date(d.at).toLocaleString() + '</div>' + (list("New pages", d.pages.added) + list("Changed pages", d.pages.changed) + list("Removed pages", d.pages.removed) + list("New items", d.entities.added) + list("Changed items", d.entities.changed.map((c) => c.name + " (" + c.fields.join(", ") + ")")) + list("Removed items", d.entities.removed) + list("New actions (off until enabled)", d.actions.added) || '<div class="meta">No changes</div>') + '</div>').join("");
}
function render() {
  $("#name").textContent = graph.site.name + ": agent branch review";
  $("#desc").textContent = graph.site.description || graph.site.url;
  const on = graph.actions.filter((a) => a.enabled).length;
  $("#stats").innerHTML = [["Public pages", graph.pages.filter((p) => !p.hidden).length], ["Data items", graph.entities.filter((e) => !e.hidden).length], ["Actions on", on + " / " + graph.actions.length]].map(([k, v]) => "<div><b>" + v + "</b>" + k + "</div>").join("");
  document.querySelectorAll("nav button").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  $("#main").innerHTML = tab === "actions" ? actionsView() : tab === "data" ? dataView() : tab === "suggestions" ? suggestionsView() : tab === "activity" ? activityView() : tab === "changes" ? changesView() : pagesView();
}
function actionsView() {
  if (!graph.actions.length) return '<p class="meta">No actions found. Connect a data source (agenticweb connect) or add actions to agenticweb.config.json.</p>';
  return '<p class="meta">Agents can only use actions you turn on. Each one asks for the confirmation you choose before anything is final.</p>' + graph.actions.map((a) => '<div class="card"><div class="row"><div><div class="title">' + esc(a.name) + '</div><div class="meta">' + esc(a.description) + '</div><div style="margin-top:6px"><span class="pill">' + a.kind + '</span><span class="pill">backend: ' + esc(a.backend.type) + '</span><span class="pill">inputs: ' + a.input.map((f) => esc(f.name)).join(", ") + '</span></div>' + (a.backend.type === "form-bridge" ? '<div class="warn">Submits your HTML form. A native connector is more reliable when you have one.</div>' : "") + '</div><div><button class="toggle ' + (a.enabled ? "on" : "off") + '" data-action="' + esc(a.name) + '">' + (a.enabled ? "On" : "Off") + '</button></div></div><div style="margin-top:10px" class="meta">Confirmation: <select data-confirm="' + esc(a.name) + '">' + ["none","guest","owner","checkout_link","payment_protocol"].map((c) => '<option' + (c === a.confirmation ? " selected" : "") + '>' + c + '</option>').join("") + '</select></div></div>').join("");
}
function dataView() {
  const byType = {};
  graph.entities.forEach((e) => (byType[e.type] = byType[e.type] || []).push(e));
  return Object.entries(byType).map(([type, list]) => '<h3>' + esc(type) + ' <span class="meta">(' + list.length + ')</span></h3>' + list.map((e) => '<div class="card ' + (e.hidden ? "hidden" : "") + '"><div class="row"><div><div class="title">' + esc(e.name) + '</div><div class="meta">from ' + esc(e.source.via) + (e.source.url ? " · " + esc(e.source.url) : "") + '</div><details><summary>Show data</summary><pre>' + esc(JSON.stringify(e.data, null, 2)) + '</pre></details></div><button class="toggle ' + (e.hidden ? "off" : "on") + '" data-entity="' + esc(e.id) + '">' + (e.hidden ? "Hidden" : "Visible") + '</button></div></div>').join("")).join("") || '<p class="meta">No structured data found.</p>';
}
function pagesView() {
  return graph.pages.map((p) => '<div class="card ' + (p.hidden ? "hidden" : "") + '"><div class="row"><div><div class="title">' + esc(p.title) + ' <span class="pill">' + p.pageType + '</span></div><div class="meta">' + esc(p.url) + '</div><details><summary>Preview Markdown</summary><pre>' + esc(p.markdown.slice(0, 4000)) + '</pre></details></div><button class="toggle ' + (p.hidden ? "off" : "on") + '" data-page="' + esc(p.slug) + '">' + (p.hidden ? "Hidden" : "Visible") + '</button></div></div>').join("");
}
document.addEventListener("click", async (ev) => {
  const t = ev.target;
  if (t.dataset.tab) { tab = t.dataset.tab; render(); return; }
  if (t.dataset.action) { const a = graph.actions.find((x) => x.name === t.dataset.action); if (!a.enabled && !confirm("Allow AI agents to use " + a.name + "?")) return; await api("/api/actions/" + encodeURIComponent(a.name), { enabled: !a.enabled }); toast(a.name + (a.enabled ? " turned off" : " turned on")); return load(); }
  if (t.dataset.approve) {
    const draft = document.querySelector('[data-draft="' + t.dataset.approve + '"]').value;
    const r = await api("/api/suggestions/" + encodeURIComponent(t.dataset.approve), { draft, status: "approved" });
    if (r.error) { await api("/api/suggestions/" + encodeURIComponent(t.dataset.approve), { draft }); toast(r.error); return load(); }
    toast("Approved. Add the HTML to your page."); return load();
  }
  if (t.dataset.dismiss) { await api("/api/suggestions/" + encodeURIComponent(t.dataset.dismiss), { status: "dismissed" }); return load(); }
  if (t.dataset.reopen) { await api("/api/suggestions/" + encodeURIComponent(t.dataset.reopen), { status: "new" }); return load(); }
  if (t.dataset.copy) { const s = suggestions.find((x) => x.id === t.dataset.copy); await navigator.clipboard.writeText(s.snippet); toast("Copied"); return; }
  if (t.dataset.refresh) { t.disabled = true; t.textContent = "Looking…"; const r = await api("/api/suggestions/refresh", {}); toast(r.error ? r.error : r.added + " new suggestion" + (r.added === 1 ? "" : "s")); return load(); }
  if (t.dataset.entity) { const e = graph.entities.find((x) => x.id === t.dataset.entity); await api("/api/entities", { id: e.id, hidden: !e.hidden }); return load(); }
  if (t.dataset.page) { const p = graph.pages.find((x) => x.slug === t.dataset.page); await api("/api/pages/" + encodeURIComponent(p.slug), { hidden: !p.hidden }); return load(); }
});
document.addEventListener("change", async (ev) => {
  const t = ev.target;
  if (t.dataset.confirm) { await api("/api/actions/" + encodeURIComponent(t.dataset.confirm), { confirmation: t.value }); toast("Saved"); return load(); }
});
load();
</script>
</body>
</html>`;
}
