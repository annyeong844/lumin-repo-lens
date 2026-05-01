# False-Positive Index

Use this index when a visible dead/semi-dead/export finding needs a quick
false-positive screen. This file is the shipping first stop. The long
historical ledger lives in `docs/maintainer/false-positive-patterns-ledger.md`
in the maintainer checkout, not in the normal deployable context. If that
path is absent, stop at this index and the artifact's own FP flags.

Do not open the long ledger wholesale during ordinary review. Prefer:

1. artifact flags already present on the finding;
2. this compact index by keyword or family;
3. a maintainer-ledger lookup only when changing FP policy or adding a family.

## Quick Keyword Map

| If the finding smells like... | Check these families |
| --- | --- |
| Bundler/tool config default export | FP-01, FP-22 |
| Ambient declaration or `.d.ts` sidecar | FP-02 |
| Node `#imports`, root-prefix import, tsconfig paths, workspace resolver gap | FP-03, FP-16, FP-21, FP-26, FP-28, FP-29, FP-33, FP-36 |
| Re-export, barrel, package public API, type/predicate partner | FP-05, FP-06, FP-10, FP-20, FP-23, FP-25 |
| Test-only, fixture, example, playground, top-level tests | FP-07, FP-12, FP-24, FP-31 |
| Framework filesystem-routed file or frontend app sentinel | FP-14, FP-27, FP-30 |
| Dynamic import or runtime discovery | FP-18 |
| JSX runtime import or hook reported semi-dead | FP-04, FP-19 |
| Codegen marker or generated-path convention | FP-09 |
| Self-audit scanner noise or missing local type dependencies | FP-11, FP-15 |

## Chat Rule

Translate matched families into plain reasons such as "protected public
surface", "framework-routed file", "test-only consumer", or "resolver blind
spot". Do not show FP ids unless the user asks for exact proof or a maintainer
handoff.
