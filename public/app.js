'use strict';

const ALL = '__all__';
const ADD_PROJECT = '__add__';
const NO_STATUS = '';
const KNOWN_COLORS = ['needs-triage', 'needs-info', 'ready-for-agent', 'ready-for-human', 'claimed', 'ready-for-review', 'resolved', 'wontfix'];

const { DONE, EMPTY_LANES, LAYOUTS, readLayout, rowMarks, listGroups, listNote, plural, matchesQuery, readPrefs, liveCounts, laneView, plainText, headerActions, splitReport, agentHeading, noAgentPrompt, isTriage } = TicketView;
const $ = id => document.getElementById(id);
// layout: board, strip or list (LAYOUTS in view.js). emptyLanes: show, collapse or hide the lanes with no tickets. expandedLanes: the empty lanes you expanded by hand in Collapse mode.
// collapsedGroups: the List layout's closed groups, by status.
const state = { layout: 'board', projects: null, project: null, lastProject: null, data: null, feature: null, ticket: null, query: '', emptyLanes: 'collapse', expandedLanes: [], collapsedGroups: [], unblockedOnly: false, detail: null, toAlerts: false, dragging: null, structure: null, notes: {}, commandsOpen: false };

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
    Object.assign(state, readPrefs(JSON.parse(localStorage.getItem('ticket-viewer') || '{}')));
  } catch { /* storage unavailable */ }
  try { state.layout = readLayout(localStorage.getItem('tv:layout')); } catch { /* storage unavailable */ }
}
function savePrefs() {
  try { localStorage.setItem('ticket-viewer', JSON.stringify({ emptyLanes: state.emptyLanes, expandedLanes: state.expandedLanes, collapsedGroups: state.collapsedGroups, unblockedOnly: state.unblockedOnly, lastProject: state.lastProject })); } catch { }
  try { localStorage.setItem('tv:layout', state.layout); } catch { }
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
    state.toAlerts = false;
    // Unknown or no longer available: the project list says what's left. Other errors stay put rather than retry.
    if (res.status !== 404 && res.status !== 409) return;
    state.project = null;
    await loadProjects();
    if (state.project) return load();
    return render();
  }
  state.data = body;
  const feats = state.data.features;
  // Opened from a project alert: the feature whose tickets the alert counts, or all of them when several have some.
  if (state.toAlerts) {
    state.toAlerts = false;
    const alerting = feats.filter(f => f.tickets.some(t => t.status === 'ready-for-review' || t.needsYou));
    if (alerting.length) { state.feature = alerting.length > 1 ? ALL : alerting[0].name; writeHash(); }
  }
  // Without a valid pick the board opens on the first feature with work left, if there is one.
  if (state.feature !== ALL && !feats.some(f => f.name === state.feature)) state.feature = (feats.find(f => !f.completed) ?? feats[0]).name;
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

// Ticks or unticks acceptance criterion `index` of ticket `t` in its file. The page flips it straight away and the
// file watcher's reload confirms it; if the file changed under the page, the server refuses and the reload shows the file.
// One at a time, so a quick second click can't overtake the first and be refused against a state the page made up.
async function toggleCriterion(t, index, item) {
  if (toggleCriterion.busy) return;
  toggleCriterion.busy = true;
  const expected = { text: item.text, done: item.done };
  item.done = !item.done;
  t.checks = { ...t.checks, done: t.checks.done + (item.done ? 1 : -1) };
  render();
  try {
    const result = await request('/api/criterion', { id: t.id, index, ...expected });
    if (result.error) throw new Error(result.error);
  } catch (e) {
    toast(`Not ${expected.done ? 'unticked' : 'ticked'}: ${e.message}`);
    load();
  } finally {
    toggleCriterion.busy = false;
  }
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
  return matchesQuery(t, state.query);
}

function laneList(tickets) {
  const lanes = [...state.data.lanes];
  for (const t of tickets) if (t.status && !lanes.includes(t.status)) lanes.push(t.status);
  if (tickets.some(t => !t.status)) lanes.unshift(NO_STATUS);
  return lanes;
}

// ---- clipboard --------------------------------------------------------------------------
// The board never writes tickets: status changes go through the agent skills, so it hands out commands.
function implementCommand(t) { return `/implement ${t.path}`; }
function attachCommand(a) { return `claude attach ${a.bgId}`; }
function mergeCommand(a) { return `git merge ${a.branch} && git worktree remove ${a.worktree} && git branch -d ${a.branch}`; }
function triageCommand(t, to) { return to ? `/triage move ${t.path} to ${to}` : `/triage ${t.path}`; }

// The next step for a ticket: triage it until it's ready, then implement it. Null when it's not agent work.
function nextCommand(t) {
  const a = agentOf(t);
  if (a?.bgId && t.status === 'claimed') return { text: attachCommand(a), what: 'attach command' };
  if (isTriage(t)) return { text: triageCommand(t), what: '/triage command' };
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
function laneName(status) { return status || 'no status'; }
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
    onclick: () => switchProject(p.id, true),
  }, el('span', { class: 'alert-name' }, p.name),
    p.review ? el('span', { class: 'alert-review' }, `${p.review} to review`) : null,
    p.needsYou ? el('span', { class: 'alert-needs-you' }, `⚠ ${p.needsYou}`) : null)));
}

function renderFeatureSelect() {
  const sel = $('feature');
  sel.hidden = !state.data;
  if (!state.data) return;
  const feats = state.data.features;
  // Features with work left first, then the completed ones, greyed out; each group stays alphabetical as the server sent it.
  const option = f => el('option', { value: f.name, class: f.completed ? 'completed' : null }, `${f.name} (${f.tickets.length})`);
  const withWork = feats.filter(f => !f.completed), done = feats.filter(f => f.completed);
  sel.replaceChildren(
    ...(feats.length > 1 ? [el('option', { value: ALL }, 'All features')] : []),
    ...withWork.map(option),
    ...(withWork.length && done.length ? [el('option', { disabled: true }, '── completed ──')] : []),
    ...done.map(option),
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
  renderCounts([]);
  $('drawer').hidden = true;
  $('detailEmpty').hidden = true;
}

function render() {
  if (!state.data) return renderEmpty();
  const all = currentTickets();
  const visible = all.filter(matches);
  const lanes = laneList(all);
  const strip = state.layout === 'strip';
  const board = $('board');
  const scroll = new Map([...board.querySelectorAll('.lane-body')].map(b => [b.dataset.status, b.scrollTop]));
  const { scrollLeft, scrollTop } = board;

  if (state.layout === 'list') board.replaceChildren(...listGroups(visible).map(renderGroup));
  else board.replaceChildren(...lanes.map(status => {
    const cards = visible.filter(t => (t.status || NO_STATUS) === status);
    const view = laneView(cards.length, state.emptyLanes, state.expandedLanes.includes(status));
    return view === 'hidden' ? null : view === 'collapsed' ? renderCollapsedLane(status) : renderLane(status, cards, view === 'expanded', strip);
  }).filter(Boolean));

  board.scrollLeft = scrollLeft;
  board.scrollTop = scrollTop;
  for (const b of board.querySelectorAll('.lane-body')) b.scrollTop = scroll.get(b.dataset.status) || 0;

  renderCounts(all);
  keepDrawerView(renderDrawer);
}

// The top bar's live counts for the tickets on the board (the selected feature, before the filters).
function renderCounts(tickets) {
  const { running, review } = liveCounts(tickets, state.data?.agents);
  $('countRunning').textContent = running;
  $('countReview').textContent = review;
}

// The top bar's toggles, drawn from state.
function renderToolbar() {
  $('main').dataset.layout = state.layout;
  segmented($('layoutSwitch'), LAYOUTS.map(l => [l.value, l.label, l.title]), state.layout, v => {
    state.layout = v;
    savePrefs();
    renderToolbar();
    render();
  });
  $('unblockedOnly').setAttribute('aria-pressed', state.unblockedOnly);
  // The List layout has groups, not lanes, so it has no empty lanes to show or hide.
  $('emptyLanesField').hidden = state.layout === 'list';
  segmented($('emptyLanes'), EMPTY_LANES.map(v => [v, v[0].toUpperCase() + v.slice(1)]), state.emptyLanes, v => {
    state.emptyLanes = v;
    savePrefs();
    renderToolbar();
    render();
  });
}

// A segmented control in `box`: one button per [value, label, title?] option, the `value` one pressed.
function segmented(box, options, value, onpick) {
  fill(box, options.map(([v, text, title]) => el('button', {
    type: 'button', class: 'seg-btn', 'aria-pressed': String(v === value), title,
    // onpick redraws the buttons, so focus moves to the newly pressed one.
    onclick: () => { if (v !== value) { onpick(v); box.querySelector('[aria-pressed="true"]')?.focus(); } },
  }, text)));
}

// Expands or collapses the empty lane `status` by hand, and keeps keyboard focus on that lane's toggle.
function toggleLane(status) {
  const expanded = state.expandedLanes.includes(status);
  state.expandedLanes = expanded ? state.expandedLanes.filter(s => s !== status) : [...state.expandedLanes, status];
  savePrefs();
  render();
  [...$('board').querySelectorAll('[data-lane-toggle]')].find(b => b.dataset.laneToggle === status)?.focus();
}

// Lets cards be dropped on `target`, a lane or a collapsed lane, to move them to `status`.
function dropTarget(target, status) {
  const accepts = () => state.dragging && canMove(state.dragging, status);
  target.addEventListener('dragover', e => { if (accepts()) { e.preventDefault(); target.classList.add('drop'); } });
  target.addEventListener('dragleave', e => { if (!target.contains(e.relatedTarget)) target.classList.remove('drop'); });
  target.addEventListener('drop', e => {
    e.preventDefault();
    target.classList.remove('drop');
    if (accepts()) moveTicket(state.dragging, status);
  });
  return target;
}

// `collapsible`: an empty lane expanded by hand, which gets a Collapse button.
// `strip`: a Strip layout lane, with compact row cards and no dragging.
function renderLane(status, cards, collapsible = false, strip = false) {
  const name = laneName(status);
  const lane = el('section', { class: 'lane', style: `--lane-color:${laneColor(status)}` },
    el('div', { class: 'lane-head' },
      el('span', { class: 'dot' }), el('span', { class: 'lane-name' }, name), el('span', { class: 'count' }, cards.length),
      collapsible ? el('button', {
        class: 'ghost-btn', type: 'button', 'data-lane-toggle': status, 'aria-label': `Collapse the ${name} lane`, onclick: () => toggleLane(status),
      }, 'Collapse') : null),
    el('div', { class: 'lane-body', 'data-status': status },
      cards.length ? cards.map(strip ? renderRowCard : renderCard) : el('div', { class: 'lane-empty' }, 'No tickets')));
  return strip ? lane : dropTarget(lane, status);
}

// An empty lane in Collapse mode: a narrow button with the lane's name, which expands the lane.
function renderCollapsedLane(status) {
  const name = laneName(status);
  return dropTarget(el('button', {
    class: 'lane-collapsed', type: 'button', style: `--lane-color:${laneColor(status)}`, 'data-lane-toggle': status,
    title: 'Expand lane', 'aria-label': `Expand the empty ${name} lane`, onclick: () => toggleLane(status),
  }, el('span', { class: 'dot' }), el('span', { class: 'lane-name' }, name)), status);
}

function renderCard(t) {
  const agent = agentOf(t);
  const marks = [];
  if (agent && !DONE.has(t.status)) marks.push(agentMark(agent));
  if (agent?.processes?.length) marks.push(processMark(agent.processes));
  if (agent?.merging) marks.push(mergingMark(agent));
  else if (agent?.conflict) marks.push(conflictMark(agent));
  if (t.comments) marks.push(el('span', { class: 'mark muted' }, plural(t.comments, 'comment')));
  const progress = t.checks.total ? el('span', { class: 'criteria', title: `${t.checks.done} of ${t.checks.total} criteria checked` },
    el('span', { class: 'progress' }, el('span', { style: `width:${Math.round(100 * t.checks.done / t.checks.total)}%` })),
    el('span', { class: 'progress-label' }, `${t.checks.done}/${t.checks.total}`)) : null;
  const excerpt = plainText(t.summary);
  const blockers = t.openBlockers.map(n => `#${n}`).join(', ');

  const next = nextCommand(t);
  const movable = Object.values(t.actions.moves).some(m => m.ok);
  const card = el('div', {
    ...cardAttrs(t, 'card'), draggable: movable ? 'true' : null,
    ondragstart: e => { state.dragging = t; e.dataTransfer.setData('text/plain', t.id); e.dataTransfer.effectAllowed = 'move'; card.classList.add('dragging'); },
    ondragend: () => { state.dragging = null; card.classList.remove('dragging'); },
  },
    el('div', { class: 'card-top' },
      el('span', { class: 'card-num' }, label(t)),
      t.type ? el('span', {}, t.type) : null,
      state.feature === ALL ? el('span', { class: 'card-feature' }, t.feature) : null,
      t.blocked ? el('span', { class: 'card-blocked', title: `Waiting on ${blockers}` }, `blocked by ${blockers}`)
        : !DONE.has(t.status) && t.blockedBy.length ? el('span', { class: 'card-unblocked', title: 'All blockers are done' }, '✓ unblocked') : null,
      next ? el('button', {
        class: 'copy-btn', title: `Copy "${next.text}"`, 'aria-label': `Copy ${next.what}`,
        onclick: e => { e.stopPropagation(); copy(next.text, next.what); },
        onkeydown: e => e.stopPropagation(),
      }, '⧉') : null),
    el('div', { class: 'card-title' }, t.title),
    excerpt ? el('div', { class: 'card-excerpt', title: excerpt }, excerpt) : null,
    marks.length || progress ? el('div', { class: 'card-foot' }, marks, el('span', { class: 'spacer' }), progress) : null);
  return card;
}

// What every ticket card shares: class `cls`, selected and dim states, and opening the ticket by click, Enter or Space.
function cardAttrs(t, cls) {
  return {
    class: cls + (state.ticket === t.id ? ' selected' : '') + (DONE.has(t.status) ? ' dim' : ''),
    tabindex: '0', role: 'button',
    onclick: () => openTicket(t.id),
    onkeydown: onActivate(() => openTicket(t.id)),
  };
}

// The Strip layout's one-line card: number, title, the agent's mark and the criteria progress.
function renderRowCard(t) {
  const a = agentOf(t);
  return el('div', { ...cardAttrs(t, 'row-card'), title: t.title },
    el('span', { class: 'card-num' }, label(t)),
    el('span', { class: 'row-title' }, t.title),
    rowAgentMark(t, a),
    rowMarks(t, a).needsYou ? el('span', { class: 'row-needs-you', title: 'The agent needs you' }, '⚠') : null,
    rowProgress(t));
}

// The Strip and List rows' agent mark: the running dot or ✓ (rowMarks in view.js).
function rowAgentMark(t, a) {
  const { running, done } = rowMarks(t, a);
  return running ? el('span', { class: 'run-dot', title: 'Agent running' })
    : done ? el('span', { class: 'row-done', title: 'Agent done' }, '✓') : null;
}

// The Strip and List rows' criteria progress, "n/m".
function rowProgress(t) {
  return t.checks.total ? el('span', { class: 'row-progress', title: `${t.checks.done} of ${t.checks.total} criteria checked` }, `${t.checks.done}/${t.checks.total}`) : null;
}

// A List layout group: a header button that opens or closes it, then a row per ticket while it's open.
// A closed group still shows the selected ticket's row, so a ticket opened from the URL or another layout stays in view.
function renderGroup({ status, tickets }) {
  const name = laneName(status);
  const open = !state.collapsedGroups.includes(status);
  const rows = open ? tickets : tickets.filter(t => t.id === state.ticket);
  return el('section', { class: 'group', style: `--lane-color:${laneColor(status)}` },
    el('button', {
      class: 'group-head', type: 'button', 'aria-expanded': String(open), 'data-group-toggle': status, onclick: () => toggleGroup(status),
    },
      el('span', { class: 'chevron', 'aria-hidden': 'true' }, open ? '▾' : '▸'),
      el('span', { class: 'dot' }), el('span', { class: 'lane-name' }, name), el('span', { class: 'count' }, tickets.length)),
    rows.length ? el('div', { class: 'group-rows' }, rows.map(renderListRow)) : null);
}

// Opens or closes the List group `status`, and keeps keyboard focus on its header.
function toggleGroup(status) {
  const closed = state.collapsedGroups.includes(status);
  state.collapsedGroups = closed ? state.collapsedGroups.filter(s => s !== status) : [...state.collapsedGroups, status];
  savePrefs();
  render();
  [...$('board').querySelectorAll('[data-group-toggle]')].find(b => b.dataset.groupToggle === status)?.focus();
}

// A List layout row: number, title, the agent's mark and the criteria progress, then a muted line of what else to know.
function renderListRow(t) {
  const a = agentOf(t);
  const note = listNote(t, a);
  return el('div', cardAttrs(t, 'list-row'),
    el('span', { class: 'card-num' }, label(t)),
    el('span', { class: 'list-title' }, t.title),
    el('span', { class: 'list-marks' }, rowAgentMark(t, a), rowProgress(t)),
    note ? el('span', { class: 'list-note' }, note) : null);
}

// The agent's state on a card, as coloured text. Cards in resolved and wontfix lanes show none.
function agentMark(a) {
  const mark = (cls, attrs, ...text) => el('span', { class: `mark ${cls}`, ...attrs }, ...text);
  switch (a.state) {
    case 'starting': return mark('running', {}, el('span', { class: 'run-dot' }), 'Agent starting');
    case 'running': return mark('running', { title: `Working on ${a.branch}` }, el('span', { class: 'run-dot' }), 'Agent running');
    case 'waiting': return mark('waiting', { title: `Attach to answer: ${attachCommand(a)}` }, `⚠ Needs you: ${a.waitingFor}`);
    case 'idle': return mark('idle', { title: 'The agent ended its turn without committing; it probably asked you something' }, '💬 Waiting for a reply');
    case 'done': return mark('done', { title: a.branch }, '✓ Agent done');
    case 'failed': return mark('failed', { title: a.error || '' }, '✕ Agent failed to start');
    default: return mark('stopped', { title: 'The session is not running; attaching reopens it' }, '■ Agent stopped');
  }
}

// Shown in every lane: a server left running after approval is exactly what you want to notice.
function processMark(procs) {
  const title = procs.map(p => `${p.pid}: ${p.command}`).join('\n');
  return el('span', { class: 'mark warn', title }, `⚙ ${plural(procs.length, 'process')}`);
}

// A test merge of the ticket's branch into its reference branch fails.
function conflictMark(a) {
  const title = `Merging ${a.branch} into ${a.ref} conflicts in:\n${a.conflict.files.join('\n')}`;
  return el('span', { class: 'mark failed', title }, `⚔ Conflicts (${plural(a.conflict.files.length, 'file')})`);
}

// The ticket's worktree is mid-merge (MERGE_HEAD exists), whoever started the merge.
const mergingText = a => `⚔ merge in progress (${a.merging.unresolved} unresolved)`;
function mergingMark(a) {
  return el('span', { class: 'mark warn', title: `Merging ${a.ref || 'a branch'} into ${a.branch} in the worktree: finish or abort it in the drawer` }, mergingText(a));
}


// The agent's state as coloured text next to the Agent section's heading.
function agentStateLabel(a) {
  const label = (state, attrs, ...text) => el('span', { class: `mark state-label ${state}`, ...attrs }, ...text);
  switch (a.state) {
    case 'starting': return label('running', {}, el('span', { class: 'run-dot' }), 'starting');
    case 'running': return label('running', { title: `Working on ${a.branch}` }, el('span', { class: 'run-dot' }), 'running');
    case 'waiting': return label('waiting', { title: `Attach to answer: ${attachCommand(a)}` }, `⚠ needs you: ${a.waitingFor}`);
    case 'idle': return label('idle', { title: 'The agent ended its turn without committing; it probably asked you something' }, '💬 waiting for a reply');
    case 'done': return label('done', { title: a.branch }, '✓ done');
    case 'failed': return label('failed', { title: a.error || '' }, '✕ failed to start');
    default: return label('stopped', { title: 'The session is not running; attaching reopens it' }, '■ stopped');
  }
}

function openTicket(id) {
  state.ticket = id;
  state.commandsOpen = false;
  state.detail = null;
  state.structure = null;
  writeHash();
  render();
  loadDetail();
}
function closeTicket() {
  state.ticket = null;
  state.commandsOpen = false;
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
  // The focused control (by its data-focus key) gets focus back once it's redrawn, so the keyboard keeps its place.
  const focused = drawer.contains(document.activeElement) ? document.activeElement.dataset.focus : null;
  draw();
  if (focused) drawer.querySelector(`[data-focus="${focused}"]`)?.focus();
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
  // Strip and List always have their detail panel, saying so when nothing is selected.
  $('detailEmpty').hidden = !!t || state.layout === 'board';
  if (!t) { drawer.hidden = true; setCommandsOpen(false); return; }
  drawer.hidden = false;
  const a = agentOf(t);

  fill($('drawerMeta'),
    el('span', { class: 'meta-num' }, label(t)),
    el('span', {}, t.feature),
    el('span', { class: 'status-pill', style: `--lane-color:${laneColor(t.status)}` }, el('span', { class: 'dot' }), laneName(t.status)),
    t.type ? el('span', { class: 'type-chip' }, t.type) : null);
  $('drawerTitle').textContent = t.title;
  renderCommands(t, a);

  renderActions(t, a);
  renderAgent();
  renderTicket(t);
  document.querySelectorAll('.card.selected, .row-card.selected, .list-row.selected').forEach(c => c.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
}

// The Ticket section: its blockers, then its subsections as parseSections (lib/tickets.mjs) splits them.
function renderTicket(t) {
  // The tickets this one is blocked by and blocks.
  const byNum = new Map(currentTickets().filter(o => o.feature === t.feature).map(o => [Number(o.number), o]));
  const link = n => {
    const o = byNum.get(Number(n));
    const open = o && !DONE.has(o.status);
    return el('button', {
      class: 'badge' + (open ? ' blocked' : ''), title: o ? `${o.title} (${o.status || 'no status'})` : 'Not found',
      onclick: () => o && openTicket(o.id),
    }, `#${n}`);
  };
  const blocker = t.openBlockers.length === 1 ? byNum.get(Number(t.openBlockers[0])) : null;
  fill($('drawerTicket'),
    el('div', { class: 'ticket-head' },
      el('h3', {}, 'Ticket'),
      el('span', { class: 'spacer' }),
      btn('Copy issue path', { class: 'btn ghost', title: `Copy "${t.absPath}"` }, () => copy(t.absPath, 'issue path'))),
    t.blocked ? el('div', { class: 'blocked-note' },
      `Blocked by ${t.openBlockers.map(n => `#${n}`).join(', ')}${blocker ? ` · ${blocker.title}` : ''}`) : null,
    t.blockedBy.length || t.blocks.length ? el('div', { class: 'links-row' },
      t.blockedBy.length ? el('span', {}, 'Blocked by') : null, t.blockedBy.map(link),
      t.blocks.length ? el('span', {}, 'Blocks') : null, t.blocks.map(link)) : null,
    t.sections.map(s => renderSection(t, s)));
}

// A div of class `cls` with `md` rendered as markdown; null without markdown.
function markdownDiv(cls, md) {
  if (!md) return null;
  const div = el('div', { class: `markdown ${cls}` });
  div.innerHTML = renderMarkdown(md);
  return div;
}

function renderSection(t, s) {
  const markdownBlock = (md, cls = '') => markdownDiv(`ticket-text ${cls}`, md);
  const inlineMarkdown = (tag, attrs, md) => { const n = el(tag, attrs); n.innerHTML = inline(md); return n; };
  const head = s.label ? el('div', { class: 'ticket-label' }, s.label) : null;
  if (s.key === 'criteria') {
    const done = s.items.filter(i => i.done).length;
    return el('div', { class: 'ticket-sub criteria-list' },
      s.items.length ? el('div', { class: 'criteria-head', title: `${done} of ${s.items.length} criteria checked` },
        head,
        el('span', { class: 'progress' }, el('span', { style: `width:${Math.round(100 * done / s.items.length)}%` })),
        el('span', { class: 'progress-label' }, `${done}/${s.items.length}`)) : head,
      s.items.map((i, n) => el('div', {
        class: 'criterion' + (i.done ? ' done' : ''), role: 'checkbox', tabindex: '0', 'aria-checked': String(i.done),
        'data-focus': `criterion-${n}`, title: i.done ? 'Untick' : 'Tick',
        onclick: () => toggleCriterion(t, n, i),
        onkeydown: onActivate(() => toggleCriterion(t, n, i)),
      },
        el('span', { class: 'checkbox', 'aria-hidden': 'true' }, i.done ? '✓' : ''),
        inlineMarkdown('span', { class: 'criterion-text' }, i.text))),
      markdownBlock(s.body));
  }
  if (s.key === 'outOfScope') {
    return el('div', { class: 'ticket-sub' }, head,
      s.items.map(i => inlineMarkdown('div', { class: 'out-of-scope' }, i)),
      markdownBlock(s.body));
  }
  return el('div', { class: 'ticket-sub' }, head, markdownBlock(s.body, s.key === 'cause' || s.key === 'fix' ? 'quiet' : ''));
}

// The header's Commands menu: copy commands and paths, or a /triage move, so the agent makes the move (and writes the brief).
function renderCommands(t, a) {
  const item = (text, copyText, what, attrs = {}) => el('button', {
    class: 'menu-item', role: 'menuitem', type: 'button', title: copyText ? `Copy "${copyText}"` : null, ...attrs,
    onclick: () => { setCommandsOpen(false); if (copyText) copy(copyText, what); },
  }, text);
  fill($('commandsMenu'),
    item('Copy /implement', implementCommand(t), '/implement command'),
    item('Copy /triage', triageCommand(t), '/triage command'),
    item('Copy issue path', t.absPath, 'issue path'),
    a?.worktree ? item('Copy worktree path', a.worktree, 'worktree path') : null,
    el('div', { class: 'menu-divider', role: 'separator' }),
    el('div', { class: 'menu-label', id: 'moveLabel' }, 'Move via /triage'),
    el('div', { role: 'group', 'aria-labelledby': 'moveLabel' },
      // Every status, in lane order; the current one is highlighted and copies nothing.
      KNOWN_COLORS.map(s => {
        const text = [el('span', { class: 'dot', style: `--lane-color:${laneColor(s)}` }), s];
        return s === t.status
          ? item(text, null, null, { class: 'menu-item current', 'aria-current': 'true' })
          : item(text, triageCommand(t, s), '/triage command');
      })));
  setCommandsOpen(state.commandsOpen);
}

function setCommandsOpen(open) {
  state.commandsOpen = open;
  $('commandsMenu').hidden = !open;
  $('commandsBtn').setAttribute('aria-expanded', String(open));
}

// The ticket's action buttons by name, each a function giving [text, attrs, onclick], wired to the server's ticket
// action, which disables it with its reason when refused. `a`: the ticket's agent, for the buttons that need one.
function actionButtons(t, a) {
  const { start, stop, resolveConflicts, mergeByHand, moves } = t.actions;
  const d = state.detail?.id === t.id ? state.detail : null;
  return {
    approve: () => ['✓ Approve', refused(moves.resolved, { title: `Mark resolved, stop the session and its worktree processes, and copy the command that merges ${a.branch} into ${a.ref || 'the branch you are on'}` }), async () => {
      const conflict = a.conflict;
      const result = await moveTicket(t, 'resolved');
      if (!result) return;
      // Copying shows its own toast, so repeat the stopped count and any merge conflict in it.
      const warning = conflict ? ` · ⚔ it conflicts with ${a.ref} in ${plural(conflict.files.length, 'file')}` : '';
      const copied = await copy(mergeCommand(a), 'merge command');
      if (result.stopped || warning) toast(`${copied ? 'Copied merge command' : 'Could not copy merge command'}${warning}${stoppedNote(result)}`);
    }],
    // The merge-base with the reference branch, once the detail has loaded.
    diff: () => ['Open diff in meld', { title: `git difftool -d ${(d?.changes?.base || a.base || '').slice(0, 8)} in the worktree` }, () => api('/api/agent/diff', { id: t.id })],
    stop: () => ['■ Stop agent', refused(stop, { title: 'Stop the session; its conversation is kept' }), () => api('/api/agent/stop', { id: t.id })],
    attach: () => ['Copy attach command', { title: `${attachCommand(a)}: open the session in your terminal to watch it, answer prompts or reply` }, () => copy(attachCommand(a), 'attach command')],
    continue: () => ['↻ Continue agent', refused(start, { title: 'Resume the session in the background and tell it to carry on' }), () => api('/api/agent/start', { id: t.id })],
    back: () => ['Back to ready-for-agent', refused(moves['ready-for-agent'], {}), () => moveTicket(t, 'ready-for-agent')],
    start: () => [start.resume ? '▶ Continue agent' : '▶ Start agent', refused(start, { title: 'Claim the ticket and run /implement as a background session' }), () => moveTicket(t, 'claimed')],
    implement: () => ['Copy /implement', { title: `Copy "${implementCommand(t)}"` }, () => copy(implementCommand(t), '/implement command')],
    triage: () => ['Copy /triage', { title: `Copy "${triageCommand(t)}"` }, () => copy(triageCommand(t), '/triage command')],
    markResolved: () => ['Mark resolved', refused(moves.resolved, { title: 'Move the ticket to resolved' }), () => moveTicket(t, 'resolved')],
    resolveConflicts: () => ['⚔ Resolve conflicts', refused(resolveConflicts, {
      title: `Move the ticket to claimed and have the agent merge ${a.ref} into ${a.branch} (merge, not rebase), resolve ${plural(a.conflict.files.length, 'file')}, run the tests and commit. Nothing is added to the ticket's ## Comments`,
    }), async () => {
      if (await api('/api/agent/resolve-conflicts', { id: t.id })) toast(`${label(t)}: agent is resolving the merge conflict · claude attach to watch`);
    }],
    mergeByHand: () => ['⇆ Resolve in meld', refused(mergeByHand, {
      title: `git merge --no-edit ${a.ref} in the worktree, then git mergetool --tool=meld on the conflicts. Refused with uncommitted changes. The ticket stays in its lane`,
    }), async () => {
      const result = await api('/api/agent/merge', { id: t.id });
      if (result) toast(result.clean ? `${label(t)}: merged ${a.ref} cleanly and committed` : `${label(t)}: ${plural(result.unresolved, 'file')} to resolve · opening meld`);
    }],
  };
}

// The header's primary actions: only those for the ticket's current state (headerActions in view.js).
function renderActions(t, a) {
  const make = actionButtons(t, a);
  const { buttons, note } = headerActions(t, a);
  fill($('drawerActions'),
    buttons.map(({ name, style }) => {
      const [text, attrs, onclick] = make[name]();
      return btn(text, { ...attrs, class: `btn lg ${style}` }, onclick);
    }),
    note ? el('span', { class: 'muted' }, note) : null);
}

// The Agent section: what the agent did (its final message as a summary and report), its changes, and sending it back
// with notes; or, without an agent, how to get one going (noAgentPrompt in view.js).
function renderAgent() {
  const box = $('drawerAgent');
  const t = state.ticket && findTicket(state.ticket);
  const a = t && agentOf(t);
  const d = state.detail?.id === t?.id ? state.detail : null;
  const empty = t && !a ? noAgentPrompt(t) : null;
  // Empty it too: the previous ticket's buttons (Stop agent) are bound to that ticket.
  if (!t || (!a && !empty)) { box.hidden = true; box.replaceChildren(); return; }
  box.hidden = false;
  if (!a) return fill(box, el('div', { class: 'agent-title' }, el('h3', {}, agentHeading(null))), renderNoAgent(t, empty));

  // Loaded afresh each time the ticket comes (back) into review.
  if (!wantsStructure(t) && state.structure?.id === t.id) state.structure = null;
  const pending = a.state === 'waiting' && d?.items.at(-1)?.kind === 'tool' ? d.items.at(-1).text : null;
  const final = d?.lastMessage && ['idle', 'done', 'stopped'].includes(a.state) ? d.lastMessage : null;
  const changes = d?.changes;
  fill(box,
    el('div', { class: 'agent-title' },
      el('h3', {}, agentHeading(a)),
      agentStateLabel(a)),
    pending ? el('div', { class: 'pending', 'data-keep': 'pending' },
      el('div', { class: 'pending-label' }, 'Waiting to run'),
      el('code', {}, pending),
      el('div', { class: 'muted' }, `Attach to answer: ${attachCommand(a)}`)) : null,
    el('div', { class: 'agent-head' },
      badgeButton(el('code', {}, a.branch), a.branch, 'branch'),
      a.hostname ? badgeButton(el('code', {}, a.hostname), a.hostname, 'agent hostname') : null,
      a.error ? el('span', { class: 'badge blocked' }, a.error) : null),
    final ? renderReport(final, a.reviewNotes) : null,
    renderMerge(t, a),
    a.processes?.length ? renderProcesses(t, a.processes, a.hostname) : null,
    changes ? el('details', { class: 'changes', 'data-keep': 'changes', open: t.status === 'ready-for-review' },
      el('summary', {}, `${plural(changes.commits.length, 'commit')}${changes.dirty ? ' · uncommitted changes' : ''}`),
      changes.commits.length ? el('ul', { class: 'commits' }, changes.commits.map(c => el('li', {}, c))) : null,
      changes.stat ? el('pre', {}, changes.stat) : null) : null,
    t.status === 'ready-for-review' ? renderSendBack(t, a, d) : null,
    d?.items.length ? el('details', { class: 'activity', 'data-keep': 'activity', open: !!a.busy },
      el('summary', {}, `Agent activity · ${plural(d.items.length, 'step')}`),
      el('ol', { 'data-keep': 'activity-list', 'data-follow': true }, d.items.map(x => el('li', { class: x.kind }, x.text)))) : null);
}

// A ticket without an agent: why, and the one thing to do about it (Start agent only when the server offers it).
function renderNoAgent(t, { text, action, blocked }) {
  const shown = action !== 'start' || !!t.actions.start;
  const [buttonText, attrs, onclick] = shown ? actionButtons(t, null)[action]() : [];
  return el('div', { class: 'no-agent' },
    el('p', {}, text),
    blocked ? el('p', { class: 'blocked-note' }, blocked) : null,
    shown ? el('div', { class: 'agent-actions' }, btn(buttonText, { ...attrs, class: 'btn primary' }, onclick)) : null);
}

// The agent's final message: its prose as the summary, its `- **Label:** text` bullets as report rows (splitReport in
// view.js), then the review notes it was last sent back with, and anything else it wrote. Without such bullets, the whole message.
function renderReport(message, reviewNotes) {
  const { summary, items, rest } = splitReport(message);
  const rows = [...items, ...(reviewNotes ? [{ label: 'Review', text: reviewNotes }] : [])];
  return el('div', { class: 'report' },
    markdownDiv('agent-summary', summary),
    rows.length ? el('div', { class: 'report-items' },
      rows.flatMap(r => [el('div', { class: 'report-label' }, r.label), markdownDiv('report-value', r.text)])) : null,
    markdownDiv('agent-summary rest', rest));
}

// Sending a ticket in review back to its agent, with notes; codemap's structure diff fills them with its flagged notes.
function renderSendBack(t, a, d) {
  // Kept in state, so the board's live reloads don't wipe what you've written.
  const notes = el('textarea', {
    id: 'sendBackNotes', class: 'notes', rows: 3, placeholder: 'Notes go to the agent\'s session and are added to the ticket\'s ## Comments',
    oninput: e => { state.notes[t.id] = e.target.value; },
  });
  notes.value = state.notes[t.id] || '';
  const structure = wantsStructure(t);
  if (structure && state.structure?.id !== t.id) loadStructure(t.id, true);
  // The merge-base with the reference branch, once the detail has loaded.
  const since = (d?.changes?.base || a.base).slice(0, 8);
  return el('div', { class: 'review' },
    structure ? el('div', { class: 'agent-actions' },
      btn(state.structure?.opening ? '⌗ Opening structure diff…' : '⌗ Open structure diff', {
        disabled: !!state.structure?.opening,
        title: `codemap view: the structural changes since ${since}, to mark OK or Flag`,
      }, () => openStructureDiff(t))) : null,
    structure ? renderStructure(t, notes) : null,
    el('div', { class: 'send-back' },
      el('label', { class: 'send-back-label', for: 'sendBackNotes' }, 'Send back with notes'),
      notes,
      el('div', { class: 'send-back-row' },
        btn('↩ Send back to agent', refused(t.actions.moves.claimed, { title: 'Resume the agent\'s session with your notes' }), () => {
          if (!notes.value.trim()) return toast('Add review notes first');
          moveTicket(t, 'claimed', notes.value.trim()).then(ok => { if (ok) delete state.notes[t.id]; });
        }),
        el('span', { class: 'muted' }, 'The agent resumes on the same branch.'))));
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

// A keydown handler that runs `fn` on Enter or Space, as a click would.
function onActivate(fn) { return e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(); } }; }

function btn(text, attrs, onclick) { return el('button', { class: 'btn', ...attrs, onclick }, text); }
// A ticket action's button attributes: disabled when refused, with the reason as its tooltip.
function refused(action, attrs) { return { ...attrs, disabled: !action.ok, title: action.why || attrs.title }; }

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, 2400);
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
  es.onopen = () => { $('live').hidden = true; };
  es.onerror = () => { $('live').hidden = false; };
}

// Picking a project yourself, in the select or from its alert.
// `toAlerts`: opened from its project alert, so the board lands on what the alert is about.
function switchProject(id, toAlerts = false) {
  selectProject(id);
  state.toAlerts = toAlerts;
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
$('search').addEventListener('input', e => { state.query = e.target.value; render(); });
$('unblockedOnly').addEventListener('click', () => { state.unblockedOnly = !state.unblockedOnly; savePrefs(); renderToolbar(); render(); });
$('drawerClose').addEventListener('click', closeTicket);
$('commandsBtn').addEventListener('click', () => setCommandsOpen(!state.commandsOpen));
// Arrow keys move between the menu's items; ArrowDown on the button opens it on the first one.
$('commands').addEventListener('keydown', e => {
  if (!['ArrowDown', 'ArrowUp'].includes(e.key)) return;
  e.preventDefault();
  if (!state.commandsOpen) setCommandsOpen(true);
  const items = [...$('commandsMenu').querySelectorAll('.menu-item')];
  const i = items.indexOf(document.activeElement);
  const next = i < 0 ? (e.key === 'ArrowDown' ? 0 : items.length - 1) : (i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
  items[next].focus();
});
document.addEventListener('click', e => { if (state.commandsOpen && !$('commands').contains(e.target)) setCommandsOpen(false); });
document.addEventListener('keydown', e => {
  if (projectsDialogOpen()) return; // the dialog has its own keys (Escape closes it)
  // Escape closes the Commands menu first, then the panel.
  if (e.key === 'Escape' && state.commandsOpen) { setCommandsOpen(false); $('commandsBtn').focus(); return; }
  if (e.key === 'Escape' && state.ticket) closeTicket();
  const typing = ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName);
  if (e.key === 'c' && !typing && !e.ctrlKey && !e.metaKey && !e.altKey) {
    const t = state.ticket && findTicket(state.ticket);
    const next = t && (nextCommand(t) || { text: implementCommand(t), what: '/implement command' });
    if (next) copy(next.text, next.what);
  }
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
renderToolbar();
loadProjects().then(load).then(connectEvents).catch(e => toast(`Failed to load tickets: ${e.message}`));
