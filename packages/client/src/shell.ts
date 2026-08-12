/**
 * Parses shell commands looking for writes into a resource held by someone else.
 *
 * Two reasons this exists at all:
 *  - in claude code a claim can be bypassed by writing through the shell;
 *  - in codex the shell is the only place to intervene: PreToolUse fires for
 *    neither apply_patch nor file edits.
 *
 * This will never be complete: `bash -c "$(...)"`, variables and creative quoting
 * cannot be parsed in principle. It catches the ordinary case — an agent editing
 * through sed because it is shorter.
 *
 * Deliberately conservative: a false refusal costs more than a miss. One unfair
 * deny and the agent decides the system is broken and starts working around it
 * on purpose. See PLAN.md.
 */

/** Commands and operators that modify files. Reads are left alone. */
const WRITE_MARKERS: RegExp[] = [
  />>?/, // output redirection
  /\bsed\b[^|]*-i/,
  /\btee\b/,
  /\b(mv|cp|rm|truncate|dd|install|patch|apply_patch)\b/,
  /\bgit\s+(checkout|restore|apply|reset)\b/,
  /\bperl\b[^|]*-i/,
  /\bpython3?\b[^|]*\bopen\([^)]*['"][wa]/,
];

/** Paths that are not repository files in their own right. */
const NOISE = new Set(['.', '..', './', '../']);

export function looksLikeWrite(command: string): boolean {
  return WRITE_MARKERS.some((re) => re.test(command));
}

/**
 * Finds mentions of claimed resources inside a command.
 *
 * Matching is substring-with-boundaries: a path in a command may be relative,
 * absolute or quoted, and normalising it before parsing the shell is impossible.
 */
export function mentionedResources(command: string, resources: string[]): string[] {
  const hits: string[] = [];

  for (const resource of resources) {
    if (NOISE.has(resource)) continue;

    if (resource.endsWith('/')) {
      // A directory counts as touched if any path inside it is mentioned.
      const dir = resource.slice(0, -1);
      const re = new RegExp(`(^|[\\s'"=(/])${escape(dir)}/`);
      if (re.test(command)) hits.push(resource);
      continue;
    }

    const re = new RegExp(`(^|[\\s'"=(/])${escape(resource)}($|[\\s'"),;&|])`);
    if (re.test(command)) hits.push(resource);
  }
  return hits;
}

function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The verdict for a command: which of someone else's resources it tries to
 * modify. An empty result means "let it through" — including when unsure.
 */
export function writeTargets(command: string, heldByOthers: string[]): string[] {
  if (!command || !looksLikeWrite(command)) return [];
  return mentionedResources(command, heldByOthers);
}
