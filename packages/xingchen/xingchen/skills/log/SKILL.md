---
name: log
description: Parse a log file, stack trace, or crash dump into the evidence that identifies the failure. Use when the input is a log, a traceback, a core dump excerpt, or a CI failure excerpt.
---

# Log and stack-trace parsing

Read the log with the filesystem tools and the shell tool. Extract the failing path; do not paste a whole log into the answer or into the model's context.

## Order of reading

- Read the first error, not the last line: later lines are usually consequences.
- Follow a stack trace from the innermost frame in the application's own code outward; framework frames usually name the mechanism, not the cause.
- For a repeated error, take one complete instance plus the count and the first and last timestamps instead of every occurrence.
- For a crash dump or an exit without a message, look for the signal, the exit code, and any "caused by" or "during handling" chain before the frames.

## Narrowing

- Filter by level and by the failing component: `grep -n "ERROR"`, then the component's own prefix.
- Compress repeated lines: sort or count identical messages to see whether one cause produced many lines.
- Map each frame to a file and line when the workspace has that source, and read the frames that the trace names.

## Report

Give the minimal evidence set — the error message, the innermost application frame, the trigger line if present, and the count — then the conclusion it supports. Mark a conclusion as unproven when the log does not carry the evidence for it.
