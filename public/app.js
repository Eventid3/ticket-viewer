'use strict';

const ALL = '__all__';
const NO_STATUS = '';
const KNOWN_COLORS = ['needs-triage', 'needs-info', 'ready-for-agent', 'ready-for-human', 'claimed', 'ready-for-review', 'resolved', 'wontfix'];
const DONE = new Set(['resolved', 'done', 'closed', 'wontfix']);

const $ = id => document.getElementById(id);
const state = { data: null, feature: null, ticket: null, query: '', hideEmpty: false, unblockedOnly: false, detail: null, dragging: null };

// ---- state <-> URL hash / localStorage ------------------------------------------------
function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  if (p.has('feature')) state.feature = p.get('feature');
  state.ticket = p.get('ticket');
}
function writeHash() {
  const p = new URLSearchParams();
  if (state.feature) p.set('feature', state.feature);
  if (state.ticket) p.set('ticket', state.ticket);
  history.replaceState(null, '', '#' + p.toString());
}
function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem('ticket-viewer') || '{}');
    state.hideEmpty = !!p.hideEmpty;
    state.unblockedOnly = !!p.unblockedOnly;
  } catch { /* storage unavailable */ }
}
function savePrefs() {
  try { localStorage.setItem('ticket-viewer', JSON.stringify({ hideEmpty: state.hideEmpty, unblockedOnly: state.unblockedOnly })); } catch { }
}

// ---- data -------------------------------------------------------------------------------
async function load() {
  const res = await fetch('/api/tickets');
  state.data = await res.json();
  const names = state.data.features.map(f => f.name);
  if (state.feature !== ALL && !names.includes(state.feature)) state.feature = names[0];
  renderFeatureSelect();
  render();
  loadDetail();
}

function agentOf(t) { return state.data.agents?.[t.id] || null; }
// The session is working or waiting on you, so it may still change the worktree.
function agentBusy(a) { return !!a && ['starting', 'running', 'waiting'].includes(a.state); }

// Status changes the board may make itself (the server enforces the same list).
function canMove(t, to) {
  if (!(state.data.moves[t.status] || []).includes(to)) return false;
  if (t.status === 'claimed' && agentBusy(agentOf(t))) return false;
  return !(to === 'claimed' && (t.blocked || !state.data.agents));
}

async function api(path, body) {
  const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (res.ok) return true;
  const err = await res.json().catch(() => ({}));
  toast(err.error || `Request failed (${res.status})`);
  return false;
}

async function moveTicket(t, to, notes) {
  if (!(await api('/api/move', { id: t.id, to, notes }))) return false;
  toast(to === 'claimed' ? `${label(t)}: agent started · claude attach to watch` : `${label(t)} → ${to}`);
  return true;
}

// Agent log, commits and diff stat for the open ticket; polled while its agent runs.
async function loadDetail() {
  clearTimeout(loadDetail.timer);
  const t = state.ticket && findTicket(state.ticket);
  if (!t || !agentOf(t)) { state.detail = null; keepDrawerView(renderAgent); return; }
  const res = await fetch(`/api/agent?id=${encodeURIComponent(t.id)}`);
  state.detail = res.ok ? { id: t.id, ...(await res.json()) } : null;
  keepDrawerView(renderAgent);
  if (agentBusy(state.detail?.record)) loadDetail.timer = setTimeout(loadDetail, 3000);
}

function currentTickets() {
  const feats = state.data.features.filter(f => state.feature === ALL || f.name === state.feature);
  return feats.flatMap(f => f.tickets);
}

function findTicket(id) {
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
    if (!ok) return toast(`Could not copy ${what}`);
  }
  toast(`Copied ${what}: ${text}`);
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

function renderFeatureSelect() {
  const sel = $('feature');
  const feats = state.data.features;
  sel.replaceChildren(
    ...(feats.length > 1 ? [el('option', { value: ALL }, 'All features')] : []),
    ...feats.map(f => el('option', { value: f.name }, `${f.name} (${f.tickets.length})`)),
  );
  sel.value = state.feature;
}

function render() {
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
  if (t.type) foot.push(el('span', { class: 'badge' }, t.type));
  if (t.comments) foot.push(el('span', { class: 'badge', title: 'Comments' }, `💬 ${t.comments}`));
  if (t.checks.total) {
    foot.push(el('span', { class: 'progress', title: `${t.checks.done} of ${t.checks.total} criteria checked` }, el('span', { style: `width:${pct}%` })));
    foot.push(el('span', { class: 'progress-label' }, `${t.checks.done}/${t.checks.total}`));
  }

  const next = nextCommand(t);
  const movable = (state.data.moves[t.status] || []).some(to => canMove(t, to));
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

function openTicket(id) {
  state.ticket = id;
  state.detail = null;
  writeHash();
  render();
  loadDetail();
}
function closeTicket() {
  state.ticket = null;
  state.detail = null;
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
  if (!t || (!a && t.status !== 'ready-for-agent')) { box.hidden = true; return; }
  box.hidden = false;
  const btn = (text, attrs, onclick) => el('button', { class: 'btn', ...attrs, onclick }, text);

  const busy = agentBusy(a);
  const actions = [];
  if (t.status === 'ready-for-agent') {
    const why = !state.data.agents ? 'Agents need the project to be a git repository' : t.blocked ? `Blocked by ${t.openBlockers.join(', ')}` : null;
    const verb = a?.sessionId ? '▶ Continue agent' : '▶ Start agent';
    actions.push(btn(verb, { class: 'btn primary', disabled: !!why, title: why || 'Claim the ticket and run /implement as a background session' }, () => moveTicket(t, 'claimed')));
  }
  // Start/Continue and meld are the next step in their lanes; otherwise attaching is, when the agent needs you.
  const needsYou = (a?.state === 'waiting' || a?.state === 'idle') && !['ready-for-agent', 'ready-for-review'].includes(t.status);
  if (a?.bgId) actions.push(btn('⧉ Copy attach', { class: `btn${needsYou ? ' primary' : ''}`, title: `${attachCommand(a)}: open the session in your terminal to watch it, answer prompts or reply` }, () => copy(attachCommand(a), 'attach command')));
  if (a?.bgId && a.state !== 'stopped' && a.state !== 'failed') actions.push(btn('■ Stop agent', { title: 'Stop the session; its conversation is kept' }, () => api('/api/agent/stop', { id: t.id })));
  if (t.status === 'claimed' && a && !busy) {
    actions.push(btn('↻ Continue agent', { title: 'Resume the session in the background and tell it to carry on' }, () => api('/api/agent/start', { id: t.id })));
    actions.push(btn('Back to ready-for-agent', {}, () => moveTicket(t, 'ready-for-agent')));
  }

  let review = null;
  if (t.status === 'ready-for-review' && a) {
    const notes = el('textarea', { class: 'notes', rows: 3, placeholder: 'Review notes: sent to the agent\'s session and added to the ticket\'s ## Comments' });
    review = el('div', { class: 'review' },
      el('div', { class: 'agent-actions' },
        btn('⇆ Open diff in meld', { class: 'btn primary', title: `git difftool -d ${a.base.slice(0, 8)} in the worktree` }, () => api('/api/agent/diff', { id: t.id })),
        btn('✓ Approve', { title: 'Mark resolved, stop the session and copy the merge command' }, async () => {
          if (await moveTicket(t, 'resolved')) copy(mergeCommand(a), 'merge command');
        }),
        btn('↩ Send back to agent', { title: 'Resume the agent\'s session with your notes' }, () => {
          if (!notes.value.trim()) return toast('Write what should change first');
          moveTicket(t, 'claimed', notes.value.trim());
        })),
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
      a?.error ? el('span', { class: 'badge blocked' }, a.error) : null),
    actions.length ? el('div', { class: 'agent-actions' }, actions) : null,
    last,
    review,
    changes ? el('details', { class: 'changes', 'data-keep': 'changes', open: t.status === 'ready-for-review' },
      el('summary', {}, `${changes.commits.length} commit${changes.commits.length === 1 ? '' : 's'}${changes.dirty ? ' · uncommitted changes' : ''}`),
      changes.commits.length ? el('ul', { class: 'commits' }, changes.commits.map(c => el('li', {}, c))) : null,
      changes.stat ? el('pre', {}, changes.stat) : null) : null,
    d?.items.length ? el('details', { class: 'activity', 'data-keep': 'activity', open: busy },
      el('summary', {}, 'Agent activity'),
      el('ol', { 'data-keep': 'activity-list', 'data-follow': true }, d.items.map(x => el('li', { class: x.kind }, x.text)))) : null);
}

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

// ---- wiring -----------------------------------------------------------------------------
function connectEvents() {
  const es = new EventSource('/api/events');
  es.addEventListener('change', () => load());
  es.onopen = () => $('live').classList.remove('off');
  es.onerror = () => $('live').classList.add('off');
}

$('feature').addEventListener('change', e => { state.feature = e.target.value; state.ticket = null; writeHash(); render(); });
$('search').addEventListener('input', e => { state.query = e.target.value.trim(); render(); });
$('hideEmpty').addEventListener('change', e => { state.hideEmpty = e.target.checked; savePrefs(); render(); });
$('unblockedOnly').addEventListener('change', e => { state.unblockedOnly = e.target.checked; savePrefs(); render(); });
$('drawerClose').addEventListener('click', closeTicket);
// The drawer covers the board's right edge, where the browser would auto-scroll during a drag,
// so dragging a card over the drawer scrolls the board on toward the lanes behind it.
$('drawer').addEventListener('dragover', () => { if (state.dragging) $('board').scrollLeft += 20; });
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && state.ticket) closeTicket();
  const typing = ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName);
  if (e.key === 'c' && !typing && !e.ctrlKey && !e.metaKey && !e.altKey) {
    const t = state.ticket && findTicket(state.ticket);
    const next = t && (nextCommand(t) || { text: implementCommand(t), what: '/implement command' });
    if (next) copy(next.text, next.what);
  }
  if (e.key === '/' && document.activeElement.tagName !== 'INPUT') { e.preventDefault(); $('search').focus(); }
});
window.addEventListener('hashchange', () => { readHash(); if (state.data) { renderFeatureSelect(); render(); } });

loadPrefs();
readHash();
$('hideEmpty').checked = state.hideEmpty;
$('unblockedOnly').checked = state.unblockedOnly;
load().then(connectEvents).catch(e => toast(`Failed to load tickets: ${e.message}`));
