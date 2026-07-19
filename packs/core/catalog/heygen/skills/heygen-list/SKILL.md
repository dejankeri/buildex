---
name: heygen-list
description: Use when you need to know what's available in HeyGen - which avatars, voices, or templates exist, or the status of a video - before proposing or generating a video.
---

# heygen-list - read what HeyGen can build with

Pull the relevant HeyGen avatars, voices, templates, or video status before you reason about a video.

## When to use

- The operator asks "which avatars do we have?", "is that video done?", "what templates exist?".
- You are about to generate a video and need to pick a real avatar/voice/template first.

## Steps

1. List the avatars, voices, templates, or videos with the HeyGen tools.
2. Read the details - avatar id, aspect ratio, language, render status - before summarizing.
3. If several options fit, present the top few and ask which the operator wants.
4. Note the exact ids you'd use so the generate step is unambiguous.

## Rules

- Listing is safe and runs freely; **generating or exporting** a video waits for the operator's
  approval - rendering costs credits, so never kick one off unattended.
