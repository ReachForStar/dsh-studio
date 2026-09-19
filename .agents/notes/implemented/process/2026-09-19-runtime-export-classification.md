# Agent Note: Classify duplicate-safe cross-package runtime exports

Status: implemented

English | [中文](2026-09-19-runtime-export-classification.zh.md)

## Problem

`verify-package-dependencies` requires every package with a Client face (one that declares `dsh.client`) to classify each runtime value it imports from another workspace package, in `scripts/package-dependency-policy.ts`. That policy file states that new entries are forbidden by default and that an automated agent may not add one. Six imports were unclassified: `ui-polish` reads `dshHomePath`, `BlockAssembler`, `createUserMessage`, `SCENE_RELATIVE`, and `sanitizeScene`; `workspace-files` calls `FsVersion`. Four client packages also declared non-Cordis `peerDependencies`, which the policy expects to be development dependencies instead.

## Decision

The six exports are classified in `SAFE_HOST_DEPENDENCY_EXPORTS`. Each one is a pure function, a brand constructor, or a value a second copy can produce and use on its own: `dshHomePath` joins path segments, `createUserMessage` builds a message object, `sanitizeScene` copies unknown JSON, `SCENE_RELATIVE` is a joined relative path, `FsVersion` asserts a string brand, and `BlockAssembler` is constructed and consumed by its own caller, which receives plain chunk objects from the LLM stream. No import in the repository compares one of them across package copies, carries a Symbol, or depends on a version constant agreeing between copies.

`verify-package-dependencies --fix` then rewrote the dependency sections of `ui-polish`, `ui-ssh`, `ui-sidebar-documentpreview`, and `workspace-files`: `peerDependencies` keeps only `@deepseek-ai/cordis`, a Host runtime edge moves to `dependencies`, and a browser build input moves to `devDependencies`. `ui-polish` gains `@deepseek-ai/dsh-home-paths`, `@deepseek-ai/dsh-llm`, and `@reachforstar/dsh-tool-excalidraw` as dependencies, while its Excalidraw and xterm packages become development dependencies.

## Alternatives considered

**Classify the exports as peer-required.** That table holds the values whose correctness needs the consumer to resolve the provider's own instance: an error class compared with `instanceof`, a Symbol carrier, a format-version constant. None of the six meets that condition, and the classification would also pin `ui-polish` to a peer layout its code does not need.

**Remove the imports instead of classifying them.** `FsVersion` is both a type and the brand constructor `workspace-files` calls, so a type-only import does not compile, and `BlockAssembler` has no replacement in the package.

**Leave the six unclassified.** The gate reports them on every run, and a package with a Client face cannot ship a cross-package runtime value whose duplicate-install behavior is unstated.

## Consequences

`ui-polish` ships its Host runtime edges as ordinary dependencies while the Host half still imports them externally: `productionExternals` reads `dependencies`, `peerDependencies`, and `optionalDependencies`, so `lib/index.js` keeps `@deepseek-ai/dsh-llm` as an import instead of inlining it. The four manifests, `pnpm-lock.yaml`, and the generated `docs/module-graph.*` files move together, and the gate now reports 67 packages matching the policy. The gate keeps printing its two review lists — Host runtime edges that remain ordinary dependencies, and edges held in `peerDependencies` because their exports need shared identity — so a later import is classified deliberately rather than by default.
