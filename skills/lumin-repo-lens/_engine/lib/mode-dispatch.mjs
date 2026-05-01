// Mode dispatcher for the pre-write gate.
//
// Pure library function — reads only `userText` + `cwdMeta`. Returns
// whether pre-write mode should fire for this user request, and if not,
// why (so the caller can either silently skip or surface the reason).
//
// Canonical anchor: `canonical/mode-contract.md` §2.1 (dispatch), §3.1
// / §3.2 / §3.4 (trigger vocabulary), §3.5 (compound triggers). All
// verb and guard lists below are direct copies from those sections;
// changes here REQUIRE a canonical-spine update.
//
// `pre-write.mjs` CLI does NOT call this dispatcher (CLI is explicit
// per maintainer history notes §4.1 Option A). This module exists for future SKILL-
// runtime / orchestrator use and to pin the mode-contract rule table
// as a testable function.

// ── Vocabulary (from mode-contract.md §3.1–§3.4) ─────────────

// Korean write verbs (§3.1). Matched via substring — Korean lacks the
// word-boundary semantics that regex \b gives in English.
//
const KOREAN_VERBS = Object.freeze([
  '만들어줘', '구현해줘', '추가해줘', '고쳐줘', '리팩터링해줘', '리팩토링해줘',
  '바꿔줘', '수정해줘', '버그 잡아줘', '지워줘', '빼줘',
  '새로 짜줘', '옮겨줘', '이름 바꿔줘', '분리해줘', '통합해줘',
  '연결해줘', '연동해줘',
]);

// English write verbs (§3.2). Matched with word-boundary regex.
const ENGLISH_VERBS = Object.freeze([
  'add', 'create', 'implement', 'build', 'write', 'make', 'fix', 'patch',
  'refactor', 'rename', 'extract', 'inline', 'move', 'split', 'merge',
  'remove', 'delete', 'replace', 'update', 'modify',
]);

// Korean guards (§3.4).
const KOREAN_GUARDS = Object.freeze([
  '설명해줘', '보여줘', '찾아줘', '찾아서', '어떻게 해', '괜찮아',
]);

// English guards (§3.4).
const ENGLISH_GUARDS = Object.freeze([
  'explain', 'show', 'find', 'how does', 'how do', 'is it ok',
]);

// ── Prose-rewrite detection ──────────────────────────────────
//
// mode-contract.md §2.2 lists prose rewrite as a non-trigger. We detect
// via doc-file hint + doc-verb co-occurrence. Pure file-name mention
// without a verb is NOT prose rewrite (could be code referencing the
// doc); the co-occurrence check keeps it narrow.

const DOC_FILE_HINTS = Object.freeze([
  'README', 'CHANGELOG', 'CONTRIBUTING', 'LICENSE',
]);
const DOC_PATH_HINTS = Object.freeze(['docs/', 'doc/']);
// Doc verbs — these combined with a doc-file hint mean prose rewrite.
const DOC_VERBS_KR = Object.freeze(['다듬', '업데이트', '수정']);
const DOC_VERBS_EN = Object.freeze(['rewrite', 'update', 'edit', 'polish', 'revise']);

function looksLikeProseRewrite(text) {
  const lower = text.toLowerCase();

  // Doc-file hint present?
  const hasDocFile =
    DOC_FILE_HINTS.some((h) => text.includes(h)) ||
    DOC_PATH_HINTS.some((h) => lower.includes(h)) ||
    /\.md\b/i.test(text);

  if (!hasDocFile) return false;

  const hasDocVerb =
    DOC_VERBS_KR.some((v) => text.includes(v)) ||
    DOC_VERBS_EN.some((v) => new RegExp(`\\b${v}\\b`, 'i').test(text));

  return hasDocVerb;
}

// ── Comment typo fix detection ───────────────────────────────
//
// mode-contract.md §2.2 non-trigger. Requires both a comment-word and
// a typo-word in the same request. More conservative than generic "fix"
// alone to avoid swallowing real bug-fix requests.

function looksLikeCommentTypoFix(text) {
  const lower = text.toLowerCase();
  const hasCommentWord = text.includes('주석') || /\bcomment\b/i.test(lower);
  const hasTypoWord = text.includes('오타') || /\btypo\b/i.test(lower);
  return hasCommentWord && hasTypoWord;
}

// ── Pure inspection detection ────────────────────────────────
//
// mode-contract.md §2.2 non-trigger. Question-form requests asking
// "how does X work" without proposing a change.

function looksLikePureInspection(text) {
  const lower = text.toLowerCase();
  if (/어떻게\s*동작/.test(text)) return true;
  if (/어떻게\s*해.?요.?\??/.test(text)) return true;
  if (/\bhow\s+does\b/.test(lower)) return true;
  if (/\bhow\s+do\s+I\b/.test(lower)) return true;
  return false;
}

// ── Core matchers ────────────────────────────────────────────

function matchKoreanSubstring(text, vocabulary) {
  const hits = [];
  for (const term of vocabulary) {
    if (text.includes(term)) hits.push(term);
  }
  return hits;
}

function matchEnglishWord(text, vocabulary) {
  const hits = [];
  const lower = text.toLowerCase();
  for (const term of vocabulary) {
    // Multi-word terms ("how does") stay as-is; single-word terms get
    // word-boundary matching.
    if (term.includes(' ')) {
      if (lower.includes(term)) hits.push(term);
    } else {
      if (new RegExp(`\\b${term}\\b`, 'i').test(text)) hits.push(term);
    }
  }
  return hits;
}

function matchVerbs(text) {
  return [
    ...matchKoreanSubstring(text, KOREAN_VERBS),
    ...matchEnglishWord(text, ENGLISH_VERBS),
  ];
}

function matchGuards(text) {
  return [
    ...matchKoreanSubstring(text, KOREAN_GUARDS),
    ...matchEnglishWord(text, ENGLISH_GUARDS),
  ];
}

function hasRepoContext(cwdMeta) {
  return !!(cwdMeta?.hasPackageJson || cwdMeta?.hasTsconfig || cwdMeta?.hasSrcTree);
}

// ── Entry point ──────────────────────────────────────────────

/**
 * Decide whether to enter pre-write mode for this user request.
 *
 * @param {string} userText  the user's request text (Korean, English, or mixed)
 * @param {{
 *   hasPackageJson?: boolean,
 *   hasTsconfig?: boolean,
 *   hasSrcTree?: boolean,
 * }} cwdMeta  current working directory indicators
 * @returns {{
 *   mode: 'pre-write' | 'none',
 *   rationale: string,
 *   matchedVerbs: string[],
 *   matchedGuards: string[],
 *   compoundGuardPlusVerb: boolean,
 *   nonTriggerReason?: 'guard-only' | 'no-repo-context'
 *                    | 'prose-rewrite' | 'comment-typo-fix'
 *                    | 'pure-inspection',
 * }}
 */
export function dispatchMode(userText, cwdMeta) {
  const matchedVerbs = matchVerbs(userText);
  const matchedGuards = matchGuards(userText);
  const compoundGuardPlusVerb = matchedVerbs.length > 0 && matchedGuards.length > 0;

  // Non-trigger precedence (highest first). Each check returns a 'none'
  // result immediately; order matters.

  // 1. No repo context — highest precedence. Even a clear verb means
  //    nothing if we're not in a code repo.
  if (!hasRepoContext(cwdMeta)) {
    return {
      mode: 'none',
      rationale: 'mode-contract.md §2.1: current working directory is not a repo (no package.json / tsconfig.json / src tree)',
      matchedVerbs,
      matchedGuards,
      compoundGuardPlusVerb,
      nonTriggerReason: 'no-repo-context',
    };
  }

  // 2. Prose rewrite — doc-file + doc-verb co-occurrence.
  if (looksLikeProseRewrite(userText)) {
    return {
      mode: 'none',
      rationale: 'mode-contract.md §2.2: prose rewrite (README / CHANGELOG / docs/*.md) is a non-trigger',
      matchedVerbs,
      matchedGuards,
      compoundGuardPlusVerb,
      nonTriggerReason: 'prose-rewrite',
    };
  }

  // 3. Comment typo fix.
  if (looksLikeCommentTypoFix(userText)) {
    return {
      mode: 'none',
      rationale: 'mode-contract.md §2.2: comment typo fix is a non-trigger',
      matchedVerbs,
      matchedGuards,
      compoundGuardPlusVerb,
      nonTriggerReason: 'comment-typo-fix',
    };
  }

  // 4. Pure inspection (question form, no verb intent).
  if (looksLikePureInspection(userText)) {
    return {
      mode: 'none',
      rationale: 'mode-contract.md §2.2: pure inspection (how does X work) is a non-trigger',
      matchedVerbs,
      matchedGuards,
      compoundGuardPlusVerb,
      nonTriggerReason: 'pure-inspection',
    };
  }

  // 5. Write verb present (possibly compound with a guard) → fire.
  //    Per mode-contract.md §3.5, compound guard+verb fires pre-write
  //    (the verb wins); guard-only does not.
  if (matchedVerbs.length > 0) {
    return {
      mode: 'pre-write',
      rationale: compoundGuardPlusVerb
        ? 'mode-contract.md §3.5: compound guard+verb — verb wins, pre-write fires'
        : 'mode-contract.md §2.1 + §3.1–§3.2: write verb detected in repo context',
      matchedVerbs,
      matchedGuards,
      compoundGuardPlusVerb,
    };
  }

  // 6. Guard-alone (or nothing at all) → non-trigger.
  return {
    mode: 'none',
    rationale: matchedGuards.length > 0
      ? 'mode-contract.md §3.4: guard word alone, no write verb'
      : 'mode-contract.md §2.1: no write-verb detected',
    matchedVerbs,
    matchedGuards,
    compoundGuardPlusVerb,
    nonTriggerReason: 'guard-only',
  };
}
