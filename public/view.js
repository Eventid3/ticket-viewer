'use strict';
// Pure board-view helpers, loaded before app.js. test/view.test.mjs imports this file and reads globalThis.TicketView.
(() => {
  const EMPTY_LANES = ['show', 'collapse', 'hide'];
  // Statuses whose tickets are finished: their cards are dimmed and show no agent marks.
  const DONE = new Set(['resolved', 'done', 'closed', 'wontfix']);
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
  // and ⚠ while the agent needs you. Finished tickets show none, like the Board cards.
  function rowMarks(t, a) {
    const active = !DONE.has(t.status);
    return {
      running: active && ['running', 'starting'].includes(a?.state),
      done: active && a?.state === 'done',
      needsYou: active && !!t.needsYou,
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

  // Tickets that need triage before an agent can work on them: needs-triage, needs-info or no status.
  const isTriage = t => !t.status || t.status === 'needs-triage' || t.status === 'needs-info';

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
    } else if (isTriage(t)) {
      add('triage', 'primary');
    } else if (t.status === 'ready-for-human') {
      add('markResolved', 'primary', !!moves.resolved);
    }
    add('resolveConflicts', 'primary', !!resolveConflicts);
    add('mergeByHand', '', !!mergeByHand);
    if (attachFirst) buttons.slice(1).forEach(b => { if (b.style === 'primary') b.style = ''; });
    return { buttons, note: null };
  }

  // The agent's final message as the Agent section shows it: `summary`, the prose before its first `- **Label:** text`
  // bullet; `items`, one `{label, text}` per such bullet (indented lines below one belong to it, a bullet's indent taken
  // off); and `rest`, whatever else follows the first one (plain bullets, a closing line). Without such bullets the
  // whole message is the summary. Bullets in a code fence don't count.
  function splitReport(md) {
    const lines = String(md || '').replace(/\r\n?/g, '\n').split('\n');
    const report = /^ {0,3}[-*+]\s+(?:\*\*([^*]+?):\*\*|\*\*([^*]+?)\*\*:)\s*(.*)$/;
    const items = [];
    const rest = [];
    let start = -1;
    let fence = null; // the open fence's run of ` or ~
    let item = null; // the item indented lines are added to, with its indent
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const f = line.match(/^\s*(`{3,}|~{3,})/);
      // A fence closes on a bare run of its character at least as long as the one that opened it.
      if (fence) { if (f && f[1][0] === fence[0] && f[1].length >= fence.length && !line.trim().slice(f[1].length)) fence = null; }
      else if (f) fence = f[1];
      const m = !fence && !f && line.match(report);
      if (m) {
        if (start === -1) start = i;
        item = { label: (m[1] || m[2]).trim(), lines: [m[3]], indent: line.length - line.trimStart().length + 2 };
        items.push(item);
        continue;
      }
      if (start === -1) continue;
      // An indented line goes on the open item, even after a blank line, and so does any line right below it
      // that doesn't start a block of its own; anything else ends it.
      const text = line.trim();
      const indented = /^\s/.test(line) && text;
      const lazy = item && text && lines[i - 1].trim() && !f && !/^([-*+]|\d+[.)]|#{1,6}|>)(\s|$)/.test(text);
      if (item && (indented || lazy || (!text && /^\s+\S/.test(lines.slice(i + 1).find(l => l.trim()) || '')))) {
        item.lines.push(lazy && !indented ? text : indented ? line.slice(Math.min(item.indent, line.length - line.trimStart().length)) : '');
        continue;
      }
      if (text) item = null;
      rest.push(line);
    }
    if (start === -1) return { summary: String(md || '').trim(), items: [], rest: '' };
    return {
      summary: lines.slice(0, start).join('\n').trim(),
      items: items.map(({ label, lines }) => ({ label, text: lines.join('\n').trim() })),
      rest: rest.join('\n').trim(),
    };
  }

  // The Agent section's heading for agent `a` (null: no agent).
  function agentHeading(a) {
    switch (a?.state) {
      case undefined: return 'Agent';
      case 'done': return 'What the agent did';
      case 'starting': case 'running': return 'Agent is working';
      case 'waiting': return 'Agent needs you';
      case 'idle': return 'Agent is waiting for a reply';
      default: return 'Agent stopped';
    }
  }

  // The Agent section of ticket `t` without an agent: an explanation, one action (start or triage) and a warning when
  // it's blocked. Null leaves the section out (ready-for-human, resolved, wontfix, …).
  function noAgentPrompt(t) {
    const triage = isTriage(t);
    if (t.status !== 'ready-for-agent' && !triage) return null;
    const nums = t.openBlockers.map(n => `#${n}`);
    return {
      text: triage
        ? 'This ticket needs triage before an agent can work on it: /triage settles what to build and moves it on.'
        : 'No agent has worked on this ticket yet.',
      action: triage ? 'triage' : 'start',
      blocked: !nums.length ? null
        : triage ? `Blocked by ${nums.join(', ')}.`
        : `Blocked by ${nums.join(', ')}. You can still start an agent, but it may conflict with ${nums.length === 1 ? `${nums[0]}'s` : 'their'} changes.`,
    };
  }

  globalThis.TicketView = { DONE, EMPTY_LANES, LAYOUTS, readLayout, rowMarks, matchesQuery, readPrefs, liveCounts, laneView, plainText, headerActions, splitReport, agentHeading, noAgentPrompt, isTriage };
})();
