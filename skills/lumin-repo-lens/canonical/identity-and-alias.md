# canonical/identity-and-alias.md

> **Role:** how this skill names things. Identity rules for types / helpers, and alias preservation across imports and re-exports. Absorbs four P0 review items from `SPEC-canon-generator v0.1`.
> **Owner:** this file.

---

## 1. Purpose

When two files both declare `type User`, they are two different identities. When `import { User } from './x'` is aliased as `AdminUser`, the identity is still the original `User` in `./x`, not `AdminUser`. When a barrel re-exports `User as PublicUser`, the identity of the thing it re-exports is `User` in the original owner, not `PublicUser` in the barrel.

This file fixes the rules so the skill's identity-keyed maps, fan-in counts, and canon drafts all agree on what "same thing" means.

Without this invariant, the canon-draft generator's P0 review items would recur: fan-in gets polluted by name collisions, duplicates get miscounted, barrel files get treated as owners.

## 2. The identity rule

**An identity is `ownerFile::exportedName`.**

- `ownerFile` is the file that contains the top-level `export` statement for the declaration (NOT a barrel that re-exports it).
- `exportedName` is the name as exported from the owner (NOT the local alias at any consumer site).

Examples:

```
src/protocol/ids.ts::SessionId
apps/admin/types.ts::User        // different from:
apps/blog/types.ts::User         // same name, different identity
```

**Never key by name alone.** `Map<typeName, ...>` is forbidden in any script that computes fan-in, duplicate detection, or ownership claims.

## 3. Fan-in is identity-keyed

Fan-in of `src/protocol/ids.ts::SessionId` is the count of consumer files that import the declaration in `src/protocol/ids.ts` named `SessionId` (possibly through aliases and barrels — chain-resolved to the defining identity).

Fan-in of `apps/admin/types.ts::User` and `apps/blog/types.ts::User` are independent counts. They may both be 0, both be 5, or any combination; the skill does not merge them.

## 4. Import alias preservation

```ts
import { User as AdminUser } from '../admin/types';
```

Required fields on the import record:

```json
{
  "fromSpec": "../admin/types",
  "importedName": "User",
  "localName": "AdminUser",
  "kind": "named",
  "typeOnly": false
}
```

Identity resolution uses `importedName` (source-side name), not `localName`. `localName` only matters inside the consumer file for in-file reference counting (which is a different concern, handled by `_engine/lib/classify-facts.mjs::countFileReferencesAst`).

For default imports, `importedName` is the literal string `"default"`.

## 5. Re-export alias preservation

```ts
// src/index.ts
export type { User as PublicUser } from '../admin/types';
```

Required fields on the re-export record:

```json
{
  "fromSpec": "../admin/types",
  "importedName": "User",
  "exportedName": "PublicUser",
  "kind": "named",
  "typeOnly": true
}
```

**Three distinct names may appear across an import chain**: `exportedName` at the barrel, `importedName` at the barrel's source side, and `localName` at a downstream consumer. Chain resolution must carry all three at each hop.

For `export * from './x'`, the re-export record uses a special marker:

```json
{
  "fromSpec": "./x",
  "exportKind": "star",
  "typeOnly": false
}
```

`star` re-exports flow the entire export surface of the source through; chain resolution treats each exported name at the source as appearing at the barrel with the same name.

## 6. Chain resolution algorithm

Given a consumer's use of a name, resolve to the defining identity.

Algorithm takes an **import record**, not loose `(spec, localName)` arguments, so `importedName` and `localName` are never confused and never drop across hops.

**Mixed file rule.** A file that owns some exports AND re-exports others is NOT a pure barrel, but is still a hop in the chain for the re-exported names. The loop condition is NOT "is this file a barrel" — it is "does this file directly own `nameAtBarrier`?". If it does, the loop terminates there. If it does not but has a re-export record for that name, the chain continues through the re-export. This matters because repos commonly have files like:

```ts
// src/index.ts
export const version = '1.0.0';            // owned
export type { User } from './types';       // re-exported
```

`src/index.ts` is NOT a pure barrel, but `import type { User } from './index'` must still resolve to `src/types.ts::User`, not `src/index.ts::User`.

```
resolveIdentity(consumerFile, importRecord):
  // importRecord: { fromSpec, importedName, localName, kind, typeOnly }

  1. resolvedFile = resolver.resolve(consumerFile, importRecord.fromSpec)
  2. nameAtBarrier = importRecord.importedName
  3. visited = []
  4. loop (cap at 8 iterations):

     a. OWNS?
        if resolvedFile has a direct top-level export whose `exportedName == nameAtBarrier`
        (i.e. an own declaration, not a re-export record):
          return { identity: (resolvedFile, nameAtBarrier),
                   reExportedThrough: visited }

     b. NAMED RE-EXPORT?
        let named = reExportsByFile[resolvedFile]?.find(r =>
          r.kind == 'named' AND r.exportedName == nameAtBarrier)
        if named:
          visited.push(resolvedFile)
          nameAtBarrier = named.importedName    // may differ if aliased
          resolvedFile  = resolver.resolve(resolvedFile, named.fromSpec)
          continue

     c. STAR RE-EXPORT?
        let stars = reExportsByFile[resolvedFile]?.filter(r =>
          r.exportKind == 'star')
        if stars is non-empty:
          candidates = []
          for each star in stars:
            probedFile = resolver.resolve(resolvedFile, star.fromSpec)
            if probedFile OWNS nameAtBarrier
               OR probedFile has a (recursive) re-export path to nameAtBarrier:
              candidates.push(probedFile)
          if candidates.length == 1:
            visited.push(resolvedFile)
            resolvedFile = candidates[0]        // star does NOT rename
            continue
          if candidates.length > 1:
            return [확인 불가, reason: ambiguous star re-export —
                    <N> star sources expose <nameAtBarrier>]
          // candidates.length == 0 falls through

     d. NO MATCH?
        return [확인 불가, reason: no owner/re-export for
                <nameAtBarrier> in <resolvedFile>]

  5. loop cap exceeded:
     return [확인 불가, reason: re-export chain deeper than 8 hops]
```

Depth limit 8 hops (matches `_engine/lib/alias-map.mjs::extractStringTarget` depth).

Key properties:

- The loop terminates on OWNS? (§6.a), not on "file is a barrel". Mixed files resolve correctly.
- STAR re-exports (§6.c) are ambiguity-preserving: if two star sources both could expose the name, the algorithm does NOT pick one — it emits `[확인 불가, ambiguous star re-export]`. The skill's honesty invariant forbids silent tie-breaking here.
- `importRecord.localName` is preserved by the caller for in-file reference counting at the consumer site. Identity resolution itself does NOT depend on `localName` — see §4.

Why the full `importRecord` is passed (not `(spec, localName)`): early drafts used `localName` for identity resolution, which is wrong (consumer-side name is irrelevant to the source identity). Passing the full record makes the correct field (`importedName`) unambiguous.

## 7. Barrel files are not owners — and mixed files follow the same rule per-name

A file is a "pure barrel" if it contains only `export ... from ...` statements and no non-re-export exports. Pure barrels never appear as the `ownerFile` of any identity.

A "mixed file" contains both its own owned exports and re-exports. It IS the `ownerFile` for the names it declares itself, and it is NOT the `ownerFile` for names it re-exports — identity resolution follows the re-export per §6.a / §6.b.

Concretely: for a given `nameAtBarrier`, a file is treated as a hop (not an owner) whenever it does not directly own that specific name but has a matching re-export record. Ownership is always per-name, never per-file-as-a-whole.

`reExportedThrough` is **exposure metadata**, not ownership. It helps downstream decide "where can this be imported from?" but does not affect the identity key.

## 8. Required shape of `reExportsByFile` (producer requirement)

For chain resolution to work, `symbols.json.reExportsByFile` must emit enough information. Current shape of each re-export record:

```json
{
  "source": "./y",
  "importedName": "User",
  "exportedName": "PublicUser",
  "typeOnly": true,
  "kind": "named"
}
```

Plus an entry for each `export *`:

```json
{
  "source": "./z",
  "exportKind": "star",
  "typeOnly": false
}
```

**If a producer cannot emit this fidelity**, downstream consumers (P1 pre-write, P3 canon-draft) must emit `[확인 불가, reason: re-export detail missing]` rather than guess. Partial fidelity is not allowed to silently produce partial identity claims.

This is the P0-3 fix from the canon-draft review: `reExportsByFile` needs symbol-level detail, not just `{source, line}`.

## 9. Resolver confidence interacts with identity claims

If `resolver-confidence` fact (see `fact-model.md` §3.8) reports `gate: tripped` for the scope, every identity claim derived from that scope's fan-in must be **downgraded by at least one level**:

- `confidence: high` → `confidence: medium`
- `confidence: medium` → `confidence: low`
- `confidence: low` → emit `[확인 불가]` instead of fact

This is because unresolved internal imports may be hiding consumers, which would change fan-in on affected identities.

The downgrade is **per-identity**, not repo-wide. Only identities whose path shape matches an unresolved specifier prefix (same logic as `specifierCouldMatchFile` in `_engine/lib/finding-provenance.mjs`) are downgraded. Identities in unaffected scopes keep their confidence.

## 10. Out-of-scope (not addressed here)

- Runtime identity (class instances, closures, singletons). This file is static-analysis only.
- Namespace / module declarations with internal structure. Treated as one identity per exported namespace name; inner members not separately identified in v1.
- Ambient `declare module '*.css'` style declarations. Not tracked as identities.

These may be revisited when shape-hash or runtime evidence layers mature.
