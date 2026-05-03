# Glossary

Use this file when SKILL.md or an audit result uses a term that would
otherwise force the user to learn maintainer vocabulary.

| Term | Plain meaning |
| --- | --- |
| `grounded` | Directly reproducible from a named artifact value. |
| `degraded` | Partial evidence; give the confidence and the reason it is not fully grounded. |
| `unknown` | The needed artifact or scan range is missing; say what was inspected. |
| FP family | A known false-positive pattern, such as `publicApi_FP23`. Use it to explain why a raw finding should be muted or downgraded. |
| `Tier C` | A raw dead-export bucket: no consumer was found in the constructed graph. It is not a deletion verdict. |
| `SAFE_FIX` | Static-graph-clean dead-export candidate under the recorded scan range. It is not an absolute proof; cite scan range/confidence before acting. |
| `REVIEW_FIX` | Dead-export candidate that needs human or model review before action. |
| `DEGRADED` | Dead-export candidate with weaker evidence, usually due to freshness, resolver, runtime, or framework limits. |
| `MUTED` | Finding intentionally suppressed by a policy or false-positive family. |
| `HCA-1/2/3` | Formal report sections: 30-second summary, decision points, and evidence trail index. |
| `P4` | Shape-index evidence, usually exact exported type-shape matching. |
| phase numbering (`P0`-`P6`) | Maintainer roadmap labels for workstreams. They are planning vocabulary, not user-facing verdicts. |
| `canonical/` | Can mean the target repo's maintained claims or this skill package's own runtime/spec truth. Name which one you mean. |
| canonical drift | Current generated facts disagree with promoted `canonical/` truth. |
| `refactor-plan` | Coaching mode: the model authors a small next-step plan over audit evidence; it is not a machine verdict. |
