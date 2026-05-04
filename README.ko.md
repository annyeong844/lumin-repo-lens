# 🌿 lumin-repo-lens

> **AI가 *"이미 있어요"* 라고 짚어주는 코딩 짝꿍.**
> *Your repo's kind little buddy for vibe-coding sessions.*

![Node](https://img.shields.io/badge/node-%E2%89%A520.19-green)
![Type](https://img.shields.io/badge/TS%2FJS-monorepo--friendly-blue)
![Tone](https://img.shields.io/badge/tone-kind-ff69b4)

🇰🇷 한국어 · 🇬🇧 [English](./README.md)

---

## 이런 적 있죠? 😅

당신이 AI한테 부탁해요:

> *"카드뉴스 서비스 만들어줘"*

AI가 신나게 새 파일 만들어요 → `lib/cardNewsService.js` ✨
근데 사실, 저장소엔 이미 `lib/cardNews/` 폴더에 비슷한 파일 3개가 있었어요. 😱

`lumin-repo-lens` 짝꿍이 있으면 AI가 먼저 이렇게 말해줘요:

> 🛑 *"잠깐, `lib/cardNews*` 에 이미 비슷한 파일 3개 있어요. 새로 만들기 전에 한번 볼래요?"*

추측 대신 **당신 저장소의 실제 증거**로요.

---

## 첫 번째 제대로 보기

**1. Claude Code에 플러그인 설치**

```
/plugin install lumin-repo-lens@annyeong844-marketplace
```

**2. 첫 점검은 full로 보기**

```
/lumin-repo-lens:full
```

→ 이때 Lumin의 진짜 비싼 증거들이 켜져요. shape index, function-clone cue,
call graph, barrel discipline, topology, public-surface 정책, grounded review
profile까지 같이 봅니다.

**3. 코드를 바꾸기 전후엔 write gate 쓰기**

```
/lumin-repo-lens:pre-write
# 코드 변경
/lumin-repo-lens:post-write
```

Claude Code에서는 compact intent를 assistant가 내부에서 추론해요. intent JSON을
사용자가 직접 쓸 필요는 없습니다.

> 💡 처음 한 번은 의존성을 자동으로 깔아요 (≈30초). 그다음부터는 빠름.
> 이미 fresh baseline이 있으면 작은 후속 확인은 `/lumin-repo-lens` quick path로 충분합니다.

아주 큰 저장소에서는 full profile을 매 edit마다 자동으로 돌리지 마세요. `:full`은
브랜치당 1회, 첫 점검, 또는 큰 리팩토링 리뷰에 쓰고, agent loop 중에는
pre-write/post-write와 quick 후속 확인을 쓰는 흐름이 맞습니다.

---

## 어떤 분에게 좋아요?

### ✅ 이런 분이라면 짝꿍 들이세요

- AI랑 같이 코딩하는데 **저장소가 점점 너저분해진다** 싶은 분
- AI가 **이미 있는 함수 또 만들 때** 답답한 분
- 리팩토링 후 **어디 부서졌는지 검증하고 싶은** 분
- TypeScript / JavaScript / 모노레포 프로젝트

### ❌ 이런 분은 아직 다른 도구가 더 좋아요

- Python / Rust 등 메인 언어가 다른 분 *(Go는 일부 지원)*
- AI 도구를 전혀 안 쓰는 분 *(이건 AI한테 증거를 주기 위한 도구예요)*
- 파일 1–2개짜리 미니 프로젝트 *(audit 가치가 잘 안 보임)*

---

## 짝꿍이 할 줄 아는 6가지

| 명령 | 언제 써요? |
|---|---|
| `/lumin-repo-lens:full` | full evidence profile — 첫 점검, 큰 리팩토링 뒤, shape/function-clone/call/topology 증거 보기 |
| `/lumin-repo-lens:pre-write` | 코딩 *전에* 짚어주기 — *"이거 만들기 전에 이미 있는지 봐줘"* |
| `/lumin-repo-lens:post-write` | 코딩 *후에* 검증 — *"방금 바꾼 거 다른 데 영향 안 갔어?"* |
| `/lumin-repo-lens:audit` | fresh artifact 위에서 작은 후속 확인을 빠르게 보기 |
| `/lumin-repo-lens:canon-draft` | 저장소 규칙 문서화 — *"우리 코드 패턴 정리해줘"* |
| `/lumin-repo-lens:check-canon` | 그 규칙 지켜졌는지 확인 — *"누가 규칙 깼나?"* |

뭐 부를지 모르겠으면 **`/lumin-repo-lens:welcome`** 부터. 짝꿍이 친절히 안내해줘요.

---

<details>
<summary><b>📦 다른 설치 방법</b></summary>

### npm CLI 도구로 쓰고 싶을 때

```bash
npm install -g github:annyeong844/lumin-repo-lens
lumin-repo-lens --root .
```

### 1회성으로만 (npx)

```bash
npx github:annyeong844/lumin-repo-lens --root .
```

### 자동 의존성 설치를 끄고 싶을 때

```bash
LUMIN_REPO_LENS_NO_AUTO_INSTALL=1 lumin-repo-lens --root .
```

이걸 켜면 자동으로 안 깔고, 깔아야 할 때 *"이 명령어로 직접 깔아주세요"* 라고 안내만 해요.

</details>

<details>
<summary><b>⚙️ 짝꿍이 어떻게 일하나요?</b></summary>

이 도구는 **저장소를 스캔해서 사실(evidence)만** 모아요.
*판단*은 AI가 그 사실을 *읽고* 합니다.

```
당신 저장소  →  lumin-repo-lens (차가운 evidence)  →  AI 짝꿍이 따뜻하게 설명
                       ↑                                    ↑
                    machine                              human
```

이렇게 두 단계로 나눈 이유는:

- AI가 **추측으로 답하지 않게** (환각 방지)
- 여러분이 **JSON을 직접 안 봐도** 되게 — 짝꿍이 풀어서 말해줘요
- 필요하면 그 *증거*를 직접 보여줄 수 있게 — `<저장소>/.audit/` 폴더에 저장

</details>

<details>
<summary><b>❓ 자주 묻는 질문</b></summary>

**Q. AI 없이 그냥 CLI로도 써요?**
네, `lumin-repo-lens --root .` 으로 직접 돌릴 수 있어요. 여러 JSON 증거 파일, summary markdown, 그리고 topology가 있으면 Mermaid 다이어그램 markdown도 만들어져요. 이 Mermaid 파일은 cross-submodule 흐름, cycle, hub 파일을 사람이 보기 쉽게 줄여 보여주는 보조 자료이고, 정확한 인용은 계속 `topology.json`을 기준으로 해요.

**Q. 처음 돌릴 때 왜 npm을 깔아요?**
저장소를 분석하려면 코드 파서 라이브러리가 필요해요. 첫 1회만 자동 설치하고 그다음엔 캐시 사용. 끄고 싶으면 `LUMIN_REPO_LENS_NO_AUTO_INSTALL=1`.

**Q. 저장소 안에 뭐가 만들어져요?**
`<저장소>/.audit/` 폴더에 JSON 증거 파일, summary markdown, topology Mermaid markdown이 만들어질 수 있어요. 보고 싶지 않으면 `.gitignore`에 `.audit/` 한 줄 추가하세요.

**Q. 너무 큰 저장소예요. 느리지 않아요?**
파일 200–300개 기준으로 *quick* 프로필은 십몇 초, *full* 프로필은 30초–1분 정도. 처음엔 quick으로 시작해보세요.

**Q. pre-write가 의미적 중복까지 이해하나요?**
아니요. pre-write는 빠른 transaction gate라서 이름, 경로, import, shape, topology처럼 기계가 근거로 잡은 신호만 봅니다. 정확한 심볼, 가까운 이름, 기존 파일, `merge-with-*` 같은 같은 디렉터리 prefix/token family는 잡을 수 있어요.

더 넓은 중복 탐지는 full profile이 맡습니다. full은 shape index, function-clone cue, call graph, barrel discipline, topology evidence까지 더 봅니다. 그래서 exact/near structural duplication은 훨씬 잘 드러내지만, `deepMerge`와 `MergeWithValues`처럼 이름이 완전히 다른 구현이 같은 개념이라는 주장은 machine evidence 없이 하지 않습니다. 그런 semantic equivalence는 코드 읽기, embedding, 또는 사람 리뷰 영역입니다.

**Q. post-write가 왜 quick scan만큼 무겁게 느껴질 수 있나요?**
post-write는 같은 pre-write advisory와 비교할 after snapshot을 새로 갱신합니다. 그래서 작은 수정이어도 저장소 walk 비용을 낼 수 있어요. 같은 `--output`을 재사용하면 artifact는 함께 모이고, incremental post-write cache는 다음 최적화 후보입니다. 현재 기본값은 오래된 clean 결과보다 fresh comparison을 우선합니다.

**Q. 영어 README는 따로 있어요?**
[README.md](./README.md) 가 영어 버전이에요.

</details>

---

## 저장소 / 라이선스

- 저장소: [github.com/annyeong844/lumin-repo-lens](https://github.com/annyeong844/lumin-repo-lens)
- 라이선스: [MIT](./LICENSE)
- 버그 / 제안: [Issues](https://github.com/annyeong844/lumin-repo-lens/issues)

---

> 💌 *이 짝꿍은 야단치지 않아요. 똑똑 두드려서 "이거 한번 봐주세요" 라고만 해요.*
