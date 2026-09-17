# Agent Note: Choose the conversation width with a slider

Status: implemented

English | [中文](2026-09-17-conversation-width-slider.zh.md)

## Problem

The transcript width was reachable only by dragging one of two 40px col-resize strips that flanked the content column. The control had no keyboard or assistive-technology path, it consumed 88px of column budget per side so that its own hit area stayed placeable, it needed a pointer-tracking glow to be discoverable at all, and its gesture model (symmetric outward travel, a commit only after real travel) was invisible to the user. The value it wrote was a plain bounded number, which is what a slider exists to choose.

## Decision

`ui-primitives` gains a `Slider`: a controlled numeric input over a native range input, with a required `label`, an optional localized `valueText`, and a one-pixel step. The conversation renders it as a strip above the scrollport in the conversation body, because a strip in the flow cannot overlap the transcript it sizes. Its range is `[640, columnWidth - 176]` and its position is the resolved width, so the control's own length shows the width it sets, and it is present exactly while a transcript is (the active phase). Every step publishes the CSS override and stores the resolved width, which retires the commit-only-after-travel rule the drag needed: a range input has no press-without-change state. The two strips, their glow, and their pointer-capture plumbing are deleted; the stored preference key and the resolution clamp are unchanged, so widths users already chose keep their size.

## Alternatives considered

**Keep the strips and add a keyboard path beside them.** Two interaction models for one value, and the strips still consume the column budget they were designed around.

**Put the slider in a popover behind a button.** The control's effect disappears with it, which is the opposite of what a width control needs.

**Reach for an external slider package.** The control is a styled native input; a dependency would add a component tree, a theme surface, and an upgrade path for forty lines of markup.

## Consequences

The strip takes about 24px of vertical space above the transcript while a session is active, and it stays hidden for views that elect a composer overlay, exactly as the strips were. A width chosen while the column is narrow is stored clamped to that column, which is how a clamped drag committed before. The primitive carries its own tests, and the conversation spec covers the round trip, the floor, the column re-clamp, and the hero state that renders no control.
