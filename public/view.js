'use strict';
// Pure board-view helpers, loaded before app.js. test/view.test.mjs imports this file and reads globalThis.TicketView.
(() => {
  const EMPTY_LANES = ['show', 'collapse', 'hide'];
  // The top bar's layout switcher, in order. The choice is saved under tv:layout.
  const LAYOUTS = [
    { value: 'board', label: 'Board', title: 'Board with detail drawer' },
    { value: 'strip', label: 'Strip', title: 'Lanes on top, detail below' },
  ];

  // The saved layout, or Board when there's none or it isn't one of LAYOUTS.
  function readLayout(saved) {
    return LAYOUTS.some(l => l.value === saved) ? saved : 'board';
  }

  // What a Strip row card shows after its title: the running dot or ✓ for the agent of an active ticket
  // (resolved and wontfix show none, like the Board cards), and ⚠ while the agent needs you.
  function rowMarks(t, a) {
    const active = !['resolved', 'done', 'closed', 'wontfix'].includes(t.status);
    return {
      running: active && ['running', 'starting'].includes(a?.state),
      done: active && a?.state === 'done',
      needsYou: !!t.needsYou,
    };
  }

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

  // Markdown as plain text for one-line excerpts: code, emphasis, links, HTML tags and a leading heading, list or
  // quote marker lose their markup. Code spans are set aside first, so what's inside them stays as written.
  function plainText(md) {
    const code = [];
    return String(md || '')
      .replace(/(`+)(.+?)\1/g, (_, ticks, text) => `\u0000${code.push(text.trim()) - 1}\u0000`)
      .replace(/^\s*(#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/, '')
      .replace(/!?\[([^\]]*)\]\((?:[^()]|\([^()]*\))*\)/g, '$1')
      .replace(/<\/?(?:a|b|i|u|s|em|strong|code|kbd|span|sub|sup|br|mark|del|ins)\b[^>]*>/gi, '')
      .replace(/(?<!\\)(\*\*|__|~~)(?=\S)(.+?)(?<=\S)(?<!\\)\1/g, '$2')
      .replace(/(^|[^\w*\\])([*_])(?=\S)(.+?)(?<=[^\s\\])\2(?![\w*])/g, '$1$3')
      .replace(/\\([\\`*_{}[\]()#+\-.!<>~|])/g, '$1')
      .replace(/\u0000(\d+)\u0000/g, (_, i) => code[i])
      .replace(/\s+/g, ' ').trim();
  }

  // The top bar's counts: agents running (or starting) and tickets waiting for review.
  function liveCounts(tickets, agents) {
    return {
      running: tickets.filter(t => ['running', 'starting'].includes(agents?.[t.id]?.state)).length,
      review: tickets.filter(t => t.status === 'ready-for-review').length,
    };
  }

  // The detail header's primary actions: only the ones for the ticket's current state, each `{name, style}`
  // with style '' (plain), primary, green or stop. A button whose server ticket action (t.actions) is left out isn't shown;
  // app.js disables a refused one with the server's reason. `note` is the muted text shown instead of buttons.
  function headerActions(t, a) {
    const { start, stop, resolveConflicts, mergeByHand, moves } = t.actions;
    const busy = ['starting', 'running', 'waiting'].includes(a?.state);
    const buttons = [];
    const add = (name, style = '', when = true) => { if (when) buttons.push({ name, style }); };
    if (t.status === 'resolved') return { buttons, note: 'Resolved' };
    // Outside claimed, an agent that needs you still comes first: attaching leads, as the only primary action.
    const attachFirst = t.needsYou && t.status !== 'claimed' && !!a?.bgId;
    add('attach', 'primary', attachFirst);
    if (t.status === 'ready-for-review' && a) {
      add('approve', 'green', !!moves.resolved);
      add('diff');
    } else if (t.status === 'claimed' && t.needsYou) {
      add('attach', 'primary', !!a?.bgId);
      add('continue', '', !!start && !busy);
      add('stop', 'stop', !!stop);
    } else if (t.status === 'claimed' && busy) {
      add('stop', 'stop', !!stop);
      add('attach', '', !!a?.bgId);
    } else if (t.status === 'claimed') {
      add('continue', 'primary', !!start);
      add('back', '', !!moves['ready-for-agent']);
    } else if (t.status === 'ready-for-agent') {
      add('start', 'primary', !!start);
      add('implement');
    } else if (!t.status || t.status === 'needs-info' || t.status === 'needs-triage') {
      add('triage', 'primary');
    } else if (t.status === 'ready-for-human') {
      add('markResolved', 'primary', !!moves.resolved);
    }
    add('resolveConflicts', 'primary', !!resolveConflicts);
    add('mergeByHand', '', !!mergeByHand);
    if (attachFirst) buttons.slice(1).forEach(b => { if (b.style === 'primary') b.style = ''; });
    return { buttons, note: null };
  }

  globalThis.TicketView = { EMPTY_LANES, LAYOUTS, readLayout, rowMarks, matchesQuery, readPrefs, liveCounts, laneView, plainText, headerActions };
})();
