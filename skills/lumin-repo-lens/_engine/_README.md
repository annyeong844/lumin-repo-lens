# Internal Engine

This directory is packaged with the skill because the public
`scripts/*.mjs` wrappers need it at runtime.

Files under `_engine/` are internal implementation details. They
are not a stable user-facing API; use `scripts/audit-repo.mjs` or
the other public wrappers instead.
