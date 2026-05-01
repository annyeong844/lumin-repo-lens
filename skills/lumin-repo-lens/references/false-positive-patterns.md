# False-Positive Patterns

Compatibility shim for older links. This short file does **not** mean FP
screening was removed: policy matching still lives in the engine artifacts
(`fix-plan.json`, `dead-classify.json`, `MUTED` findings, and policy reasons).

Use `references/false-positive-index.md` for ordinary review. The compact
index is the shipping surface for quick dead/semi-dead false-positive screens.

The long historical ledger moved to
`docs/maintainer/false-positive-patterns-ledger.md`. It contains maintainer
case notes, dated measurements, and patch-history context, so it is not part
of the deployable skill package's normal context budget.
If that path is absent, use only `references/false-positive-index.md` and the
artifact's own FP flags.

Open the maintainer ledger only when changing FP policy, debugging a specific
family, or adding a new family from a verified case.
