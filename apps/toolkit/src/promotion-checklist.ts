// The promotion checklist (architecture / delivery playbook): the quality bar a verb must clear
// before it ships in packs/core. A verb the agent can't discover or run reliably is worse than no
// verb, so the gate is real: valid identity, a trigger-oriented description (that's what makes the
// agent reach for it), and a usable when/steps/rules structure.

export interface ChecklistResult {
  ok: boolean;
  issues: string[];
}

const TRIGGER_HINTS = /\b(use when|use this when|when you|when the)\b/i;

export function validateVerb(content: string): ChecklistResult {
  const issues: string[] = [];

  const fm = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) {
    return { ok: false, issues: ["missing YAML frontmatter"] };
  }
  const front = fm[1]!;
  const name = field(front, "name");
  const description = field(front, "description");

  if (!name) issues.push("missing `name`");
  else if (!/^[a-z][a-z0-9-]*$/.test(name)) issues.push("`name` must be kebab-case (lower-case, hyphens)");

  if (!description) issues.push("missing `description`");
  else {
    if (description.length < 30) issues.push("`description` is too terse to guide discovery");
    if (!TRIGGER_HINTS.test(description)) issues.push("`description` should be trigger-oriented (\"Use when …\") so the agent knows when to reach for it");
  }

  const body = content.slice(fm[0].length);
  if (!/^#\s+\S/m.test(body)) issues.push("missing an H1 title");
  if (!/##\s+When to use/i.test(body) && !/##\s+Steps/i.test(body)) {
    issues.push("missing a `## When to use` or `## Steps` section");
  }

  return { ok: issues.length === 0, issues };
}

function field(front: string, key: string): string | undefined {
  const m = front.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
  return m ? m[1]!.trim() : undefined;
}
