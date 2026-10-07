// Reads and writes ticket files laid out as described in docs/agents/issue-tracker.md:
//   .scratch/<feature>/issues/NN-<slug>.md
import fs from 'node:fs';
import path from 'node:path';

// Keys recognised as ticket metadata. Other `**Key:**` lines (e.g. "What to build") are body text.
const META_KEYS = new Set(['status', 'type', 'blocked by', 'owner', 'assignee', 'priority', 'labels']);

// Statuses that count as finished: whether a ticket is still blocked, and whether a feature is completed.
export const DONE_STATUSES = new Set(['resolved', 'done', 'closed', 'wontfix']);

/** A completed feature has at least one ticket and every one of them is done; an empty feature still has work ahead. */
export function isFeatureCompleted(tickets) {
  return tickets.length > 0 && tickets.every(t => DONE_STATUSES.has(t.status));
}

// Matches `Status: x`, `**Status:** x`, `**Status**: x`, optionally as a list item.
const META_LINE = /^(\s*(?:[-*]\s+)?(?:\*\*|__)?)([A-Za-z][A-Za-z ]*?)((?::(?:\*\*|__))|(?:(?:\*\*|__):)|:)(\s*)(.*?)\s*$/;

/**
 * Resolves the folder passed on the command line to a list of feature folders.
 * Accepts the repo root (contains .scratch/), the .scratch folder itself, or one feature folder.
 */
export function resolveFeatures(projectDir) {
  const abs = path.resolve(projectDir);
  if (!isDir(abs)) throw new Error(`Not a folder: ${abs}`);

  if (isDir(path.join(abs, 'issues'))) {
    const scratchRoot = path.dirname(abs);
    return { scratchRoot, features: [feature(abs, scratchRoot)] };
  }
  const scratchRoot = isDir(path.join(abs, '.scratch')) ? path.join(abs, '.scratch') : abs;
  const features = fs.readdirSync(scratchRoot, { withFileTypes: true })
    .filter(d => d.isDirectory() && isDir(path.join(scratchRoot, d.name, 'issues')))
    .map(d => feature(path.join(scratchRoot, d.name), scratchRoot))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (features.length === 0) {
    throw new Error(`No ticket folders found under ${scratchRoot} (expected <feature>/issues/*.md)`);
  }
  return { scratchRoot, features };
}

function feature(dir, scratchRoot) {
  const issuesDir = path.join(dir, 'issues');
  return { name: path.basename(dir), dir, issuesDir, displayDir: displayPath(issuesDir, scratchRoot) };
}

// How ticket paths are shown and put in commands: relative to the repo root (the folder holding
// `.scratch/`) so they can be pasted to an agent running there; absolute otherwise.
function displayPath(p, scratchRoot) {
  if (path.basename(scratchRoot) !== '.scratch') return p;
  return path.relative(path.dirname(scratchRoot), p).split(path.sep).join('/');
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

/** Parses one ticket's markdown. Pure: no file access. */
export function parseTicket(markdown, fileName) {
  const lines = markdown.split(/\r?\n/);
  const numMatch = fileName.match(/^(\d+)/);
  const ticket = {
    file: fileName,
    number: numMatch ? numMatch[1] : null,
    title: fileName.replace(/\.md$/, ''),
    status: null,
    type: null,
    blockedBy: [],
    meta: {},
    summary: '',
    comments: 0,
    body: markdown,
    sections: parseSections(markdown),
  };

  let titleFound = false;
  let section = null; // current `## ` heading, lower-cased
  for (const line of lines) {
    const h1 = line.match(/^#\s+(.+?)\s*#*\s*$/);
    if (h1 && !titleFound) {
      titleFound = true;
      // Drop a leading "NN:" since the number is shown separately.
      ticket.title = h1[1].replace(/^\d+\s*[:.\-–]\s*/, '');
      continue;
    }
    const h2 = line.match(/^##\s+(.+?)\s*$/);
    if (h2) { section = h2[1].toLowerCase(); continue; }

    if (section === COMMENTS) {
      if (/^(###\s|[-*]\s|\*\*[^*]+\*\*)/.test(line)) ticket.comments++;
      continue;
    }

    if (CHECKBOX.test(line)) continue;

    if (section !== null) continue; // metadata only lives above the first `##`
    const m = line.match(META_LINE);
    if (!m) continue;
    const key = m[2].trim().toLowerCase();
    const value = m[5].replace(/^(\*\*|__)|(\*\*|__)$/g, '').trim();
    if (META_KEYS.has(key)) {
      if (!(key in ticket.meta)) ticket.meta[key] = value;
    } else if (key === 'what to build' && !ticket.summary) {
      ticket.summary = value;
    }
  }

  // The card's progress counts what the detail panel shows as acceptance criteria.
  const criteria = ticket.sections.find(s => s.key === 'criteria')?.items ?? [];
  ticket.checks = { done: criteria.filter(i => i.done).length, total: criteria.length };
  ticket.status = normaliseStatus(ticket.meta.status);
  ticket.type = ticket.meta.type || null;
  ticket.blockedBy = parseBlockedBy(ticket.meta['blocked by']);
  if (!ticket.summary) ticket.summary = firstParagraph(lines);
  return ticket;
}

// The Ticket section's known subsections, in the order they're shown. Tickets write them as `## Heading` sections
// or as `**Label:**` paragraphs.
const SECTIONS = [['what', 'What to build'], ['cause', 'Cause'], ['fix', 'Fix'], ['criteria', 'Acceptance criteria'], ['outOfScope', 'Out of scope']];
const SECTION_KEYS = new Map(SECTIONS.map(([key, label]) => [label.toLowerCase(), key]));
// `**Label:** text` or `**Label**: text` at the start of a line.
const LABEL_LINE = /^(?:\*\*|__)([^*_]+?)(?::(?:\*\*|__)|(?:\*\*|__):)\s*(.*)$/;
const CHECKBOX = /^\s*[-*]\s+\[([ xX])\]\s*(.*)$/;
const LIST_ITEM = /^\s*([-*+]|\d+[.)])\s/;
const COMMENTS = 'comments';

/**
 * Splits a ticket into the subsections the detail panel shows: `{ key, label, body }` with `body` as markdown.
 * First the text above any section (key 'intro', no label), then the known ones (SECTIONS) in their order, then
 * every other `## ` section in file order (key null, its heading as label). The title and metadata are left out;
 * everything else ends up in exactly one section. Known `**Label:**` paragraphs are lifted out of whichever section
 * they're in (but not out of `## Comments`) until the next label or heading, and a checklist in the intro, What to
 * build or an unknown section counts as criteria. Acceptance criteria also get `items` ({ text, done, line }, line being its 0-based line in
 * the file) and Out of scope `items` (strings); their `body` is what's left that isn't an item.
 */
export function parseSections(markdown) {
  const lines = markdown.split(/\r?\n/);
  const known = new Map();
  const intro = { key: 'intro', label: null, lines: [] };
  const others = [intro];
  const knownBlock = key => {
    let b = known.get(key);
    if (!b) known.set(key, b = { key, label: SECTIONS.find(([k]) => k === key)[1], lines: [] });
    else b.lines.push({ text: '' }); // keeps text from two places in separate paragraphs
    return b;
  };

  let section = intro; // the `## ` section the line is in, or the intro
  let target = intro; // where the line goes: the section, or a known block lifted out of it
  let checklist = null; // while a bare checklist goes to the criteria: where to go back to after it
  let fence = null;
  let titleSeen = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const add = text => target.lines.push({ text, i });
    if (fence) { add(line); if (new RegExp(`^\\s*${fence}\\s*$`).test(line)) fence = null; continue; }
    // A bare checklist ends at the first line that's neither a checkbox nor indented below one.
    if (checklist && line.trim() && !CHECKBOX.test(line) && !/^\s/.test(line)) { target = checklist; checklist = null; }

    const open = line.match(/^\s*(```+|~~~+)/);
    if (open) { fence = open[1]; add(line); continue; }
    if (!titleSeen && /^#\s/.test(line)) { titleSeen = true; continue; }
    const h2 = line.match(/^##\s+(.+?)\s*#*\s*$/);
    if (h2) {
      const name = h2[1].replace(/\s*:$/, '');
      const key = SECTION_KEYS.get(name.toLowerCase());
      if (key) section = knownBlock(key);
      else others.push(section = { key: null, label: name, lines: [] });
      target = section;
      checklist = null;
      continue;
    }

    const comments = section.label?.toLowerCase() === COMMENTS;
    const label = !comments && line.match(LABEL_LINE);
    if (label) {
      const key = SECTION_KEYS.get(label[1].trim().toLowerCase());
      checklist = null;
      if (key) {
        target = knownBlock(key);
        if (label[2]) add(label[2]);
        continue;
      }
      // Any other label ends a lifted block, except above the first section, where it's part of the paragraphs it follows.
      if (section !== intro) target = section;
    }
    if (section === intro) {
      const meta = line.match(META_LINE);
      if (meta && META_KEYS.has(meta[2].trim().toLowerCase())) continue;
    }
    if (!comments && !checklist && [null, 'intro', 'what'].includes(target.key) && CHECKBOX.test(line)) {
      checklist = target;
      target = knownBlock('criteria');
    }
    add(line);
  }

  const markdownOf = ls => ls.map(l => l.text).join('\n').replace(/\n\s*\n(\s*\n)+/g, '\n\n').replace(/^\s*\n|\s+$/g, '');
  const finish = b => {
    const out = { key: b.key, label: b.label };
    if (b.key === 'criteria') return { ...out, ...listItems(b.lines, CHECKBOX, (m, l) => ({ text: m[2].trim(), done: m[1] !== ' ', line: l.i }), markdownOf) };
    if (b.key === 'outOfScope') return { ...out, ...listItems(b.lines, /^[-*+]\s+(.*)$/, m => m[1].trim(), markdownOf) };
    return { ...out, body: markdownOf(b.lines) };
  };
  return [
    ...others.slice(0, 1),
    ...SECTIONS.map(([key]) => known.get(key)).filter(Boolean),
    ...others.slice(1),
  ].map(finish).filter(s => s.body || s.items?.length);
}

// The list items matching `pattern` in a known block, with indented lines below an item joined onto it;
// the other lines are the block's body.
function listItems(lines, pattern, item, markdownOf) {
  const items = [];
  const rest = [];
  let last = null;
  for (const l of lines) {
    const m = l.text.match(pattern);
    if (m) { items.push(last = item(m, l)); continue; }
    if (last && /^\s+\S/.test(l.text)) {
      const more = l.text.trim().replace(LIST_ITEM, '');
      if (typeof last === 'string') items[items.length - 1] = last = `${last} ${more}`;
      else last.text += ` ${more}`;
      continue;
    }
    if (l.text.trim()) last = null;
    rest.push(l);
  }
  return { items, body: markdownOf(rest) };
}

function normaliseStatus(value) {
  if (!value) return null;
  return value.toLowerCase().replace(/[`*_]/g, '').trim().replace(/\s+/g, '-') || null;
}

function parseBlockedBy(value) {
  if (!value || /^none\b/i.test(value)) return [];
  return [...value.matchAll(/\d+/g)].map(m => m[0]);
}

function firstParagraph(lines) {
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith('#') || META_LINE.test(t) && META_KEYS.has(t.match(META_LINE)[2].trim().toLowerCase())) continue;
    if (/^[-*]\s+\[/.test(t)) break;
    return t.replace(/\*\*/g, '');
  }
  return '';
}

/** Loads every ticket of one feature and works out which ones are blocked. */
export function loadFeature(feat) {
  const files = fs.readdirSync(feat.issuesDir).filter(f => f.endsWith('.md')).sort();
  const tickets = files.map(f => {
    const t = parseTicket(fs.readFileSync(path.join(feat.issuesDir, f), 'utf8'), f);
    t.feature = feat.name;
    t.id = `${feat.name}/${f}`;
    t.path = `${feat.displayDir ?? feat.issuesDir}/${f}`;
    t.absPath = path.join(feat.issuesDir, f);
    return t;
  });

  const byNumber = new Map(tickets.filter(t => t.number).map(t => [Number(t.number), t]));
  for (const t of tickets) {
    t.openBlockers = t.blockedBy.filter(n => {
      const b = byNumber.get(Number(n));
      return !b || !DONE_STATUSES.has(b.status);
    });
    t.blocked = t.openBlockers.length > 0 && !DONE_STATUSES.has(t.status);
    t.blocks = tickets.filter(o => o.blockedBy.some(n => Number(n) === Number(t.number))).map(o => o.number);
  }
  return tickets;
}

/**
 * Returns `markdown` with its status set to `status`, keeping the line's existing formatting.
 * If the ticket has no status line, one is inserted below the title.
 */
export function setStatus(markdown, status) {
  const lines = markdown.split(/\n/);
  let section = null;
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) section = lines[i];
    if (section !== null) break;
    const m = lines[i].replace(/\r$/, '').match(META_LINE);
    if (m && m[2].trim().toLowerCase() === 'status') {
      const cr = lines[i].endsWith('\r') ? '\r' : '';
      lines[i] = `${m[1]}${m[2]}${m[3]}${m[4] || ' '}${status}${cr}`;
      return lines.join('\n');
    }
  }

  const bold = /^\*\*[^*]+:\*\*/m.test(markdown);
  const statusLine = bold ? `**Status:** ${status}` : `Status: ${status}`;
  const titleIdx = lines.findIndex(l => /^#\s/.test(l));
  if (titleIdx === -1) return `${statusLine}\n\n${markdown}`;
  lines.splice(titleIdx + 1, 0, '', statusLine);
  return lines.join('\n');
}

/** Returns `markdown` with `text` added as a dated list item at the end of its `## Comments` section. */
export function appendComment(markdown, text, date = new Date().toISOString().slice(0, 10)) {
  const nl = markdown.includes('\r\n') ? '\r\n' : '\n';
  const item = `- **${date} (review):** ${text.replace(/\s*\r?\n\s*/g, ' ')}`;
  const lines = markdown.replace(/\s+$/, '').split(/\r?\n/);
  const start = lines.findIndex(l => /^##\s+comments\s*$/i.test(l));
  if (start === -1) return `${lines.join(nl)}${nl}${nl}## Comments${nl}${nl}${item}${nl}`;
  let end = lines.findIndex((l, i) => i > start && /^##\s/.test(l));
  if (end === -1) end = lines.length;
  while (end > start + 1 && !lines[end - 1].trim()) end--;
  lines.splice(end, 0, ...(end === start + 1 ? ['', item] : [item]));
  return lines.join(nl) + nl;
}
