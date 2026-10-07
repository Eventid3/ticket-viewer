// Ticket actions: what you may do to a ticket from the board, decided from the ticket and its agent record alone.
// The board refuses requests with these answers, and the page draws its buttons from them, so the two can't disagree.
// Facts only git knows when the action runs (uncommitted changes, a worktree gone missing) are checked where it runs.

// The only status changes the board makes itself. Everything else goes through /triage.
// ready-for-agent -> claimed starts an agent; the agent committing and ending its turn moves claimed -> ready-for-review.
// ready-for-review -> claimed sends your review notes back into the agent's session.
// ready-for-human -> resolved is the detail header's Mark resolved, once you've done the work yourself.
export const MOVES = {
  'ready-for-agent': ['claimed'],
  'ready-for-human': ['resolved'],
  'claimed': ['ready-for-agent'], // only while no agent is running
  'ready-for-review': ['resolved', 'claimed', 'ready-for-agent'],
};

/** The ticket's agent continues its own session; records from before background sessions (no bgId) start over. */
export const resumes = agent => !!(agent?.bgId && agent.sessionId);

/** The session is starting, running or waiting on you, so it may still change the worktree. */
export const isBusy = agent => !!agent && ['starting', 'running', 'waiting'].includes(agent.state);

/**
 * The ticket's agent needs you: it waits on a prompt, or ended its turn without committing (it probably asked
 * something). Not while the ticket is in ready-for-agent or ready-for-review, where the lane's own step comes first.
 */
export const needsYou = (t, agent) => ['waiting', 'idle'].includes(agent?.state) && !['ready-for-agent', 'ready-for-review'].includes(t.status);

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * Every ticket action, each `{ok, why, shown, …}`: `why` says why it is refused (or why it doesn't apply),
 * `shown` is false when it doesn't apply to the ticket at all.
 * @param {{status: string|null, blocked?: boolean, openBlockers?: string[]}} t
 * @param {object|null} a  The ticket's agent record, null without one.
 * @param {{agents: boolean}} project  Whether the project can run agents (it is a git repository).
 */
function decide(t, a, { agents }) {
  const busy = isBusy(a);
  const merging = a?.merging || null;
  const status = t.status || 'no status';
  const allow = (extra = {}) => ({ ok: true, why: null, shown: true, ...extra });
  const refuse = (why, extra = {}) => ({ ok: false, why, shown: true, ...extra });
  const absent = why => ({ ok: false, why, shown: false });
  // The first refusal that holds, else allowed.
  const first = (checks, extra) => { const hit = checks.find(([holds]) => holds); return hit ? refuse(hit[1], extra) : allow(extra); };

  // A worktree mid-merge is yours until you finish or abort the merge: no agent gets it, and the ticket isn't closed.
  const notMerging = [!!merging, 'Finish or abort the merge first'];
  const notBusy = [busy, 'An agent is already working on this ticket'];
  // Starting or continuing the ticket's agent, as Start, Continue, Send back and dragging to claimed all do.
  const agentChecks = [
    [!agents, 'Agents need the project to be a git repository'],
    [!!t.blocked, `Blocked by ${(t.openBlockers || []).join(', ')}`],
    notBusy,
    notMerging,
  ];

  const moves = {};
  for (const to of MOVES[t.status] || []) {
    if (to === 'claimed') moves[to] = first(agentChecks);
    else if (t.status === 'claimed') moves[to] = first([[busy, 'Stop the agent first'], notMerging]);
    else moves[to] = first([notMerging]);
  }

  const resume = resumes(a);
  const start = t.status === 'ready-for-agent' || (t.status === 'claimed' && a)
    ? first(agentChecks, { resume })
    : absent(`Ticket is ${status}, not ready-for-agent`);

  const stop = a?.bgId && !['stopped', 'failed'].includes(a.state) ? allow() : absent('No agent session');

  // Resolving applies to a conflict found on the last poll, and not mid-merge: the merge panel replaces it then.
  const conflictLane = ['claimed', 'ready-for-review'].includes(t.status);
  const resolvable = !a?.conflict ? 'No merge conflict to resolve'
    : merging ? 'A merge is in progress in this worktree; finish or abort it first'
      : !conflictLane ? `Ticket is ${status}, not claimed or ready-for-review` : null;
  // No blocker check: the ticket's work exists already, and merging its reference branch doesn't depend on blockers.
  const resolveConflicts = resolvable ? absent(resolvable) : first([notBusy]);
  const mergeByHand = resolvable ? absent(resolvable) : first([[busy, 'The agent is running in this worktree; stop it first']]);

  // Finishing, aborting and reopening meld on a merge in progress, also one started outside the board.
  const midMerge = (...checks) => !merging ? absent('No merge in progress')
    : first([[busy, 'The agent is working in this worktree'], ...checks]);
  const unresolved = merging?.unresolved ?? 0;
  const meldOpen = [!!merging?.toolOpen, 'meld is still open on this merge; close it first'];
  const finishMerge = midMerge(meldOpen, [unresolved > 0, `${plural(unresolved, 'file')} still unmerged; resolve them in meld first`]);
  const abortMerge = midMerge(meldOpen);
  const reopenMeld = midMerge([!!merging?.toolOpen, 'meld is already open on this merge'], [unresolved === 0, 'Every file is resolved']);

  return { start, stop, resolveConflicts, mergeByHand, finishMerge, abortMerge, reopenMeld, moves };
}

/**
 * The ticket actions the page shows for ticket `t`: `{ok, why}` each (plus `resume` on start), leaving out
 * the ones that don't apply to it. `moves` has an entry per lane the board may move the ticket to.
 */
export function ticketActions(t, a, project) {
  const view = ({ shown, ...entry }) => entry;
  const all = decide(t, a, project);
  const out = {};
  for (const [name, entry] of Object.entries(all)) if (name !== 'moves' && entry.shown) out[name] = view(entry);
  out.moves = Object.fromEntries(Object.entries(all.moves).map(([to, entry]) => [to, view(entry)]));
  return out;
}

/**
 * Why ticket action `action` is refused for ticket `t`, or null when it is allowed.
 * `action` is an action name, or `moves.<lane>` for a move.
 */
export function refusal(t, a, project, action) {
  const all = decide(t, a, project);
  if (action.startsWith('moves.')) {
    const to = action.slice('moves.'.length);
    return all.moves[to] ? all.moves[to].why : `Can't move ${t.status || 'no status'} → ${to} here; use /triage`;
  }
  if (!all[action]) throw new Error(`Unknown ticket action: ${action}`);
  return all[action].why;
}
