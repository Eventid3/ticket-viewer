// Reads and writes ticket files laid out as described in docs/agents/issue-tracker.md:
//   .scratch/<feature>/issues/NN-<slug>.md
import fs from 'node:fs';
import path from 'node:path';

// Keys recognised as ticket metadata. Other `**Key:**` lines (e.g. "What to build") are body text.
const META_KEYS = new Set(['status', 'type', 'blocked by', 'owner', 'assignee', 'priority', 'labels']);

// Statuses that count as finished when deciding whether a ticket is still blocked.
export const DONE_STATUSES = new Set(['resolved', 'done', 'closed', 'wontfix']);

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
    return { scratchRoot: path.dirname(abs), features: [feature(abs)] };
  }
  const scratchRoot = isDir(path.join(abs, '.scratch')) ? path.join(abs, '.scratch') : abs;
  const features = fs.readdirSync(scratchRoot, { withFileTypes: true })
    .filter(d => d.isDirectory() && isDir(path.join(scratchRoot, d.name, 'issues')))
    .map(d => feature(path.join(scratchRoot, d.name)))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (features.length === 0) {
    throw new Error(`No ticket folders found under ${scratchRoot} (expected <feature>/issues/*.md)`);
  }
  return { scratchRoot, features };
}

function feature(dir) {
  return { name: path.basename(dir), dir, issuesDir: path.join(dir, 'issues') };
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
    checks: { done: 0, total: 0 },
    comments: 0,
    body: markdown,
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

    if (section === 'comments') {
      if (/^(###\s|[-*]\s|\*\*[^*]+\*\*)/.test(line)) ticket.comments++;
      continue;
    }

    const box = line.match(/^\s*[-*]\s+\[([ xX])\]/);
    if (box) {
      ticket.checks.total++;
      if (box[1] !== ' ') ticket.checks.done++;
      continue;
    }

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

  ticket.status = normaliseStatus(ticket.meta.status);
  ticket.type = ticket.meta.type || null;
  ticket.blockedBy = parseBlockedBy(ticket.meta['blocked by']);
  if (!ticket.summary) ticket.summary = firstParagraph(lines);
  return ticket;
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

export function isValidStatus(status) {
  return typeof status === 'string' && /^[a-z0-9][a-z0-9-]{0,40}$/.test(status);
}
