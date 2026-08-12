import type {
  AgentCard,
  ClaimConflict,
  Event,
  MessagePayload,
  Pending,
  Plan,
  PlanItem,
} from '../../protocol/src/index.ts';

/**
 * The refusal text is part of the product, not a log line.
 *
 * Verified against a live agent: given this wording, claude code stops, relays
 * the reason to the human and offers to contact the holder — because the text
 * says so. Drop the last sentence and the agent starts looking for a way
 * around. See PLAN.md.
 */
export function denyText(resource: string, conflict: ClaimConflict, cli: string): string {
  const since = new Date(conflict.since).toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
  });
  const note = conflict.note ? ` (note: "${conflict.note}")` : '';
  return [
    `${resource} is claimed in vibegram: ${conflict.heldBy} has held it since ${since}${note}.`,
    `Do not work around this through the shell and do not edit hook settings.`,
    `Message the holder: ${cli} send "@${conflict.heldBy} I need ${resource}, when will you release it?"`,
    `Otherwise take another plan item (${cli} plan) or ask the human.`,
  ].join(' ');
}

function eventLine(event: Event): string | null {
  const who = event.nick ?? 'system';
  switch (event.kind) {
    case 'message':
      return `${who}: ${(event.payload as MessagePayload).body}`;
    case 'claim':
      return `${who} claimed: ${(event.payload as { resources: string[] }).resources.join(', ')}`;
    case 'release':
      return `${who} released: ${(event.payload as { resources: string[] }).resources.join(', ')}`;
    case 'claim_denied':
      return `${who} tried to claim something you hold — they may be waiting on you`;
    case 'violation':
      return `${who} went into a file you hold`;
    case 'plan_change':
      return `${who}: plan — ${(event.payload as { summary: string }).summary}`;
    case 'agent_join':
      return `${who} joined`;
    case 'agent_leave':
      return `${who} left`;
    default:
      return null;
  }
}

/**
 * The digest mixed into an agent's context. Deliberately short: this is
 * background noticed in passing, not a document to read.
 */
export function pendingText(pending: Pending, cli: string): string | null {
  const lines = pending.events.map(eventLine).filter((l): l is string => l !== null);

  if (pending.planAckNeeded !== null) {
    lines.push(
      `The plan changed (revision ${pending.planAckNeeded}) and you have not acknowledged it: ` +
        `read "${cli} plan", then either "${cli} plan ack" or "${cli} plan dispute "reason"".`,
    );
  }
  if (lines.length === 0) return null;

  const tail =
    pending.skipped > 0
      ? `\n(${pending.skipped} more ${pending.skipped === 1 ? 'event' : 'events'} not your concern)`
      : '';
  return `[vibegram] ${lines.join('\n')}${tail}`;
}

/**
 * Participant cards. The point is that on a conflict an agent understands not
 * only "haikesan holds this file", but who that is and what they are doing —
 * whether to go to them now or take something else.
 */
export function cardsText(cards: AgentCard[], selfNick?: string): string {
  if (cards.length === 0) return 'Nobody is connected.';

  return cards
    .map((card) => {
      // Without the marker an agent does not recognise itself in the list —
      // observed on a live run: "I cannot tell which one is me".
      const self = card.nick === selfNick ? ' (this is you)' : '';
      const head = `${card.status === 'online' ? '●' : '○'} ${card.nick}${self}`;
      const about = [card.description, card.skills.length > 0 ? card.skills.join(', ') : null]
        .filter(Boolean)
        .join(' · ');

      const lines = [about ? `${head} — ${about}` : head];
      if (card.model || card.branch) {
        lines.push(`    ${[card.model, card.branch ? `branch ${card.branch}` : null].filter(Boolean).join(', ')}`);
      }
      // Worth shouting about: this agent can walk into a claimed file and
      // nothing will stop it.
      if (card.hooksAlive === false) lines.push('    ! hooks not active — coordinates by hand, writes are not blocked');
      if (card.focus.planItem) lines.push(`    doing: ${card.focus.planItem.text}`);
      if (card.focus.holding.length > 0) lines.push(`    holds: ${card.focus.holding.join(', ')}`);
      return lines.join('\n');
    })
    .join('\n');
}

export interface WorkSnapshot {
  free: PlanItem[];
  taken: PlanItem[];
  busy: { resource: string; nick: string; note: string | null }[];
  cards: AgentCard[];
  planRevision: number;
}

/**
 * The available-work digest is written for the human, not the agent: the agent
 * shows it and waits for a choice. Hence the closing instruction not to take
 * anything on its own. See PLAN.md.
 */
export function workText(snapshot: WorkSnapshot, selfNick?: string): string {
  const parts: string[] = selfNick ? [`You are ${selfNick}.`] : [];

  if (snapshot.free.length > 0) {
    parts.push(`Free plan items:\n${snapshot.free.map((item, i) => `  ${i + 1}. ${item.text}`).join('\n')}`);
  } else if (snapshot.planRevision === 0) {
    parts.push('There is no plan yet — worth proposing one, but discuss it with the human first.');
  } else {
    parts.push('No free plan items.');
  }

  if (snapshot.taken.length > 0) {
    parts.push(
      `Already taken:\n${snapshot.taken.map((item) => `  — ${item.text} (${item.ownerNick})`).join('\n')}`,
    );
  }

  if (snapshot.busy.length > 0) {
    parts.push(
      `Claimed files:\n${snapshot.busy
        .map((claim) => `  — ${claim.resource} by ${claim.nick}${claim.note ? ` (${claim.note})` : ''}`)
        .join('\n')}`,
    );
  }

  const specialists = snapshot.cards.filter((card) => card.description || card.skills.length > 0);
  if (specialists.length > 0) {
    parts.push(
      `Who does what:\n${specialists
        .map((card) => `  — ${card.nick}: ${[card.description, card.skills.join(', ')].filter(Boolean).join(' · ')}`)
        .join('\n')}`,
    );
  }

  parts.push(
    'Show this to the human, offer two or three options (including work that is not in the plan) ' +
      'and wait for their choice. Do not assign work to yourself.',
  );
  return parts.join('\n\n');
}

export function planText(plan: Plan, cli: string): string {
  if (plan.items.length === 0) {
    return `No plan published yet. If you are first, propose one: ${cli} plan propose "item" "item".`;
  }
  const items = plan.items
    .map((item, i) => {
      const owner = item.ownerNick ? ` — ${item.ownerNick}` : '';
      return `${i + 1}. [${item.status}] ${item.text}${owner}`;
    })
    .join('\n');
  const acks = plan.acks
    .filter((a) => a.revision === plan.revision)
    .map((a) => a.nick)
    .join(', ');
  const notes = plan.notes.body ? `\n\nShared notes:\n${plan.notes.body}` : '';
  return (
    [
      `Plan v${plan.revision}${plan.proposedBy ? ` (published by ${plan.proposedBy})` : ''}:`,
      items,
      acks ? `Agreed: ${acks}` : 'Nobody has acknowledged it yet.',
    ].join('\n') + notes
  );
}
