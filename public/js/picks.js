// Under each of Claude's picks: that assignment's next open steps and their links.

/**
 * Up to n open (not Done) steps of the pick's assignment, in step order: the
 * pick first, then the steps after it, then any earlier ones still open.
 * Returns { steps: [{ task, isPick }], more } where more counts the rest.
 */
export function nextSteps(tasks, pick, n = 3) {
  if (!pick) return { steps: [], more: 0 };
  if (!pick.assignment_id) return { steps: [{ task: pick, isPick: true }], more: 0 };
  const open = tasks
    .filter(t => t.assignment_id === pick.assignment_id && t.status !== 'Done' && t.id !== pick.id)
    .sort((a, b) => a.id - b.id);
  const ordered = [pick, ...open.filter(t => t.id > pick.id), ...open.filter(t => t.id < pick.id)];
  return {
    steps: ordered.slice(0, n).map(task => ({ task, isPick: task.id === pick.id })),
    more: Math.max(0, ordered.length - n),
  };
}

/** The "Next steps" list for a pick; empty when the assignment has no other open steps. */
export function stepsHtml(tasks, pick, esc, n = 3) {
  const { steps, more } = nextSteps(tasks, pick, n);
  if (steps.length < 2) return '';
  const rows = steps.map(({ task: t, isPick }) => `
    <li class="pick-step${isPick ? ' is-pick' : ''}">
      <button type="button" class="pick-step-box" data-done-id="${t.id}" title="Mark done" aria-label="Mark “${esc(t.description)}” done">${t.status === 'In Progress' ? '◐' : '☐'}</button>
      <span class="pick-step-body">
        <span class="pick-step-desc">${esc(t.description)}</span>${t.time_spent ? `<span class="pick-step-meta"> · ${esc(t.time_spent)}</span>` : ''}${t.notes ? `<span class="pick-step-meta"> · ${esc(t.notes)}</span>` : ''}
        ${t.link_url ? `<a class="mt-task-link pick-step-link" href="${esc(t.link_url)}" target="_blank" rel="noopener" title="${esc(t.link_url)}">▶ ${esc(t.link_label || 'Open link')} ↗</a>` : ''}
      </span>
    </li>`).join('');
  return `<div class="pick-steps">
      <div class="pick-steps-head">Next steps${pick.assignment_title ? ` in ${esc(pick.assignment_title)}` : ''}</div>
      <ul>${rows}</ul>
      ${more ? `<div class="pick-steps-more">+${more} more on the board</div>` : ''}
    </div>`;
}
