'use strict';
// Pure board-view helpers, loaded before app.js. test/view.test.mjs imports this file and reads globalThis.TicketView.
(() => {
  const EMPTY_LANES = ['show', 'collapse', 'hide'];

  // The search box matches a ticket's number (a leading # is ignored), title or body text.
  function matchesQuery(t, query) {
    const q = query.trim().replace(/^#/, '').toLowerCase();
    if (!q) return true;
    return [t.number, t.title, t.body].some(v => v && v.toLowerCase().includes(q));
  }

  // The saved prefs, with defaults. The old hideEmpty checkbox becomes the Hide empty-lanes mode.
  // expandedLanes: the statuses of the empty lanes you expanded by hand in Collapse mode.
  function readPrefs(p) {
    const emptyLanes = EMPTY_LANES.includes(p.emptyLanes) ? p.emptyLanes : p.hideEmpty ? 'hide' : 'collapse';
    const expandedLanes = Array.isArray(p.expandedLanes) ? p.expandedLanes.filter(s => typeof s === 'string') : [];
    return { emptyLanes, unblockedOnly: !!p.unblockedOnly, lastProject: typeof p.lastProject === 'string' ? p.lastProject : null, expandedLanes };
  }

  // How a lane with `count` cards is drawn in empty-lanes `mode`: full, hidden, collapsed (a narrow button), or
  // expanded (an empty lane opened by hand, which can be collapsed again).
  function laneView(count, mode, expandedByHand) {
    if (count > 0 || mode === 'show') return 'full';
    if (mode === 'hide') return 'hidden';
    return expandedByHand ? 'expanded' : 'collapsed';
  }

  // Markdown as plain text for one-line excerpts: code, emphasis, links and HTML tags lose their markup.
  function plainText(md) {
    return String(md || '')
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/<[^>]+>/g, '')
      .replace(/`+([^`]*)`+/g, '$1')
      .replace(/(\*\*|__|~~)(?=\S)(.+?)(?<=\S)\1/g, '$2')
      .replace(/(^|[^\w*])([*_])(?=\S)(.+?)(?<=\S)\2(?![\w*])/g, '$1$3')
      .replace(/\s+/g, ' ').trim();
  }

  // The top bar's counts: agents running (or starting) and tickets waiting for review.
  function liveCounts(tickets, agents) {
    return {
      running: tickets.filter(t => ['running', 'starting'].includes(agents?.[t.id]?.state)).length,
      review: tickets.filter(t => t.status === 'ready-for-review').length,
    };
  }

  globalThis.TicketView = { EMPTY_LANES, matchesQuery, readPrefs, liveCounts, laneView, plainText };
})();
