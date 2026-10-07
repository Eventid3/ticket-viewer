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
  function liveCounts(tickets, agents) {
    return {
      running: tickets.filter(t => ['running', 'starting'].includes(agents?.[t.id]?.state)).length,
      review: tickets.filter(t => t.status === 'ready-for-review').length,
    };
  }

  // The detail header's primary actions: only the ones for the ticket's current state, each `{name, style}`
  // with style default, primary, green or stop. A button whose server ticket action (t.actions) is left out isn't shown;
  // app.js disables a refused one with the server's reason. `note` is the muted text shown instead of buttons.
  function headerActions(t, a) {
    const { start, stop, resolveConflicts, mergeByHand, moves } = t.actions;
    const busy = ['starting', 'running', 'waiting'].includes(a?.state);
    const buttons = [];
    const add = (name, style = 'default', when = true) => { if (when) buttons.push({ name, style }); };
    if (t.status === 'resolved') return { buttons, note: 'Resolved' };
    if (t.status === 'ready-for-review' && a) {
      add('approve', 'green', !!moves.resolved);
      add('diff');
    } else if (t.status === 'claimed' && t.needsYou) {
      add('attach', 'primary', !!a?.bgId);
      add('continue', 'default', !!start && !busy);
      add('stop', 'stop', !!stop);
    } else if (t.status === 'claimed' && busy) {
      add('stop', 'stop', !!stop);
      add('attach', 'default', !!a?.bgId);
    } else if (t.status === 'claimed') {
      add('continue', 'primary', !!start);
      add('back', 'default', !!moves['ready-for-agent']);
    } else if (t.status === 'ready-for-agent') {
      add('start', 'primary', !!start);
      add('implement');
    } else if (!t.status || t.status === 'needs-info' || t.status === 'needs-triage') {
      add('triage', 'primary');
    } else if (t.status === 'ready-for-human') {
      add('markResolved', 'primary', !!moves.resolved);
    }
    add('resolveConflicts', 'default', !!resolveConflicts);
    add('mergeByHand', 'default', !!mergeByHand);
    return { buttons, note: null };
  }

  globalThis.TicketView = { EMPTY_LANES, matchesQuery, readPrefs, liveCounts, headerActions };
})();
