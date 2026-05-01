# Templates

Use this folder for output shapes: files here tell the model what the
final answer should look like after the relevant policy or reference has
already been read.

| Need | Template | Notes |
| --- | --- | --- |
| Normal chat-facing structural review | `REVIEW_CHECKLIST_SHORT.md` | Default for `/lumin-repo-lens` and ordinary review requests. |
| Formal audit report / due diligence | `report-template.md` | Use only when the user asks for a formal report or full evidence trail. |
| Gentle refactor plan output | `refactor-plan-template.md` | Read `references/refactor-plan-policy.md` first; this file only owns output shape. |
| Full structural checklist walk | `REVIEW_CHECKLIST.md` | Repo-neutral long checklist; use explicit full-review requests only. |
| Living audit tracking document | `living-audit-template.md` | Agent-authored document for tracking NEW/ACTIVE/RESOLVED/NOT_RECHECKED items across runs. |

Short output does not mean shallow analysis. Normal chat-facing reviews
still require an internal checklist triage pass over the main C, D, E,
A, B, and F lenses before the model selects the few items to show.

Saved formal reports require a final-author closeout pass before final
answer or handoff: re-read headline counts, same-site classifications,
broad conclusions, and chat-persona leakage against cited artifacts or
source. Do not replace this with string-lint heuristics.

Maintainer-only dogfood notes live in `docs/maintainer/`, not in this
folder.
