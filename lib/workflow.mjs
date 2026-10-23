// A workflow says everything that is specific to one kind of work item: its lanes, the moves the board may make,
// what a finished agent turn does to the status, which lanes alert you, the agent's start prompt, and its names.
// The board, ticket actions and agent runner read from the ticket's workflow instead of keeping their own constants.

const dnsLabel = s => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const clean = s => s.replace(/[^\w.-]+/g, '-');
const parts = id => {
  const [feature, file] = id.split('/');
  return { feature, stem: file.replace(/\.md$/, '') };
};

/**
 * Tickets: ready-for-agent -> claimed starts an agent; the agent committing and ending its turn (or saying it is done)
 * moves claimed -> ready-for-review, which is also the hard move for an agent that finished without either.
 * ready-for-review -> claimed sends your review notes back into the agent's session.
 * ready-for-human -> resolved is the detail header's Mark resolved, once you've done the work yourself.
 * Everything else goes through /triage.
 */
export const TICKET_WORKFLOW = {
  name: 'ticket',
  lanes: ['needs-triage', 'needs-info', 'ready-for-agent', 'ready-for-human', 'claimed', 'ready-for-review', 'resolved', 'wontfix'],
  moves: {
    'ready-for-agent': ['claimed'],
    'ready-for-human': ['resolved'],
    'claimed': ['ready-for-review', 'ready-for-agent'], // only while no agent is running
    'ready-for-review': ['resolved', 'claimed', 'ready-for-agent'],
  },
  /** The lane a ticket waits in for its agent, and the lane it is in while the agent works. */
  startLane: 'ready-for-agent',
  workLane: 'claimed',
  /** Status after an agent's turn ends with committed work or the done marker, by the status it was in. */
  turnEnd: { claimed: 'ready-for-review' },
  /** Lanes whose work may still merge; others have nothing to check for conflicts. */
  conflictLanes: ['claimed', 'ready-for-review'],
  /** Lanes that count as "to review" in the project alerts. */
  reviewLanes: ['ready-for-review'],
  /** Lanes where the lane's own step comes first, so an agent that needs you doesn't raise "needs you". */
  quietLanes: ['ready-for-agent', 'ready-for-review'],
  startPrompt: ticketFile => `/implement ${ticketFile}`,
  // `id` below is `<feature>/<file>.md`.
  branch(id) {
    const { feature, stem } = parts(id);
    return `ticket/${clean(feature)}/${clean(stem)}`;
  },
  worktreeName(id) {
    const { feature, stem } = parts(id);
    return `ticket-${clean(feature)}--${clean(stem)}`;
  },
  sessionName: ticketFile => `ticket ${ticketFile.split('/').pop().replace(/\.md$/, '')}`,
  /**
   * The agent hostname, `<feature>-<NN>.dev.localhost`: browsers send every `*.localhost` name to 127.0.0.1
   * and keep separate cookies per name, so agents testing the same app on different ports don't share logins.
   * The first label is a single DNS label (a wildcard certificate only matches one) of at most 63 characters;
   * a long feature name is cut short, the number never is.
   */
  hostname(id) {
    const { feature, stem } = parts(id);
    const number = (stem.match(/^\d+/)?.[0] || dnsLabel(stem) || 'x').slice(0, 20).replace(/-+$/, '');
    const name = dnsLabel(feature).slice(0, 62 - number.length).replace(/-+$/, '') || 'ticket';
    return `${name}-${number}.dev.localhost`;
  },
};

/**
 * Tasks: markdown files in the project's reserved `tasks` folder (id `tasks/NN-slug.md`). The board only shows them
 * for now: no agent runs, so there are no moves, no start lane and nothing to merge. A task is never blocked.
 */
export const TASK_WORKFLOW = {
  name: 'task',
  lanes: ['drafting', 'plan-review', 'implementing', 'ready-for-review', 'resolved', 'wontfix'],
  moves: {},
  startLane: null,
  workLane: 'implementing',
  turnEnd: {},
  conflictLanes: [],
  reviewLanes: ['ready-for-review'],
  quietLanes: ['plan-review', 'ready-for-review'],
  startPrompt: taskFile => `/implement ${taskFile}`,
  branch: id => `task/${clean(parts(id).stem)}`,
  worktreeName: id => `task-${clean(parts(id).stem)}`,
  sessionName: taskFile => `task ${taskFile.split('/').pop().replace(/\.md$/, '')}`,
  hostname(id) {
    const { stem } = parts(id);
    return `task-${(stem.match(/^\d+/)?.[0] || dnsLabel(stem) || 'x').slice(0, 20).replace(/-+$/, '')}.dev.localhost`;
  },
};

/** The feature name under which a project's tasks are listed; no feature can have it (see TASKS_FOLDER in tickets.mjs). */
export const TASKS = 'tasks';

/** The workflow of a ticket or task (anything with its `id`, `<feature>/<file>.md`): tasks have the task workflow. */
export const workflowFor = item => (item?.id?.split('/')[0] === TASKS ? TASK_WORKFLOW : TICKET_WORKFLOW);
