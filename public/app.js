'use strict';

const ALL = '__all__';
const NO_STATUS = '';
const KNOWN_COLORS = ['needs-triage', 'needs-info', 'ready-for-agent', 'ready-for-human', 'claimed', 'resolved', 'wontfix'];
const DONE = new Set(['resolved', 'done', 'closed', 'wontfix']);

const $ = id => document.getElementById(id);
const state = { data: null, feature: null, ticket: null, query: '', hideEmpty: false, unblockedOnly: false };

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

async function moveTicket(id, status) {
  const t = findTicket(id);
  if (!t || t.status === status || status === NO_STATUS) return;
  const prev = t.status;
  t.status = status; // optimistic; the file watcher will send the real state
  render();
  const res = await fetch('/api/status', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, status }),
  });
  if (!res.ok) {
    t.status = prev;
    render();
    const err = await res.json().catch(() => ({}));
    toast(`Could not update: ${err.error || res.status}`);
  } else {
    toast(`${label(t)} → ${status}`);
  }
}

// ---- rendering --------------------------------------------------------------------------
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
  renderDrawer();
}

function renderLane(status, cards) {
  const body = el('div', { class: 'lane-body', 'data-status': status },
    cards.length ? cards.map(renderCard) : el('div', { class: 'empty' }, 'No tickets'));
  const lane = el('section', { class: 'lane', style: `--lane-color:${laneColor(status)}` },
    el('div', { class: 'lane-head' },
      el('span', { class: 'dot' }), status || 'no status', el('span', { class: 'count' }, cards.length)),
    body);

  if (status !== NO_STATUS) {
    lane.addEventListener('dragover', e => { e.preventDefault(); lane.classList.add('drop'); });
    lane.addEventListener('dragleave', e => { if (!lane.contains(e.relatedTarget)) lane.classList.remove('drop'); });
    lane.addEventListener('drop', e => {
      e.preventDefault();
      lane.classList.remove('drop');
      const id = e.dataTransfer.getData('text/ticket-id');
      if (id) moveTicket(id, status);
    });
  }
  return lane;
}

function renderCard(t) {
  const pct = t.checks.total ? Math.round(100 * t.checks.done / t.checks.total) : 0;
  const foot = [];
  if (t.blocked) foot.push(el('span', { class: 'badge blocked', title: `Waiting on ${t.openBlockers.join(', ')}` }, `⛔ blocked by ${t.openBlockers.join(', ')}`));
  else if (!DONE.has(t.status) && t.blockedBy.length) foot.push(el('span', { class: 'badge ready', title: 'All blockers are done' }, '✓ unblocked'));
  if (t.type) foot.push(el('span', { class: 'badge' }, t.type));
  if (t.comments) foot.push(el('span', { class: 'badge', title: 'Comments' }, `💬 ${t.comments}`));
  if (t.checks.total) {
    foot.push(el('span', { class: 'progress', title: `${t.checks.done} of ${t.checks.total} criteria checked` }, el('span', { style: `width:${pct}%` })));
    foot.push(el('span', { class: 'progress-label' }, `${t.checks.done}/${t.checks.total}`));
  }

  const card = el('div', {
    class: 'card' + (state.ticket === t.id ? ' selected' : ''),
    style: `--lane-color:${laneColor(t.status)}`,
    draggable: 'true', tabindex: '0', role: 'button',
    onclick: () => openTicket(t.id),
    onkeydown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openTicket(t.id); } },
    ondragstart: e => { e.dataTransfer.setData('text/ticket-id', t.id); e.dataTransfer.effectAllowed = 'move'; card.classList.add('dragging'); },
    ondragend: () => card.classList.remove('dragging'),
  },
    el('div', { class: 'card-top' },
      el('span', { class: 'card-num' }, label(t)),
      state.feature === ALL ? el('span', { class: 'card-feature' }, `· ${t.feature}`) : null),
    el('div', { class: 'card-title' }, t.title),
    t.summary ? el('div', { class: 'card-summary' }, t.summary) : null,
    foot.length ? el('div', { class: 'card-foot' }, foot) : null);
  return card;
}

function openTicket(id) {
  state.ticket = id;
  writeHash();
  render();
}
function closeTicket() {
  state.ticket = null;
  writeHash();
  render();
}

function renderDrawer() {
  const drawer = $('drawer');
  const t = state.ticket && findTicket(state.ticket);
  if (!t) { drawer.hidden = true; return; }
  drawer.hidden = false;

  const lanes = laneList(currentTickets()).filter(s => s !== NO_STATUS);
  if (t.status && !lanes.includes(t.status)) lanes.push(t.status);
  const statusSel = el('select', { 'aria-label': 'Status', onchange: e => moveTicket(t.id, e.target.value) },
    t.status ? null : el('option', { value: '' }, 'no status'),
    lanes.map(s => el('option', { value: s }, s)));
  statusSel.value = t.status || '';

  fill($('drawerMeta'),
    el('span', { class: 'card-num' }, label(t)), el('span', {}, `· ${t.feature}`), statusSel,
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
  fill($('drawerLinks'),
    t.blockedBy.length ? el('span', {}, 'Blocked by') : null, t.blockedBy.map(link),
    t.blocks.length ? el('span', {}, 'Blocks') : null, t.blocks.map(link),
    el('code', { title: 'File' }, `${t.feature}/issues/${t.file}`));
  $('drawerBody').innerHTML = renderMarkdown(t.body);
  document.querySelectorAll('.card.selected').forEach(c => c.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
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
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && state.ticket) closeTicket();
  if (e.key === '/' && document.activeElement.tagName !== 'INPUT') { e.preventDefault(); $('search').focus(); }
});
window.addEventListener('hashchange', () => { readHash(); if (state.data) { renderFeatureSelect(); render(); } });

loadPrefs();
readHash();
$('hideEmpty').checked = state.hideEmpty;
$('unblockedOnly').checked = state.unblockedOnly;
load().then(connectEvents).catch(e => toast(`Failed to load tickets: ${e.message}`));
