# About description: show expand control only when text is clipped

Date: 2026-10-04

## Intent

The owner wants the token detail About section to show `Show more` only when the description actually exceeds its three-line collapsed display. A one-line or otherwise fully visible description should have no expand control. This is a focused frontend change; no API, DB, or Envio work is needed.

## Current behavior

`fe/src/features/launch/about-section.tsx` applies `line-clamp-3` while collapsed but renders the toggle for every non-null description. The existing test checks that a long description expands and that a null description has no toggle; it does not cover short text or responsive reflow.

## Behavior

- Keep the existing three-line collapsed limit and the `Show more` / `Show less` labels.
- Determine whether the rendered description is clipped at its current width. Do not use a character-count threshold: the same text may occupy different numbers of lines on mobile and desktop, and explicit line breaks matter.
- Show the toggle only when the collapsed text would be clipped. Clicking it reveals the full description; clicking `Show less` restores the three-line display.
- Recalculate after the description changes and when the available width changes. If text no longer exceeds three lines after reflow, hide the toggle and return to the collapsed state.
- A null, empty, or whitespace-only description has no paragraph or toggle. Preserve meaningful whitespace and line breaks in nonempty descriptions.
- The measurement element is excluded from the accessibility tree and does not create duplicate readable text. The visible button stays a real button with its existing accessible label.

## Implementation approach

Measure actual DOM overflow for a three-line clamped description after layout and observe width changes with `ResizeObserver`. The overflow measurement must remain valid while the visible description is expanded; a hidden measurement copy is acceptable if measuring the visible paragraph would lose the collapsed height. Keep measurement and toggle state inside `AboutSection`; do not add a package or a server-side text-length rule.

## Verification

Cover short text, long text, manual newlines, null/blank input, expand/collapse, and a width change that makes the same description cross the three-line threshold. Unit tests may mock layout dimensions, but at least one browser-level check should exercise actual wrapping at desktop and mobile widths because jsdom does not calculate line layout.

## Scope

This spec covers only description expansion. Clipboard handling, URL validation, and explorer-link fallback are separate items from the owner's list.
