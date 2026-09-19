---
name: run
description: Execute a minimal reproduction, a focused test, or a build in the sandbox and report its real result. Use when a claim must rest on a command's output rather than on reading code.
---

# Running code and tests

Run commands with the shell tool (`bash`, or `pwsh` on Windows) and report what actually happened: the exact command, the exit status, and the failure lines.

## Choose the smallest command

- Prefer a command the project already defines (`package.json` scripts, a Make target, a task runner) over an improvised one.
- Run one test file, one case, or one package before the whole suite.
- Reproduce a bug with a minimal script before proposing a fix; keep the script in the workspace so the reproduction can be repeated.

## One pass, then batch

Make every change you already know is needed before running the command. Run once, collect every failure from that run, fix them together, and run again. Repeated single-fix runs waste the command's fixed cost and hide failures that were already visible.

## Report

State the command, the exit status, and the failing assertions or error output verbatim. Never claim a test passed without its output, and never present a partial run as a full one.
