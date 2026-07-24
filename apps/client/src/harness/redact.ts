// Shared scrub used everywhere a secret value must be stripped before it survives a run: the
// persisted transcript (drive-step), and any error thrown out of the generator/judge seams
// (scenario-step, judge-step). One implementation - three call sites used to each carry their own
// copy of this loop.
export function redactText(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join("[REDACTED]");
  }
  return out;
}
