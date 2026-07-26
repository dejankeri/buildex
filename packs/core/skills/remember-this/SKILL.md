---
name: remember-this
description: Use when the operator reveals how they specifically work - a correction, a house convention, a routine they walk you through - and it would be wrong to make them explain it again next week, so it gets saved as one of the company's own verbs.
---

# remember-this - turn "that's not how we do it" into a verb

The shipped verbs know the tools. They cannot know that this company names every program after the
block and never after the client, that Tuesday's check-ins are reviewed before Monday's, or that
the owner wants nutrition delivered as a menu rather than a macro table. That knowledge arrives one
correction at a time, and it is lost unless someone writes it down.

You write it down. Never silently - the operator decides what the company remembers.

## When to use

- **They corrected you.** Not "you got the number wrong" - "that's not how we do it here."
- **They walked you through a routine.** Any sequence you would otherwise have to be told again.
- **You watched a preference twice.** Two is a pattern; once is a Tuesday.
- **They said so.** "Remember that", "always do it this way", "from now on".

Do not use for: a fact about one client (that belongs on the client, in the app that owns them), a
one-off, or anything you are only guessing at.

**This verb versus `capture-decision`.** They answer different questions and a standing rule often
needs both. `capture-decision` records *why we chose this*, once, dated, in `decisions/log.md` -
where nobody reads it while working. `remember-this` records *what to do next time*, in a verb the
agent actually loads at the moment of the work. A naming convention logged only as a decision will
be violated the very next time someone builds a program.

## Steps

1. **Ask - unless they already told you.** When you are *inferring* a pattern from what you have
   watched, ask in one line, where the work is, and name the thing concretely enough that they can
   correct it: *"Want me to remember that programs get named after the block, never the client?"*
   Not *"shall I save a preference?"* - they cannot judge that.

   When the operator has stated a standing rule outright ("we never…", "always…", "from now on"),
   that *is* the yes. Save it and say you did, in one line, with the rule as you understood it -
   asking them to confirm an instruction they just gave reads as not listening. They can still
   correct it; the point is that it is written down where you will hit it next time.
2. **Decide whose it is.**
   - How the **company** works - conventions, house style, a shared routine → the team repo.
   - How **this operator personally** likes to work → the private repo.
   When unsure, ask which; getting it wrong either leaks a personal habit to the team or hides a
   company rule from everyone else.
3. **Decide the shape.**
   - A **rule or convention** ("always X", "never Y") → add it to an existing local verb if one
     covers this ground. Do not create a second verb about the same subject; two verbs disagreeing
     is worse than none.
   - A **routine** - several steps, in order, that they will want again → a new verb.
4. **Never edit a shipped verb, and never take its name.** An installed app's verbs
   (`protocol-nutrition`, `stripe-billing`, …) belong to the app: the next update overwrites the
   file, and the operator's rule vanishes with it - silently, months later, with nobody linking the
   two events. Naming your local verb the same thing is worse still, because precedence makes it
   **replace the shipped one outright**, taking every parameter name and pitfall with it.

   So write a *separate* verb, named in the company's own language - `how-we-name-programs`,
   `monday-review`, `martinovic-menus` - and cross-reference the shipped one rather than touching
   it. Check `.claude/skills/` before choosing the name.
5. **Write `<repo>/skills/<name>/SKILL.md`** with frontmatter (`name`, kebab-case, matching the
   directory; `description` starting "Use when …" so it is found at the right moment) and a body of
   `# title`, `## When to use`, `## Steps`, `## Rules`. Write the *reason*, not just the rule - the
   next reader has to know when it stops applying.
6. **Say it landed, and where.** One line, with the path. It is linked in before your next reply.

## Rules

- **Never save something they did not say.** An inferred pattern needs their yes first; a stated
  rule is already theirs. Either way what lands in the file is their rule, never your extrapolation
  of it - remembering changes how the company runs, and that is the operator's call.
- **Never nag.** Offer once. If they say no, drop it for the session - and do not re-offer the same
  thing next week just because the pattern recurred.
- **Write what they said, not what you inferred.** If the reason is unclear, ask for it or leave it
  out. An invented rationale is a rule nobody can safely revisit.
- **One subject per verb.** When new knowledge belongs to an existing local verb, edit that verb.
- **Supersede visibly.** When a new instruction contradicts a saved one, say so and replace the old
  text - never leave two rules that disagree.
- **Nothing secret.** These files are the portable brain and are committed. No keys, no client
  contact details, nothing that would not survive being read aloud.
