---
name: heygen-video
description: Use when the operator asks you to make an AI avatar video in HeyGen - a talking-head clip, a script read by an avatar - so the render happens only through a reviewed, approved action.
---

# heygen-video - generate a HeyGen video

Turn a request into a concrete HeyGen video generation, proposed for the operator's approval.

## When to use

- The operator says "make a video of… saying…", "turn this script into an avatar clip".

## Steps

1. List first (see heygen-list) so you pick a real avatar, voice, and (if any) template.
2. State the plan: avatar, voice, aspect ratio, and the exact script that will be spoken.
3. Propose the generate; it spends render credits and is outward, so it surfaces as an approval card - wait.
4. After approval, report the video id and share the link once the render completes.

## Rules

- Every render is human-gated - it costs credits and produces a shareable asset. No unattended generates.
- Read the script back exactly as it will be spoken; don't paraphrase or add claims the operator didn't give.
