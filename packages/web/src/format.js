/** Human-readable line for a feed event. */
export function describe(event) {
  const p = event.payload ?? {};
  switch (event.kind) {
    case 'message':
      return p.body;
    case 'claim':
      return `claimed ${p.resources.join(', ')}${p.note ? ` — ${p.note}` : ''}`;
    case 'release':
      return `released ${p.resources.join(', ')}`;
    case 'claim_denied':
      return `wanted ${p.requested.join(', ')} — held by ${p.conflicts.map((c) => c.heldBy).join(', ')}`;
    case 'violation':
      return p.outcome === 'blocked'
        ? `write to ${p.resource} blocked — held by ${p.heldBy}`
        : `wrote into ${p.resource} — held by ${p.heldBy}`;
    case 'plan_change':
      return p.summary;
    case 'agent_join':
      return 'joined';
    case 'agent_leave':
      return 'left';
    default:
      return event.kind;
  }
}

/**
 * How an event is rendered.
 *
 * Three modes, not eight: what someone said reads as speech, a collision has to
 * be visible from across the room, and bookkeeping should recede.
 */
export function mode(kind) {
  if (kind === 'message') return 'message';
  if (kind === 'claim_denied' || kind === 'violation') return 'alert';
  return 'service';
}

/** Short uppercase label shown on an alert row. */
export function alertLabel(event) {
  if (event.kind === 'claim_denied') return 'denied';
  return event.payload?.outcome === 'blocked' ? 'blocked' : 'violation';
}

export function time(iso) {
  return new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

/** Platform comes from the nick prefix: claude-alice -> claude. */
export function platform(nick) {
  return (nick ?? '').split('-')[0] || 'other';
}

/** Base hue per platform, so claude and chatgpt read apart at a glance. */
const PLATFORM_HUE = {
  claude: 25,
  chatgpt: 150,
  cursor: 220,
  codex: 275,
  human: 55,
  other: 0,
};

function hueOf(nick) {
  let hash = 0;
  for (let i = 0; i < nick.length; i += 1) hash = (hash * 31 + nick.charCodeAt(i)) % 997;
  const base = PLATFORM_HUE[platform(nick)] ?? 0;
  return (base + (hash % 44) - 22 + 360) % 360;
}

/**
 * An agent's colour: platform sets the hue, the nick shifts it within.
 *
 * Platform alone is not enough — two claude agents must be told apart in the
 * tree, where colour is the only marker of who holds what.
 */
export function agentColor(nick, dim = false) {
  if (!nick) return 'inherit';
  const hue = hueOf(nick);
  return dim ? `hsl(${hue} 30% 46%)` : `hsl(${hue} 60% 68%)`;
}

/** Same hue at low alpha: claimed row backgrounds and holder badges. */
export function agentTint(nick, alpha) {
  if (!nick) return 'transparent';
  return `hsl(${hueOf(nick)} 55% 60% / ${alpha})`;
}

export function plural(n, one, many) {
  return n === 1 ? one : many;
}
