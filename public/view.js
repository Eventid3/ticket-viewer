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
  function readPrefs(p) {
    const emptyLanes = EMPTY_LANES.includes(p.emptyLanes) ? p.emptyLanes : p.hideEmpty ? 'hide' : 'collapse';
    return { emptyLanes, unblockedOnly: !!p.unblockedOnly, lastProject: typeof p.lastProject === 'string' ? p.lastProject : null };
  }

  // The top bar's counts: agents running (or starting) and tickets waiting for review.
  function liveCounts(tickets, agents = {}) {
    return {
      running: tickets.filter(t => ['running', 'starting'].includes(agents?.[t.id]?.state)).length,
      review: tickets.filter(t => t.status === 'ready-for-review').length,
    };
  }

  globalThis.TicketView = { EMPTY_LANES, matchesQuery, readPrefs, liveCounts };
})();
