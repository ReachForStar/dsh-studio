---
name: git
description: Read repository history, compare branches, and find the commit that introduced a defect. Use when a task needs git history, blame, a diff between revisions, or a pinpointed introducing commit.
---

# Git history reading

Read history with the shell tool (`bash`, or `pwsh` on Windows) and plain `git` commands. Every command in this skill is read-only: never rewrite history, and never run `reset --hard`, `rebase`, `commit --amend`, or a forced push while investigating.

## Find the commit that introduced something

- `git log --oneline -n 20 -- <path>` — recent commits that touched a path.
- `git log -S"<exact text>" --oneline -- <path>` — pickaxe: the commits that added or removed a string.
- `git log -G"<regex>" --oneline -- <path>` — commits whose diff matches a pattern.
- `git blame -L <start>,<end> -- <path>` — the commit and author of each line in a range.
- `git log --follow --oneline -- <path>` — history across a rename.

Narrow before you widen: a path and a line range first, then the whole tree.

## Compare revisions

- `git diff <base>..<head> -- <path>` — what changed between two revisions.
- `git diff <base>...<head> --stat` — what a branch adds on top of its merge base.
- `git show <rev> --stat` and `git show <rev> -- <path>` — one commit's summary and content.

## Report

Answer with the command you ran, the relevant raw lines, and the conclusion. Quote commit subjects and short hashes from the output instead of retelling the repository history, and say explicitly when the evidence does not identify a single commit.
