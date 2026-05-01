# Refactor Plan Output Template

Use this template for the user-facing shape of `refactor-plan` output.
Read `references/refactor-plan-policy.md` first for tone, slice
selection, evidence, lifecycle, and ripple-aware rules.

## SHORT Mode — Default Chat Output

Use this by default. Four short sections are enough.

1. **What Is Already Working**
   - 2 or 3 strengths only.
   - If meaningful strengths are thin, use **Current State** and one
     factual scan-confidence line instead of padding praise.
   - Use short evidence in parentheses, not long labels or raw paths.

2. **Next Refactor Slice**
   - One sentence: what to change and why now.
   - Files/directories in scope.
   - What to leave alone.
   - A copy/paste line that starts with "Ask the coding agent:".

3. **How We Verify**
   - One test/build command.
   - One audit/check command.
   - One success condition.

4. **After That**
   - 1 to 3 later candidates.
   - Say which one should wait for more evidence.

Example shape:

```markdown
**What Already Works**
- Dependencies are acyclic and parser confidence is high (`topology.json`, `manifest.json`).
- The current large function signal is watch-only, not an emergency (`checklist-facts.json`).

**Next Slice**
Smooth the self-audit path so generated skill mirrors do not double-count the tool itself.
Touch `audit-repo.mjs` and the scan-scope helpers. Leave dead-export classification alone.
Pre-write handoff: files=`audit-repo.mjs`, scan helpers; names/dependencies/shapes/escapes empty unless implementation discovers them.
Ask the coding agent: "Please make only this slice: smooth the self-audit path so generated skill mirrors do not double-count the tool. Start with pre-write, touch only `audit-repo.mjs` and scan-scope helpers unless a caller update is required, leave dead-export classification alone, then run `npm test` and a quick self-audit."

**How We Verify**
Run `npm test`, then rerun a quick self-audit without manually excluding the generated mirror.
Success means file count and top fan-in stay near the focused baseline.

**After That**
- Clarify `--exclude` help text.
- Re-run `check-canon`.
- Consider splitting `check-canon-utils.mjs` only when the next feature touches it.
```

Default length target: 20 to 35 lines. If the output is getting longer,
cut scope before adding sections. Offer an evidence trail or formal
version only when the user asks for proof or handoff detail.

## FULL Mode — Handoff Output

Use this only when the user asks for a formal handoff, phase spec,
machine-readable planning data, or due-diligence trail. Do not make the
user read this for a small refactor.

Recommended sections:

1. What is already working
2. Goal in plain language
3. Evidence snapshot
4. Phase map
5. Phase 1 slice spec
6. Phase 1 quick-audit scope
7. Acceptance and verification
8. Risks and leave-alone list
9. Closeout loop

Only include machine-readable scope JSON when the user asks for it or
when the next tool consumes it directly. Otherwise, write the scope in
plain language.

## Optional Evidence Trail

Include this only when the user asks for proof, exact counts, a formal
report, or reviewer handoff. Keep the coaching answer first, then add a
compact evidence trail with:

- artifact path
- value or representative element
- scan range when making absence claims
- explicit confidence if evidence is partial
