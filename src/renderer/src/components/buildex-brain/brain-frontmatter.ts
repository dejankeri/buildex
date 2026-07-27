// Front matter, held back from the rich editor.
//
// A skill file opens with YAML the agent runtime requires — `name:` and
// `description:` — and a rich markdown editor has no notion of it. Round-tripping
// it through Tiptap turns the opening `---` into a horizontal rule and the keys
// into a paragraph, which would quietly break the skill.
//
// So it is split off before editing and put back byte for byte on save. What the
// operator edits is the prose, which is what they came to edit.

export type SplitDocument = {
  /** Raw, including both `---` lines and the newline after the closing one. */
  frontmatter: string
  body: string
}

const OPENING = /^---\r?\n/

export function splitFrontmatter(text: string): SplitDocument {
  if (!OPENING.test(text)) {
    return { frontmatter: '', body: text }
  }
  const lines = text.split('\n')
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].trimEnd() === '---') {
      return {
        frontmatter: `${lines.slice(0, index + 1).join('\n')}\n`,
        body: lines.slice(index + 1).join('\n')
      }
    }
  }
  // Why: an unterminated block is not front matter, it is a document that starts
  // with a rule. Treating it as front matter would hide the whole file.
  return { frontmatter: '', body: text }
}

export function joinFrontmatter(frontmatter: string, body: string): string {
  return frontmatter ? `${frontmatter}${body}` : body
}
