'use strict';

const ALL = '__all__';
const ADD_PROJECT = '__add__';
const NO_STATUS = '';
const KNOWN_COLORS = ['needs-triage', 'needs-info', 'ready-for-agent', 'ready-for-human', 'claimed', 'ready-for-review', 'resolved', 'wontfix'];
const DONE = new Set(['resolved', 'done', 'closed', 'wontfix']);

const $ = id => document.getElementById(id);
const state = { projects: null, project: null, lastProject: null, data: null, feature: null, ticket: null, query: '', hideEmpty: false, unblockedOnly: false, detail: null, dragging: null, structure: null, notes: {} };

// ---- state <-> URL hash / localStorage ------------------------------------------------
function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  if (p.has('project')) state.project = p.get('project');
  if (p.has('feature')) state.feature = p.get('feature');
  state.ticket = p.get('ticket');
}
function writeHash() {
  const p = new URLSearchParams();
  if (state.project) p.set('project', state.project);
  if (state.feature) p.set('feature', state.feature);
  if (state.ticket) p.set('ticket', state.ticket);
  history.replaceState(null, '', '#' + p.toString());
}
function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem('ticket-viewer') || '{}');
    state.hideEmpty = !!p.hideEmpty;
    state.unblockedOnly = !!p.unblockedOnly;
    state.lastProject = typeof p.lastProject === 'string' ? p.lastProject : null;
  } catch { /* storage unavailable */ }
}
function savePrefs() {
  try { localStorage.setItem('ticket-viewer', JSON.stringify({ hideEmpty: state.hideEmpty, unblockedOnly: state.unblockedOnly, lastProject: state.lastProject })); } catch { }
}

// ---- data -------------------------------------------------------------------------------
const availableProjects = () => (state.projects || []).filter(p => p.available);
const currentProject = () => state.projects?.find(p => p.id === state.project) || null;

// The project list; keeps the selected project while it is available, else picks the last one you picked, else the first.
async function loadProjects() {
  const res = await fetch('/api/projects');
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  state.projects = body.projects;
  const ids = availableProjects().map(p => p.id);
  const pick = [state.project, state.lastProject, ids[0]].find(id => id && ids.includes(id)) || null;
  selectProject(pick);
  renderProjectSelect();
  if (projectsDialogOpen()) renderProjectsDialog();
}

// The project list again for its alert counts only; the select and the board stay as they are.
// Only the counts are taken, so a late answer can't bring back a project removed meanwhile. A burst of change events gives one fetch.
let alertsTimer = null;
function refreshAlerts() {
  clearTimeout(alertsTimer);
  alertsTimer = setTimeout(async () => {
    try {
      const res = await fetch('/api/projects');
      if (!res.ok) return;
      const counts = new Map((await res.json()).projects.map(p => [p.id, p]));
      state.projects = state.projects?.map(p => counts.has(p.id) ? { ...p, review: counts.get(p.id).review, needsYou: counts.get(p.id).needsYou } : p) ?? null;
      renderProjectAlerts();
    } catch { /* the next change tries again */ }
  }, 300);
}

// Switches the board to project `id`. The feature and open ticket start over, unless no project was selected
// yet: then they came from the URL hash and are kept while they exist in that project.
function selectProject(id) {
  if (state.project && id !== state.project) { state.feature = null; state.ticket = null; }
  if (id !== state.project) { state.data = null; state.detail = null; state.structure = null; }
  state.project = id;
  writeHash();
}

// The project you picked yourself (not a fallback or a link), opened next time there's none in the hash.
function rememberProject(id) {
  state.lastProject = id;
  savePrefs();
}

async function load() {
  if (!state.project) { state.data = null; renderFeatureSelect(); render(); return; }
  const project = state.project;
  const res = await fetch(`/api/tickets?project=${encodeURIComponent(project)}`);
  const body = await res.json().catch(() => ({}));
  if (project !== state.project) return; // another project was picked meanwhile
  if (!res.ok) {
    toast(body.error || `Request failed (${res.status})`);
    // Unknown or no longer available: the project list says what's left. Other errors stay put rather than retry.
    if (res.status !== 404 && res.status !== 409) return;
    state.project = null;
    await loadProjects();
    if (state.project) return load();
    return render();
  }
  state.data = body;
  const names = state.data.features.map(f => f.name);
  if (state.feature !== ALL && !names.includes(state.feature)) state.feature = names[0];
  renderFeatureSelect();
  render();
  loadDetail();
}

function agentOf(t) { return state.data.agents?.[t.id] || null; }

// Status changes the board may make itself; the server decides them per ticket (its ticket actions).
function canMove(t, to) { return !!t.actions.moves[to]?.ok; }

// The response body, with `error` set when the request failed. Every request names the selected project.
async function request(path, body, method = 'POST') {
  const res = await fetch(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project: state.project, ...body }) });
  const json = await res.json().catch(() => ({}));
  return res.ok ? json : { ...json, error: json.error || `Request failed (${res.status})` };
}

// Null when the request worked, otherwise the error to show.
async function post(path, body) { return (await request(path, body)).error || null; }

// The response body when the request worked; otherwise shows the error and returns null.
async function api(path, body) {
  const result = await request(path, body);
  if (result.error) { toast(result.error); return null; }
  return result;
}

async function moveTicket(t, to, notes) {
  const result = await api('/api/move', { id: t.id, to, notes });
  if (!result) return null;
  toast(to === 'claimed' ? `${label(t)}: agent started · claude attach to watch` : `${label(t)} → ${to}${stoppedNote(result)}`);
  return result;
}

const stoppedText = n => `Stopped ${plural(n, 'worktree process')}`;
const stoppedNote = result => result.stopped ? ` · ${stoppedText(result.stopped)}` : '';

async function killProcesses(t, pid) {
  const result = await api('/api/agent/kill', { id: t.id, pid });
  if (result) toast(stoppedText(result.stopped));
}

// Agent log, commits and diff stat for the open ticket; polled while its agent runs.
async function loadDetail() {
  clearTimeout(loadDetail.timer);
  const t = state.ticket && findTicket(state.ticket);
  if (!t || !agentOf(t)) { state.detail = null; keepDrawerView(renderAgent); return; }
  const res = await fetch(`/api/agent?${projectQuery(t.id)}`);
  state.detail = res.ok ? { id: t.id, ...(await res.json()) } : null;
  keepDrawerView(renderAgent);
  if (state.detail?.record?.busy) loadDetail.timer = setTimeout(loadDetail, 3000);
}

// codemap's structure diff for a ticket in review: counts per group and flagged entries, loaded on demand.
function wantsStructure(t) { return !!(state.data.codemap && t?.status === 'ready-for-review' && agentOf(t)); }

// `rendering`: called from renderAgent, which draws the loading state itself.
async function loadStructure(id, rendering = false) {
  state.structure = { ...(state.structure?.id === id ? state.structure : {}), id, loading: true, error: null };
  if (!rendering) renderAgent();
  let result;
  try {
    const res = await fetch(`/api/codemap/summary?${projectQuery(id)}`);
    const body = await res.json().catch(() => ({}));
    result = res.ok ? { summary: body } : { error: body.error || `Request failed (${res.status})` };
  } catch (e) { result = { error: e.message }; }
  if (state.structure?.id !== id) return; // another ticket was opened meanwhile
  Object.assign(state.structure, { loading: false }, result);
  renderAgent();
}

async function openStructureDiff(t) {
  if (state.structure?.id !== t.id) return;
  Object.assign(state.structure, { opening: true, viewError: null });
  renderAgent();
  toast('Opening structure diff…');
  const error = await post('/api/codemap/view', { id: t.id });
  if (state.structure?.id !== t.id) return;
  Object.assign(state.structure, { opening: false, viewError: error });
  if (error) toast(`Could not open structure diff: ${error}`);
  renderAgent();
}

// Query string naming the selected project and ticket `id`.
function projectQuery(id) { return new URLSearchParams({ project: state.project, id }).toString(); }

function currentTickets() {
  if (!state.data) return [];
  const feats = state.data.features.filter(f => state.feature === ALL || f.name === state.feature);
  return feats.flatMap(f => f.tickets);
}

function findTicket(id) {
  if (!state.data) return null;
  for (const f of state.data.features) for (const t of f.tickets) if (t.id === id) return t;
  return null;
}

function matches(t) {
  if (state.unblockedOnly && t.blocked) return false;
  if (!state.query) return true;
  const q = state.query.toLowerCase();
  return [t.number, t.title, t.summary, t.type, t.status, t.body].some(v => v && v.toLowerCase().includes(q));
}

function laneList(tickets) {
  const lanes = [...state.data.lanes];
  for (const t of tickets) if (t.status && !lanes.includes(t.status)) lanes.push(t.status);
  if (tickets.some(t => !t.status)) lanes.unshift(NO_STATUS);
  return lanes;
}

// ---- clipboard --------------------------------------------------------------------------
// The board never writes tickets: status changes go through the agent skills, so it hands out commands.
const TRIAGE_STATES = ['needs-triage', 'needs-info', 'ready-for-agent', 'ready-for-human', 'wontfix'];

function implementCommand(t) { return `/implement ${t.path}`; }
function attachCommand(a) { return `claude attach ${a.bgId}`; }
function worktreeCommand(a) { return `cd ${a.worktree}`; }
function mergeCommand(a) { return `git merge ${a.branch} && git worktree remove ${a.worktree} && git branch -d ${a.branch}`; }
function triageCommand(t, to) { return to ? `/triage move ${t.path} to ${to}` : `/triage ${t.path}`; }

// The next step for a ticket: triage it until it's ready, then implement it. Null when it's not agent work.
function nextCommand(t) {
  const a = agentOf(t);
  if (a?.bgId && t.status === 'claimed') return { text: attachCommand(a), what: 'attach command' };
  if (!t.status || t.status === 'needs-triage' || t.status === 'needs-info') return { text: triageCommand(t), what: '/triage command' };
  if (t.status === 'ready-for-agent') return { text: implementCommand(t), what: '/implement command' };
  return null;
}

async function copy(text, what) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Clipboard API is missing outside secure contexts; fall back to a hidden textarea.
    const ta = el('textarea', { style: 'position:fixed;opacity:0' }, text);
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    if (!ok) { toast(`Could not copy ${what}`); return false; }
  }
  toast(`Copied ${what}: ${text}`);
  return true;
}

// ---- rendering --------------------------------------------------------------------------
// A small button that copies `text`; its tooltip shows exactly what gets copied.
function badgeButton(content, text, what) {
  return el('button', { class: 'badge action', title: `Copy "${text}"`, onclick: () => copy(text, what) }, content);
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'style') node.style.cssText = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  return fill(node, ...children);
}

// Like replaceChildren, but flattens arrays and skips null/false.
function fill(node, ...children) {
  node.replaceChildren();
  for (const c of children.flat()) if (c != null && c !== false) node.append(c.nodeType ? c : String(c));
  return node;
}

function laneColor(status) {
  return KNOWN_COLORS.includes(status) ? `var(--s-${status})` : 'var(--s-other)';
}
function label(t) { return t.number ? `#${t.number}` : t.file; }

// Disabled options show no tooltip in most browsers, so an unavailable project's reason goes in its text, cut short.
function short(text, max = 50) { return text && text.length > max ? `${text.slice(0, max - 1)}…` : text || ''; }

function renderProjectSelect() {
  const sel = $('project');
  const projects = state.projects || [];
  sel.replaceChildren(
    ...(state.project ? [] : [el('option', { value: '' }, projects.length ? 'No project available' : 'No projects yet')]),
    // The server lists the available projects by name, then the unavailable ones.
    ...projects.map(p => el('option', { value: p.id, disabled: !p.available, title: p.available ? p.path : p.reason },
      p.available ? p.name : `${p.name} (unavailable: ${short(p.reason)})`)),
    el('option', { value: ADD_PROJECT }, 'Add project…'),
  );
  sel.value = state.project || '';
  renderProjectAlerts();
}

// A project alert for each other project with tickets to review or agents that need you; clicking one switches to it.
function renderProjectAlerts() {
  const others = availableProjects().filter(p => p.id !== state.project && (p.review > 0 || p.needsYou > 0));
  $('alerts').replaceChildren(...others.map(p => el('button', {
    class: 'alert', type: 'button',
    title: [p.review && `${plural(p.review, 'ticket')} to review`, p.needsYou && `${plural(p.needsYou, 'agent')} waiting on you`]
      .filter(Boolean).join(', ') + ` in ${p.name}; switch to it`,
    onclick: () => switchProject(p.id),
  }, el('span', { class: 'alert-name' }, p.name),
    p.review ? el('span', { class: 'alert-review' }, `${p.review} to review`) : null,
    p.needsYou ? el('span', { class: 'alert-needs-you' }, `⚠ ${p.needsYou}`) : null)));
}

function renderFeatureSelect() {
  const sel = $('feature');
  sel.hidden = !state.data;
  if (!state.data) return;
  const feats = state.data.features;
  sel.replaceChildren(
    ...(feats.length > 1 ? [el('option', { value: ALL }, 'All features')] : []),
    ...feats.map(f => el('option', { value: f.name }, `${f.name} (${f.tickets.length})`)),
  );
  sel.value = state.feature;
}

// Instead of the board, while no project is selected.
function renderEmpty() {
  const none = !state.projects?.length;
  $('board').replaceChildren(el('div', { class: 'board-empty' },
    el('p', {}, none ? 'No projects yet. Add a repo root, its .scratch folder or one feature folder.'
      : state.project ? 'Loading…' : state.projects ? 'None of your projects is available right now; hover one in the project list to see why.' : 'Loading…'),
    state.projects && !state.project ? btn('+ Add project', { class: 'btn primary' }, openProjectsDialog) : null));
  $('stats').textContent = '';
  $('drawer').hidden = true;
}

function render() {
  if (!state.data) return renderEmpty();
  const all = currentTickets();
  const visible = all.filter(matches);
  const lanes = laneList(all);
  const board = $('board');
  const scroll = new Map([...board.querySelectorAll('.lane-body')].map(b => [b.dataset.status, b.scrollTop]));
  const boardScroll = board.scrollLeft;

  board.replaceChildren(...lanes.map(status => {
    const cards = visible.filter(t => (t.status || NO_STATUS) === status);
    if (state.hideEmpty && cards.length === 0) return null;
    return renderLane(status, cards);
  }).filter(Boolean));

  board.scrollLeft = boardScroll;
  for (const b of board.querySelectorAll('.lane-body')) b.scrollTop = scroll.get(b.dataset.status) || 0;

  const done = all.filter(t => DONE.has(t.status)).length;
  const blocked = all.filter(t => t.blocked).length;
  $('stats').textContent = `${visible.length}/${all.length} shown · ${done} done · ${blocked} blocked`;
  keepDrawerView(renderDrawer);
}

function renderLane(status, cards) {
  const body = el('div', { class: 'lane-body', 'data-status': status },
    cards.length ? cards.map(renderCard) : el('div', { class: 'empty' }, 'No tickets'));
  const lane = el('section', { class: 'lane', style: `--lane-color:${laneColor(status)}` },
    el('div', { class: 'lane-head' },
      el('span', { class: 'dot' }), status || 'no status', el('span', { class: 'count' }, cards.length)),
    body);

  const accepts = () => state.dragging && canMove(state.dragging, status);
  lane.addEventListener('dragover', e => { if (accepts()) { e.preventDefault(); lane.classList.add('drop'); } });
  lane.addEventListener('dragleave', e => { if (!lane.contains(e.relatedTarget)) lane.classList.remove('drop'); });
  lane.addEventListener('drop', e => {
    e.preventDefault();
    lane.classList.remove('drop');
    if (accepts()) moveTicket(state.dragging, status);
  });

  return lane;
}

function renderCard(t) {
  const pct = t.checks.total ? Math.round(100 * t.checks.done / t.checks.total) : 0;
  const foot = [];
  if (t.blocked) foot.push(el('span', { class: 'badge blocked', title: `Waiting on ${t.openBlockers.join(', ')}` }, `⛔ blocked by ${t.openBlockers.join(', ')}`));
  else if (!DONE.has(t.status) && t.blockedBy.length) foot.push(el('span', { class: 'badge ready', title: 'All blockers are done' }, '✓ unblocked'));
  const agent = agentOf(t);
  if (agent && !DONE.has(t.status)) foot.push(agentBadge(agent));
  if (agent?.processes?.length) foot.push(processBadge(agent.processes));
  if (agent?.merging) foot.push(mergingBadge(agent));
  else if (agent?.conflict) foot.push(conflictBadge(agent));
  if (t.type) foot.push(el('span', { class: 'badge' }, t.type));
  if (t.comments) foot.push(el('span', { class: 'badge', title: 'Comments' }, `💬 ${t.comments}`));
  if (t.checks.total) {
    foot.push(el('span', { class: 'progress', title: `${t.checks.done} of ${t.checks.total} criteria checked` }, el('span', { style: `width:${pct}%` })));
    foot.push(el('span', { class: 'progress-label' }, `${t.checks.done}/${t.checks.total}`));
  }

  const next = nextCommand(t);
  const movable = Object.values(t.actions.moves).some(m => m.ok);
  const card = el('div', {
    class: 'card' + (state.ticket === t.id ? ' selected' : ''),
    style: `--lane-color:${laneColor(t.status)}`,
    tabindex: '0', role: 'button', draggable: movable ? 'true' : null,
    ondragstart: e => { state.dragging = t; e.dataTransfer.setData('text/plain', t.id); e.dataTransfer.effectAllowed = 'move'; card.classList.add('dragging'); },
    ondragend: () => { state.dragging = null; card.classList.remove('dragging'); },
    onclick: () => openTicket(t.id),
    onkeydown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openTicket(t.id); } },
  },
    el('div', { class: 'card-top' },
      el('span', { class: 'card-num' }, label(t)),
      state.feature === ALL ? el('span', { class: 'card-feature' }, `· ${t.feature}`) : null,
      next ? el('button', {
        class: 'copy-btn', title: `Copy "${next.text}"`, 'aria-label': `Copy ${next.what}`,
        onclick: e => { e.stopPropagation(); copy(next.text, next.what); },
        onkeydown: e => e.stopPropagation(),
      }, '⧉') : null),
    el('div', { class: 'card-title' }, t.title),
    t.summary ? el('div', { class: 'card-summary' }, t.summary) : null,
    foot.length ? el('div', { class: 'card-foot' }, foot) : null);
  return card;
}

function agentBadge(a) {
  const badge = (state, attrs, text) => el('span', { class: `badge agent-state ${state}`, ...attrs }, text);
  switch (a.state) {
    case 'starting': return badge('running', {}, '● agent starting');
    case 'running': return badge('running', { title: `Working on ${a.branch}` }, '● agent running');
    case 'waiting': return badge('waiting', { title: `Attach to answer: ${attachCommand(a)}` }, `⚠ needs you: ${a.waitingFor}`);
    case 'idle': return badge('idle', { title: 'The agent ended its turn without committing; it probably asked you something' }, '💬 agent is waiting for a reply');
    case 'done': return badge('done', { title: a.branch }, '✓ agent done');
    case 'failed': return badge('failed', { title: a.error || '' }, '✕ agent failed to start');
    default: return badge('stopped', { title: 'The session is not running; attaching reopens it' }, '■ agent stopped');
  }
}

// Shown in every lane: a server left running after approval is exactly what you want to notice.
function processBadge(procs) {
  const title = procs.map(p => `${p.pid}: ${p.command}`).join('\n');
  return el('span', { class: 'badge processes', title }, `⚙ ${plural(procs.length, 'process')}`);
}

// A test merge of the ticket's branch into its reference branch fails.
function conflictBadge(a) {
  const title = `Merging ${a.branch} into ${a.ref} conflicts in:\n${a.conflict.files.join('\n')}`;
  return el('span', { class: 'badge blocked', title }, `⚔ conflicts (${plural(a.conflict.files.length, 'file')})`);
}

// The ticket's worktree is mid-merge (MERGE_HEAD exists), whoever started the merge.
const mergingText = a => `⚔ merge in progress (${a.merging.unresolved} unresolved)`;
function mergingBadge(a) {
  return el('span', { class: 'badge merging', title: `Merging ${a.ref || 'a branch'} into ${a.branch} in the worktree: finish or abort it in the drawer` }, mergingText(a));
}

function plural(n, word) { return `${n} ${n === 1 ? word : word + (word.endsWith('s') ? 'es' : 's')}`; }

function openTicket(id) {
  state.ticket = id;
  state.detail = null;
  state.structure = null;
  writeHash();
  render();
  loadDetail();
}
function closeTicket() {
  state.ticket = null;
  state.detail = null;
  state.structure = null;
  writeHash();
  render();
}

// Live updates rebuild the drawer, so the scroll offsets and open/closed sections it was left with
// (elements marked data-keep) are read before each render and put back after. Opening another
// ticket starts over, so its defaults apply.
let drawerView = { open: {}, scroll: {} };
function keepDrawerView(draw) {
  const drawer = $('drawer');
  if (state.ticket && drawer.dataset.ticket === state.ticket) saveView(drawer);
  else drawerView = { open: {}, scroll: {} };
  draw();
  if (drawer.hidden) { delete drawer.dataset.ticket; return; }
  restoreView(drawer);
  drawer.dataset.ticket = state.ticket;
}

// The root goes last: opening sections first gives it the height to scroll back to.
function keptNodes(root) { return [...root.querySelectorAll('[data-keep]'), root]; }

function saveView(root) {
  for (const n of keptNodes(root)) {
    const k = n.dataset.keep;
    if (n.tagName === 'DETAILS') drawerView.open[k] = n.open;
    // A closed section has no layout, so leave its last known offset alone.
    else if (n.clientHeight) drawerView.scroll[k] = { top: n.scrollTop, atBottom: n.scrollHeight - n.scrollTop - n.clientHeight < 4 };
  }
}

function restoreView(root) {
  for (const n of keptNodes(root)) {
    const k = n.dataset.keep;
    if (n.tagName === 'DETAILS') {
      if (k in drawerView.open) n.open = drawerView.open[k];
      // Scrolling a closed section does nothing, so put its offsets back once it's opened.
      n.ontoggle = () => { if (n.open) n.querySelectorAll('[data-keep]').forEach(restoreScroll); };
    } else restoreScroll(n);
  }
}

function restoreScroll(n) {
  const s = drawerView.scroll[n.dataset.keep];
  // data-follow lists stay pinned to the bottom as items arrive, like a terminal.
  n.scrollTop = !s ? 0 : s.atBottom && 'follow' in n.dataset ? n.scrollHeight : s.top;
}

function renderDrawer() {
  const drawer = $('drawer');
  const t = state.ticket && findTicket(state.ticket);
  if (!t) { drawer.hidden = true; return; }
  drawer.hidden = false;

  // Picking a state copies a /triage command, so the agent makes the move (and writes the brief).
  const moveSel = el('select', {
    class: 'badge action', 'aria-label': 'Move via /triage',
    onchange: e => { const to = e.target.value; e.target.value = ''; if (to) copy(triageCommand(t, to), '/triage command'); },
  },
    el('option', { value: '' }, 'Move via /triage… ▾'),
    TRIAGE_STATES.filter(s => s !== t.status).map(s => el('option', { value: s }, `→ ${s}`)));

  fill($('drawerMeta'),
    el('span', { class: 'card-num' }, label(t)), el('span', {}, `· ${t.feature}`),
    el('span', { class: 'badge status', style: `--lane-color:${laneColor(t.status)}` }, t.status || 'no status'),
    t.type ? el('span', { class: 'badge' }, t.type) : null,
    t.blocked ? el('span', { class: 'badge blocked' }, 'blocked') : null);
  $('drawerTitle').textContent = t.title;

  const byNum = new Map(currentTickets().filter(o => o.feature === t.feature).map(o => [Number(o.number), o]));
  const link = n => {
    const o = byNum.get(Number(n));
    const open = o && !DONE.has(o.status);
    return el('button', {
      class: 'badge' + (open ? ' blocked' : ''), title: o ? `${o.title} (${o.status || 'no status'})` : 'Not found',
      onclick: () => o && openTicket(o.id),
    }, `#${n}`);
  };
  const a = agentOf(t);
  fill($('drawerLinks'),
    t.blockedBy.length || t.blocks.length ? el('div', { class: 'links-row' },
      t.blockedBy.length ? el('span', {}, 'Blocked by') : null, t.blockedBy.map(link),
      t.blocks.length ? el('span', {}, 'Blocks') : null, t.blocks.map(link)) : null,
    el('div', { class: 'links-row action-group', role: 'group', 'aria-label': 'Commands' },
      badgeButton('⧉ Copy /implement', implementCommand(t), '/implement command'),
      badgeButton('⧉ Copy /triage', triageCommand(t), '/triage command'),
      moveSel),
    el('div', { class: 'links-row' },
      badgeButton(el('code', {}, t.path), t.absPath, 'absolute path'),
      a?.worktree ? badgeButton('⧉ Copy worktree', worktreeCommand(a), 'worktree command') : null));
  renderAgent();
  $('drawerBody').innerHTML = renderMarkdown(t.body);
  document.querySelectorAll('.card.selected').forEach(c => c.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
}

// The Claude Code part of the drawer: start an agent, follow it, and review what it did.
function renderAgent() {
  const box = $('drawerAgent');
  const t = state.ticket && findTicket(state.ticket);
  const a = t && agentOf(t);
  const d = state.detail?.id === t?.id ? state.detail : null;
  // Empty it too: the previous ticket's buttons (Stop agent) are bound to that ticket.
  if (!t || (!a && t.status !== 'ready-for-agent')) { box.hidden = true; box.replaceChildren(); return; }
  box.hidden = false;

  // Which buttons show, and which are disabled and why, are the server's ticket actions.
  const { start, stop, resolveConflicts, mergeByHand, moves } = t.actions;
  const actions = [];
  if (start && t.status === 'ready-for-agent') {
    actions.push(btn(start.resume ? '▶ Continue agent' : '▶ Start agent', refused(start, { class: 'btn primary', title: 'Claim the ticket and run /implement as a background session' }), () => moveTicket(t, 'claimed')));
  }
  // Start/Continue and meld are the next step in their lanes; otherwise attaching is, when the agent needs you.
  if (a?.bgId) actions.push(btn('⧉ Copy attach', { class: `btn${t.needsYou ? ' primary' : ''}`, title: `${attachCommand(a)}: open the session in your terminal to watch it, answer prompts or reply` }, () => copy(attachCommand(a), 'attach command')));
  if (stop) actions.push(btn('■ Stop agent', { title: 'Stop the session; its conversation is kept' }, () => api('/api/agent/stop', { id: t.id })));
  if (resolveConflicts) {
    actions.push(btn('⚔ Resolve conflicts', refused(resolveConflicts, {
      class: 'btn primary',
      title: `Move the ticket to claimed and have the agent merge ${a.ref} into ${a.branch} (merge, not rebase), resolve ${plural(a.conflict.files.length, 'file')}, run the tests and commit. Nothing is added to the ticket's ## Comments`,
    }), async () => {
      if (await api('/api/agent/resolve-conflicts', { id: t.id })) toast(`${label(t)}: agent is resolving the merge conflict · claude attach to watch`);
    }));
  }
  if (mergeByHand) {
    actions.push(btn('⇆ Resolve in meld', refused(mergeByHand, {
      title: `git merge --no-edit ${a.ref} in the worktree, then git mergetool --tool=meld on the conflicts. Refused with uncommitted changes. The ticket stays in its lane`,
    }), async () => {
      const result = await api('/api/agent/merge', { id: t.id });
      if (result) toast(result.clean ? `${label(t)}: merged ${a.ref} cleanly and committed` : `${label(t)}: ${plural(result.unresolved, 'file')} to resolve · opening meld`);
    }));
  }
  if (start && t.status === 'claimed') {
    actions.push(btn('↻ Continue agent', refused(start, { title: 'Resume the session in the background and tell it to carry on' }), () => api('/api/agent/start', { id: t.id })));
  }
  if (moves['ready-for-agent'] && t.status === 'claimed') {
    actions.push(btn('Back to ready-for-agent', refused(moves['ready-for-agent'], {}), () => moveTicket(t, 'ready-for-agent')));
  }

  // Loaded afresh each time the ticket comes (back) into review.
  if (!wantsStructure(t) && state.structure?.id === t.id) state.structure = null;
  let review = null;
  if (t.status === 'ready-for-review' && a) {
    // Kept in state, so the board's live reloads don't wipe what you've written.
    const notes = el('textarea', {
      class: 'notes', rows: 3, placeholder: 'Review notes: sent to the agent\'s session and added to the ticket\'s ## Comments',
      oninput: e => { state.notes[t.id] = e.target.value; },
    });
    notes.value = state.notes[t.id] || '';
    const structure = wantsStructure(t);
    if (structure && state.structure?.id !== t.id) loadStructure(t.id, true);
    // The merge-base with the reference branch, once the detail has loaded.
    const since = (d?.changes?.base || a.base).slice(0, 8);
    review = el('div', { class: 'review' },
      el('div', { class: 'agent-actions' },
        btn('⇆ Open diff in meld', { class: 'btn primary', title: `git difftool -d ${since} in the worktree` }, () => api('/api/agent/diff', { id: t.id })),
        structure ? btn(state.structure?.opening ? '⌗ Opening structure diff…' : '⌗ Open structure diff', {
          class: 'btn primary', disabled: !!state.structure?.opening,
          title: `codemap view: the structural changes since ${since}, to mark OK or Flag`,
        }, () => openStructureDiff(t)) : null,
        btn('✓ Approve', refused(moves.resolved, { title: `Mark resolved, stop the session and its worktree processes, and copy the command that merges ${a.branch} into ${a.ref || 'the branch you are on'}` }), async () => {
          const conflict = a.conflict;
          const result = await moveTicket(t, 'resolved');
          if (!result) return;
          // Copying shows its own toast, so repeat the stopped count and any merge conflict in it.
          const warning = conflict ? ` · ⚔ it conflicts with ${a.ref} in ${plural(conflict.files.length, 'file')}` : '';
          const copied = await copy(mergeCommand(a), 'merge command');
          if (result.stopped || warning) toast(`${copied ? 'Copied merge command' : 'Could not copy merge command'}${warning}${stoppedNote(result)}`);
        }),
        btn('↩ Send back to agent', refused(moves.claimed, { title: 'Resume the agent\'s session with your notes' }), () => {
          if (!notes.value.trim()) return toast('Write what should change first');
          moveTicket(t, 'claimed', notes.value.trim()).then(ok => { if (ok) delete state.notes[t.id]; });
        })),
      structure ? renderStructure(t, notes) : null,
      notes);
  }

  const pending = a?.state === 'waiting' && d?.items.at(-1)?.kind === 'tool' ? d.items.at(-1).text : null;
  const last = pending
    ? el('div', { class: 'last-message', 'data-keep': 'pending' }, el('strong', {}, 'Waiting to run: '), el('code', {}, pending), el('div', { class: 'muted' }, `Attach to answer: ${attachCommand(a)}`))
    : d?.lastMessage && ['idle', 'done', 'stopped'].includes(a?.state)
      ? el('div', { class: 'last-message markdown', 'data-keep': 'last-message', title: 'The agent\'s last message' }) : null;
  if (last && !pending) last.innerHTML = renderMarkdown(d.lastMessage);
  const changes = d?.changes;
  fill(box,
    el('div', { class: 'agent-head' },
      el('strong', {}, 'Claude Code'),
      a ? agentBadge(a) : el('span', { class: 'muted' }, 'no agent yet'),
      a ? badgeButton(el('code', {}, a.branch), a.branch, 'branch') : null,
      a?.hostname ? badgeButton(el('code', {}, a.hostname), a.hostname, 'agent hostname') : null,
      a?.error ? el('span', { class: 'badge blocked' }, a.error) : null),
    actions.length ? el('div', { class: 'agent-actions' }, actions) : null,
    last,
    a ? renderMerge(t, a) : null,
    review,
    a?.processes?.length ? renderProcesses(t, a.processes, a.hostname) : null,
    changes ? el('details', { class: 'changes', 'data-keep': 'changes', open: t.status === 'ready-for-review' },
      el('summary', {}, `${changes.commits.length} commit${changes.commits.length === 1 ? '' : 's'}${changes.dirty ? ' · uncommitted changes' : ''}`),
      changes.commits.length ? el('ul', { class: 'commits' }, changes.commits.map(c => el('li', {}, c))) : null,
      changes.stat ? el('pre', {}, changes.stat) : null) : null,
    d?.items.length ? el('details', { class: 'activity', 'data-keep': 'activity', open: !!a?.busy },
      el('summary', {}, 'Agent activity'),
      el('ol', { 'data-keep': 'activity-list', 'data-follow': true }, d.items.map(x => el('li', { class: x.kind }, x.text)))) : null);
}

// Where the ticket's work will be merged, and the files a test merge into it conflicts in;
// or, while the worktree is mid-merge, how far resolving it has come and how to finish it.
function renderMerge(t, a) {
  if (!a.worktree) return null;
  if (a.merging) {
    const { finishMerge, abortMerge, reopenMeld } = t.actions;
    const actions = el('div', { class: 'agent-actions' },
      btn('✓ Finish merge', refused(finishMerge, { class: 'btn primary', title: 'git commit --no-edit in the worktree' }),
        async () => { if (await api('/api/agent/merge/finish', { id: t.id })) toast(`${label(t)}: merge committed`); }),
      btn('✕ Abort merge', refused(abortMerge, { title: 'git merge --abort: the branch and worktree go back to how they were before the merge' }),
        async () => { if (await api('/api/agent/merge/abort', { id: t.id })) toast(`${label(t)}: merge aborted`); }),
      btn('⇆ Reopen meld', refused(reopenMeld, { title: 'git mergetool --tool=meld on the files still unmerged' }),
        () => api('/api/agent/merge/meld', { id: t.id })));
    return el('div', { class: 'merge-conflict merging' },
      el('div', {}, el('strong', {}, mergingText(a)), a.ref ? el('span', { class: 'muted' }, ' merging ', el('code', {}, a.ref)) : null),
      actions);
  }
  if (!a.ref) return el('div', { class: 'muted merge-target', title: 'The main checkout was on a detached HEAD, or the branch is gone: no merge-conflict check, and diffs start where the ticket started' }, 'no reference branch');
  if (!a.conflict) return el('div', { class: 'muted merge-target' }, 'Merges into ', el('code', {}, a.ref));
  return el('div', { class: 'merge-conflict' },
    el('div', {}, el('strong', {}, `⚔ Merge conflict with `), el('code', {}, a.ref), el('span', { class: 'muted' }, ` in ${plural(a.conflict.files.length, 'file')}`)),
    el('ul', {}, a.conflict.files.map(f => el('li', {}, el('code', {}, f)))));
}

// Processes running in the ticket's worktree (servers, watchers, shells), each killable with its process group.
// A listening port opens the app at the agent hostname, once the board knows whether the port speaks TLS.
function renderProcesses(t, procs, hostname) {
  const short = s => s.length > 80 ? s.slice(0, 77) + '…' : s;
  return el('div', { class: 'process-list' },
    el('div', { class: 'agent-head' },
      el('strong', {}, 'Worktree processes'),
      el('span', { class: 'muted' }, plural(procs.length, 'process')),
      btn('✕ Kill all', { title: 'Stop every process running in the worktree (SIGTERM, then SIGKILL after 5 s)' }, () => killProcesses(t))),
    el('ul', {}, procs.map(p => el('li', {},
      el('code', { class: 'command', title: p.command }, short(p.command)),
      p.ports.map(({ port, scheme }) => scheme && hostname
        ? el('a', { class: 'badge action', href: `${scheme}://${hostname}:${port}`, target: '_blank', rel: 'noopener', title: `Open the app at ${scheme}://${hostname}:${port}` }, `↗ Open app :${port}`)
        : el('span', { class: 'badge', title: `Listening on port ${port}${scheme ? '' : ' (checking for TLS)'}` }, `:${port}`)),
      el('span', { class: 'muted' }, `pid ${p.pid}`),
      btn('Kill', { title: `Stop process group ${p.pgid} (SIGTERM, then SIGKILL after 5 s)` }, () => killProcesses(t, p.pid))))));
}

// The review panel's codemap section: counts per review-list group, flagged entries, and copying their notes.
function renderStructure(t, notes) {
  const st = state.structure?.id === t.id ? state.structure : {};
  const s = st.summary;
  const copyNotes = () => {
    const current = notes.value.trim();
    const missing = s.notes.filter(n => !current.includes(n));
    if (!missing.length) return toast('The flagged notes are already in your notes');
    const text = missing.map(n => `- ${n}`).join('\n');
    notes.value = current ? `${current}\n\n${text}` : text;
    state.notes[t.id] = notes.value;
    notes.focus();
    toast(`Copied ${plural(missing.length, 'flagged note')} into the notes`);
  };
  return el('div', { class: 'structure' },
    el('div', { class: 'agent-head' },
      el('strong', {}, 'Structure diff'),
      st.loading ? el('span', { class: 'muted' }, s ? 'refreshing…' : 'computing… (the first run extracts both snapshots)') : null,
      s && !st.loading && s.groups.length ? el('span', { class: 'muted' }, s.unmarked ? `${plural(s.unmarked, 'item')} not marked yet` : 'all marked') : null,
      el('button', { class: 'icon-btn', title: 'Refresh the summary, e.g. after marking items in codemap', disabled: !!st.loading, onclick: () => loadStructure(t.id) }, '↻')),
    st.viewError ? el('div', { class: 'error-text' }, `Could not open structure diff: ${st.viewError}`) : null,
    st.error ? el('div', { class: 'error-text' }, `Could not get the codemap summary: ${st.error}`) : null,
    s ? el('div', { class: 'structure-groups' },
      s.groups.length
        ? s.groups.map(g => el('span', { class: 'badge' + (g.kind === 'other-change' ? '' : ' structural') }, `${g.label}: ${g.count}`))
        : el('span', { class: 'muted' }, 'No structural changes')) : null,
    s?.warning ? el('div', { class: 'badge needs-you', title: s.warning, tabindex: 0 }, s.warning) : null,
    s?.flagged.length ? el('ul', { class: 'flagged' }, s.flagged.map(f => el('li', { title: f.title }, f.note))) : null,
    s ? el('div', { class: 'agent-actions' },
      btn(`⇣ Copy ${plural(s.notes.length, 'flagged note')} to Send back`, {
        disabled: !s.notes.length, title: s.notes.length ? 'Add the flagged items to the review notes below' : 'Flag items in the structure diff to get notes here',
      }, copyNotes)) : null);
}

function btn(text, attrs, onclick) { return el('button', { class: 'btn', ...attrs, onclick }, text); }
// A ticket action's button attributes: disabled when refused, with the reason as its tooltip.
function refused(action, attrs) { return { ...attrs, disabled: !action.ok, title: action.why || attrs.title }; }

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, 2200);
}

// ---- minimal markdown renderer (input is escaped first) ---------------------------------
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function inline(s) {
  const codes = [];
  s = escapeHtml(s).replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
  s = s
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, text, href) =>
      /^(https?:|#|\.{0,2}\/|[\w-]+\.md)/.test(href) ? `<a href="${href}" target="_blank" rel="noopener">${text}</a>` : text)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    .replace(/(^|[^\w])_([^_\s][^_]*)_(?!\w)/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[i]}</code>`);
}

function renderMarkdown(md) {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let para = [];
  const listStack = []; // { type, indent }

  const flushPara = () => { if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para = []; } };
  const closeLists = (toIndent = -1) => {
    while (listStack.length && listStack.at(-1).indent > toIndent) out.push(`</li></${listStack.pop().type}>`);
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const fence = line.match(/^\s*(```|~~~)/);
    if (fence) {
      flushPara(); closeLists();
      const code = [];
      while (++i < lines.length && !lines[i].trim().startsWith(fence[1])) code.push(lines[i]);
      out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
      continue;
    }
    if (!line.trim()) { flushPara(); continue; }

    const h = line.match(/^(#{1,6})\s+(.*?)\s*#*$/);
    if (h) { flushPara(); closeLists(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flushPara(); closeLists(); out.push('<hr>'); continue; }

    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1] || '') && lines[i + 1].includes('-')) {
      flushPara(); closeLists();
      const cells = r => r.trim().replace(/^\||\|$/g, '').split('|').map(c => inline(c.trim()));
      const head = cells(line);
      i++;
      const rows = [];
      while (i + 1 < lines.length && /^\s*\|.*\|\s*$/.test(lines[i + 1])) rows.push(cells(lines[++i]));
      out.push(`<table><thead><tr>${head.map(c => `<th>${c}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
      continue;
    }

    const bq = line.match(/^\s*>\s?(.*)$/);
    if (bq) { flushPara(); closeLists(); out.push(`<blockquote>${inline(bq[1])}</blockquote>`); continue; }

    const li = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    if (li) {
      flushPara();
      const indent = li[1].replace(/\t/g, '  ').length;
      const type = /\d/.test(li[2]) ? 'ol' : 'ul';
      closeLists(indent);
      const top = listStack.at(-1);
      if (!top || top.indent < indent) { out.push(`<${type}>`); listStack.push({ type, indent }); }
      else out.push('</li>');
      const task = li[3].match(/^\[([ xX])\]\s*(.*)$/);
      out.push(task
        ? `<li class="task"><input type="checkbox" disabled${task[1] !== ' ' ? ' checked' : ''}>${inline(task[2])}`
        : `<li>${inline(li[3])}`);
      continue;
    }

    if (listStack.length && /^\s+/.test(line)) { out.push(' ' + inline(line.trim())); continue; }
    closeLists();
    para.push(line.trim());
  }
  flushPara(); closeLists();
  return out.join('\n');
}

// ---- Add project dialog -------------------------------------------------------------------
// Adds a project by its path and lists the remembered ones, each with Remove. Removing only forgets the project.
const dialog = { error: null, busy: false, confirmRemove: null };

function projectsDialogOpen() { return $('projectsDialog').open; }

function openProjectsDialog() {
  Object.assign(dialog, { error: null, busy: false, confirmRemove: null });
  $('projectPath').value = '';
  renderProjectsDialog();
  $('projectsDialog').showModal();
  $('projectPath').focus();
}

function renderProjectsDialog() {
  $('projectError').textContent = dialog.error || '';
  $('projectError').hidden = !dialog.error;
  $('projectAdd').disabled = dialog.busy;
  const projects = state.projects || [];
  $('projectList').replaceChildren(...projects.map(p => {
    const confirming = dialog.confirmRemove === p.id;
    return el('li', { class: p.available ? '' : 'unavailable' },
      el('div', { class: 'project-row' },
        el('span', { class: 'project-name' }, p.name),
        el('span', { class: 'project-path', title: p.available ? p.path : p.reason }, p.available ? p.path : `unavailable: ${p.reason}`),
        confirming
          ? btn('Remove anyway', { type: 'button', class: 'btn danger' }, () => removeProject(p))
          : btn('Remove', { type: 'button', title: 'Forget this project; nothing on disk is touched' }, () => removeProject(p))),
      // Agents keep running when their project is forgotten; only the board stops following them.
      confirming ? el('div', { class: 'project-warning' },
        `${plural(p.running, 'agent')} running; they keep running, but their tickets won't move until you add this project again`) : null);
  }));
  $('projectListEmpty').hidden = projects.length > 0;
}

async function addProject(e) {
  e.preventDefault();
  dialog.busy = true;
  renderProjectsDialog();
  const result = await request('/api/projects', { path: $('projectPath').value });
  dialog.busy = false;
  if (result.error) { dialog.error = result.error; renderProjectsDialog(); $('projectPath').focus(); return; }
  $('projectsDialog').close();
  selectProject(result.project.id);
  rememberProject(result.project.id);
  // A feature folder opens the board on that feature.
  if (result.feature) { state.feature = result.feature; writeHash(); }
  await loadProjects();
  await load();
  toast(result.added ? `Added ${result.project.name}` : `${result.project.name} was already on the board`);
}

async function removeProject(p) {
  // With agents running, the first click only warns.
  if (p.running > 0 && dialog.confirmRemove !== p.id) { dialog.confirmRemove = p.id; renderProjectsDialog(); return; }
  dialog.confirmRemove = null;
  const result = await request(`/api/projects/${encodeURIComponent(p.id)}`, {}, 'DELETE');
  if (result.error) { dialog.error = result.error; renderProjectsDialog(); return; }
  toast(`Removed ${p.name} from the board; its files are untouched`);
  await loadProjects();
  await load();
}

// ---- wiring -----------------------------------------------------------------------------
function connectEvents() {
  const es = new EventSource('/api/events');
  // One stream for every project: only the selected project's changes reload the board.
  // Every change refreshes the project alerts, the selected project's too, so its alert is right once you switch away.
  es.addEventListener('change', e => {
    let project = null;
    try { project = JSON.parse(e.data).project; } catch { /* reload anyway */ }
    if (!project || project === state.project) load();
    refreshAlerts();
  });
  es.addEventListener('projects', () => loadProjects().then(() => { if (!state.data) load(); }));
  es.onopen = () => $('live').classList.remove('off');
  es.onerror = () => $('live').classList.add('off');
}

// Picking a project yourself, in the select or from its alert.
function switchProject(id) {
  selectProject(id);
  if (state.project) rememberProject(state.project);
  renderProjectSelect();
  renderFeatureSelect();
  render();
  load();
}

$('project').addEventListener('change', e => {
  if (e.target.value === ADD_PROJECT) { e.target.value = state.project || ''; openProjectsDialog(); return; }
  switchProject(e.target.value || null);
});
$('projectForm').addEventListener('submit', addProject);
$('projectsClose').addEventListener('click', () => $('projectsDialog').close());
$('feature').addEventListener('change', e => { state.feature = e.target.value; state.ticket = null; writeHash(); render(); });
$('search').addEventListener('input', e => { state.query = e.target.value.trim(); render(); });
$('hideEmpty').addEventListener('change', e => { state.hideEmpty = e.target.checked; savePrefs(); render(); });
$('unblockedOnly').addEventListener('change', e => { state.unblockedOnly = e.target.checked; savePrefs(); render(); });
$('drawerClose').addEventListener('click', closeTicket);
// The drawer covers the board's right edge, where the browser would auto-scroll during a drag,
// so dragging a card over the drawer scrolls the board on toward the lanes behind it.
$('drawer').addEventListener('dragover', () => { if (state.dragging) $('board').scrollLeft += 20; });
document.addEventListener('keydown', e => {
  if (projectsDialogOpen()) return; // the dialog has its own keys (Escape closes it)
  if (e.key === 'Escape' && state.ticket) closeTicket();
  const typing = ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName);
  if (e.key === 'c' && !typing && !e.ctrlKey && !e.metaKey && !e.altKey) {
    const t = state.ticket && findTicket(state.ticket);
    const next = t && (nextCommand(t) || { text: implementCommand(t), what: '/implement command' });
    if (next) copy(next.text, next.what);
  }
  if (e.key === '/' && document.activeElement.tagName !== 'INPUT') { e.preventDefault(); $('search').focus(); }
});
// Coming back from the codemap tab: pick up the items you marked there.
function refreshStructure() {
  const t = state.ticket && findTicket(state.ticket);
  if (document.visibilityState === 'visible' && state.structure?.id === t?.id && !state.structure.loading && wantsStructure(t)) loadStructure(t.id);
}
window.addEventListener('focus', refreshStructure);
document.addEventListener('visibilitychange', refreshStructure);
window.addEventListener('hashchange', () => {
  const project = state.project;
  readHash();
  // Another project in the hash (e.g. a link pasted in): load it, through the project list so an unknown id falls back.
  if (state.project !== project) {
    const { project: next, feature, ticket } = state;
    state.project = project;
    selectProject(next);
    Object.assign(state, { feature, ticket });
    writeHash();
    loadProjects().then(load);
    return;
  }
  if (state.data) { renderFeatureSelect(); render(); }
});

loadPrefs();
readHash();
$('hideEmpty').checked = state.hideEmpty;
$('unblockedOnly').checked = state.unblockedOnly;
loadProjects().then(load).then(connectEvents).catch(e => toast(`Failed to load tickets: ${e.message}`));
