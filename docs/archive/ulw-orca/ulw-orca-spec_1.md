# ulw-orca 스킬 명세서 (v0.3 초안)

- 작성일: 2026-09-11 (v0.2: 프로필·카테고리 라우팅 / v0.3: senpi native goal에 예산 상한이 없음이 확인되어 조기 종료를 감독관 주도 방식으로 교체)
- 상태: 코드 작성 전 명세. 확인 필요 항목은 §13에 모아 두었고, 본문에서는 `[확인]`으로 표시했다.
- MVP 범위(v0.3): 조기 종료는 **감독관(드라이버)이 판정하고 워커에 `LAND_AND_HANDOFF`를 보내는 방식** 하나로 통일한다. 판정 근거는 goal 파일의 `tokensUsed`(비캐시 입력+출력), 세션 JSONL의 프롬프트 크기, 사이클 경과 시간 세 가지. 워커는 웨이브 착륙 → 인계 문서 → `worker_done`만 하고, goal을 닫지 않는다(감독관이 세션을 종료하므로 필요 없음). FIX 기반 프롬프트 교정은 제외.
- **v0.2에서 바뀐 이유**: senpi native의 `create_goal`/`get_goal` 응답에는 `tokenBudget`·`remainingTokens`·`budgetLimited`가 없다(이번 세션 로그의 응답 키: threadId, objective, status, tokensUsed, timeUsedSeconds, createdAt, updatedAt). 예산 상한과 `budgetLimited`는 OpenCode 에디션의 pi-goal 기능이었다. 따라서 goal 자체 예산에 의존하는 설계는 폐기한다.
- 근거: OMO `dev` 문서·스킬(orchestration.md, ulw-plan, ulw-execute, mass-ulw, pi-goal), Orca 저장소(skill-guides/orchestration, orca-cli, CLI reference), SearchAd 세션 재집계

## 0. 목적과 범위

기능 하나를 만들 때 사람은 **인터뷰**와 **계획 시각화 리뷰** 두 번만 개입하고, 그 뒤는 감독관 세션이 일회용 워커 세션을 갈아 끼우며 실행·검증하고 **PR 1개**로 끝내는 흐름을 OMO 스킬 하나로 묶는다. 감독관은 산출물(코드·대화)을 보지 않고 토큰 경제성과 진행 상태만 본다.

범위 밖: OMO·Orca 자체 수정, 워밍업 설정 변경(공개 설정 없음), 멀티 리포지토리.

## 1. 전제 환경

| 항목 | 값 | 비고 |
|---|---|---|
| OS | Windows | omo는 Orca 데스크톱 터미널 안에서 실행 중(원격 접속용) |
| Orca CLI 이름 | `orca` | Settings → General → Orca CLI에서 등록해야 셸에서 보인다. Orca가 관리하는 WSL 세션에는 `ORCA_CLI_COMMAND` 환경변수가 내려오므로 스크립트는 "`ORCA_CLI_COMMAND` 있으면 그 값, 없으면 `orca`"로 해석한다. Linux에서만 `orca-ide` |
| Orca에 omo 등록 | 없음 | 따라서 `worker-start --agent omo`는 불가. `terminal create --command "omo"`로 터미널을 만든 뒤 `worker-start --terminal <handle>`로 그 터미널을 감독 대상 워커로 채택한다(Orca 가이드의 "lifecycle ownership of an existing agent terminal" 경로) |
| OMO | 5.0.0-beta.53, senpi 2026.9.10 | 커스텀 스킬 위치: 프로젝트 `.agents/skills/<name>/` 또는 사용자 `~/.agents/skills/<name>/` |
| 구독 | Codex Pro x5(메인·감독관·일부 자식), Claude Max x5(자식) | 라우팅은 앞선 제안서(omo-small-orchestrator-routing-proposal.md)대로 |
| 크레딧 환산 | Sol 125 / 12.5 / 750 per 100만 토큰 | 5시간 창 ≈ 2,300 크레딧 상당(추정) |

## 2. 역할과 세션

| 기호 | 세션 | 모델 선택 방식 | 보는 것 | 하지 않는 것 |
|---|---|---|---|---|
| H | 사람 | — | 인터뷰 질문, 리뷰 페이지, 마지막 PR | 프롬프트 작성, 웨이브별 리뷰 |
| P | 계획 세션(omo) | 사용자 기본 프로필(orchestrator) | 저장소, 사람 답변 | 구현. 계획 승인 뒤 감독관을 띄우고 종료 |
| S | 감독관 세션(omo) | `OMO_PROFILE=supervisor` → `model_profile` 체인 | orca 영수증 JSON, `worker_done` 3문장, 리포트 숫자, goal 상태 파일 | goal 생성, ulw 모드, 코드·트랜스크립트 읽기, 워커 프롬프트 즉흥 작성 |
| W_n | 워커 세션(omo, 일회용) | `OMO_PROFILE=worker` → `model_profile` 체인. 자식은 카테고리 라우팅 | 계획 파일, 인계 문서, 자기 자식들 | 새 세션·터미널 생성, PR 생성, 머지 |
| F | 마무리 워커(omo, 1회) | `OMO_PROFILE=worker` | `main...feat/<slug>` 전체 diff | 기능 추가 |

세션 P, S, W, F는 모두 같은 Orca 리포 안의 터미널이다. P와 S는 리포 루트(`--worktree active`)에서, W와 F는 `feat/<slug>` worktree에서 뜬다.

### 2.1 모델은 직접 지정하지 않고 라우팅을 탄다

- **자식(구현·검증·리뷰)**: 항상 `category`로 라우팅한다(`quick`, `deep`, `reviewer` 등). 카테고리 체인이 lane 포화·한도 오류 폴백을 처리한다. 워커 spec과 계획의 `Recommended task executor category:` 줄이 카테고리를 정하고, spec에 `model`을 넣지 않는다(카테고리와 `model` 동시 지정은 거부됨).
- **세션의 메인 모델(S, W, F)**: 카테고리는 메인 세션에 적용되지 않으므로 대신 **`model_profile` 체인**을 쓴다. 체인은 새 세션 시작 시 첫 사용 가능한 rung을 고르고, 실행 중 실패는 senpi의 `retry.fallbackChains`가 처리한다. 세션마다 다른 체인을 주기 위해 **설정 프로필(`profiles.<name>`)**을 `OMO_PROFILE` 환경변수로 켠다. 스크립트는 `--model` 플래그를 쓰지 않는다.
- 프로젝트 `.omo/omo.jsonc`에 두는 정의(모델 별칭은 라우팅 제안서의 `models` 카탈로그를 재사용):

```jsonc
{
  "model_profiles": {
    "worker":     { "display_name": "ulw-orca worker",     "models": ["sol-high", "opus-high"] },
    "supervisor": { "display_name": "ulw-orca supervisor", "models": ["terra-medium", "haiku"] },
    "dummy":      { "display_name": "ulw-orca dummy test", "models": ["terra-medium", "haiku"] }
  },
  "profiles": {
    "worker":     { "model_profile": "worker" },
    "supervisor": { "model_profile": "supervisor" },
    "dummy":      { "model_profile": "dummy" }
  }
}
```

- 세션 기동 명령은 `OMO_PROFILE=<이름> omo` 형태다. Orca 터미널의 셸에 맞게 접두를 만든다(PowerShell `$env:OMO_PROFILE='worker'; omo`, cmd `set OMO_PROFILE=worker&& omo`, bash `OMO_PROFILE=worker omo`) `[확인: Orca 터미널 기본 셸, terminal create --command에서 환경변수 전달]`.
- 더미 검증(§11)은 `OMO_PROFILE=dummy`로 워커를 띄우고 자식은 카테고리 그대로 둔다. 모델을 코드에 박지 않으므로 검증·운영 전환은 프로필 이름 하나로 끝난다.

## 3. 전체 흐름

```
H  /ulw-plan + 브리핑("인터뷰해줘")
P  탐색 → 인터뷰 → brief ──────────────────────── 힌트: "계획을 쓰려면 okay"
H  okay
P  .omo/plans/<slug>.md 작성 (plan-reviewer 검토 포함)
P  [규칙 자동 연결] ulw-orca 스킬 호출
     ├ plan-review 렌더 → <slug>.review.html 열기 ─ 힌트: "Approve 버튼 또는 approve"
     └ review.json 대기(monitor)
H  Approve 클릭 (또는 approve)          ── 수정 요청은 말로 → 계획 수정 → 재렌더
P  launch: feat/<slug> worktree 생성, S 시작 ─── 힌트: "이후는 S에서: status / stop"
P  종료
S  cycle 반복: W_n 생성 → worker_done 대기 → 해제 → 리포트 → 판단
     └ 계획 complete → finish: F 생성 → 전체 diff 리뷰·최종 검증 → PR 1개
H  PR 머지 (선택: F가 자동 머지)
```

### 3.1 단계 상세

| # | 단계 | 주체 | 입력 | 출력 | 종료 조건 |
|---|---|---|---|---|---|
| 0 | 브리핑 | H→P | 배경 / 되어야 하는 것 / 안 되어야 하는 것 / 이미 정한 것 / "인터뷰해줘" | — | P가 의도 판정(CLEAR/UNCLEAR)을 선언 |
| 1 | 인터뷰·brief | P | 저장소 탐색, H 답변 | `.omo/drafts/<slug>.md` | H가 `okay` |
| 2 | 계획 작성 | P | draft | `.omo/plans/<slug>.md` | plan-reviewer 승인(최대 5라운드) |
| 3 | 자동 연결 | P(규칙) | 계획 파일 존재 | ulw-orca 스킬 진입 | — |
| 4 | 시각화 리뷰 | P→H | 계획 md | `<slug>.review.html`, 로컬 서버 | `review.json.decision == "approve"` |
| 5 | 계획 반영 | P | review.json의 거부/메모 | 계획 md 갱신(변경 시 plan-reviewer 1라운드) | 갱신 완료 |
| 6 | 감독관 기동 | P | slug | `feat/<slug>` worktree, S 터미널, `.omo/ulw-orca/<slug>/state.json` | S가 "ready" 기록 → P 종료 |
| 7 | 워커 사이클 | S | state.json | W_n 실행, 리포트, ledger 행 | 계획 complete 또는 stop |
| 8 | 마무리 | S | complete 신호 | F 실행 → PR URL | PR 생성 (선택: 머지) |

## 4. 사용자 어휘와 힌트 문장

사용자가 기억할 것은 `/ulw-plan` 하나다. 나머지 단어는 각 정지 지점에서 세션이 **고정 문장**으로 알려 준다. 힌트 문장은 템플릿에 상수로 두고 세션이 그대로 출력한다(즉흥 표현 금지).

| 시점 | 힌트 문장(고정) | 유효 입력 |
|---|---|---|
| brief 제시 후 | `→ 계획을 쓰려면 "okay". 바꿀 것은 말로.` | `okay`(ulw-plan 내장) / 자유 문장 |
| 리뷰 페이지 열림 | `→ 페이지에서 검토 후 Approve 버튼, 또는 "approve". 수정은 말로 하면 다시 렌더링합니다.` | 클릭 / `approve` / 자유 문장 |
| 감독관 기동 직후 | `→ 이 세션은 닫습니다. 진행은 감독관 세션(터미널 "<title>")에서 "status", 정지는 "stop".` | — |
| 감독관 사이클 종료마다 | `사이클 N · 착륙 <k>/<total> · 창 <x>% · FIX <m>. 계속합니다. 정지는 "stop".` | `status` / `stop` |
| 감독관이 사람을 부를 때 | `→ 판단 필요: <한 줄 사유>. "go"면 계속, "stop"이면 정지.` | `go` / `stop` |

`stop`은 즉시 종료가 아니라 "현재 워커의 진행 웨이브 착륙 후 정지"다. 즉시 종료가 필요하면 사용자가 Orca에서 터미널을 닫는다.

## 5. 파일 구성

```
.agents/skills/ulw-orca/
  SKILL.md                    # 트리거·절차·금지(§6.1)
  rules/ulw-orca.md           # 프로젝트 규칙에 복사해 넣을 자동 연결 문장(§6.2)
  templates/
    supervisor.md             # 감독관 첫 프롬프트(§6.5)
    worker-spec.md            # 워커 spec 템플릿(§6.6)
    finish-spec.md            # 마무리 워커 spec 템플릿(§6.9)
    hints.json                # §4 힌트 문장 상수
  scripts/
    plan-review.mjs           # 계획 md → review.html + 로컬 서버 + review.json(§6.3)
    launch.mjs                # feat worktree + 감독관 세션 생성(§6.4)
    omo_driver.py             # 사이클·마무리 드라이버(§6.7)
    omo_session_report.py     # 기존 리포트 스크립트(§6.8)
  config/defaults.json        # 임계값·예산 기본값(§8)
```

프로젝트 쪽 상태는 `.omo/ulw-orca/<slug>/` 아래에만 쓴다(`state.json`, `review.json`, `cycles.jsonl`, `usage-ledger.csv`).

## 6. 컴포넌트 명세

### 6.1 SKILL.md

- 트리거: 사용자가 `ulw-orca`라고 말하거나, 프로젝트 규칙(§6.2)이 계획 완성 직후 호출하거나, `/ulw-orca <slug>`.
- 절차(P 세션에서만 실행):
  1. slug 결정: 인자 > 이 세션이 방금 쓴 계획 > `.omo/plans/`에 하나만 있으면 그것. 둘 이상이면 한 번만 질문.
  2. `node scripts/plan-review.mjs <slug> --serve` 실행(백그라운드). 출력의 URL을 Orca 브라우저로 연다 `[확인: orca browser open 명령]`, 힌트 문장 출력.
  3. `review.json`을 monitor로 대기. `decision`이 `approve`면 §6.3의 수정 사항을 계획에 반영하고, 계획이 바뀌었으면 plan-reviewer 1라운드.
  4. `node scripts/launch.mjs <slug>` 실행. 결과 JSON의 감독관 터미널 title을 넣어 힌트 문장 출력.
  5. 턴 종료. 이 세션은 더 이상 아무 것도 하지 않는다.
- 금지: 구현·워커 생성·goal 생성. 이 스킬은 P 세션 전용이며 S·W 세션에서는 호출되지 않아야 한다(spec에 "ulw-orca 호출 금지" 명시).

### 6.2 프로젝트 규칙(자동 연결)

프로젝트 규칙 파일에 추가하는 한 문단. 이번 세션 로그의 `rule-activation` 기록으로 senpi native가 프로젝트 규칙을 주입한다는 점은 확인됐다 `[확인: 규칙 파일의 정확한 경로·형식]`.

> ulw-plan이 `.omo/plans/<slug>.md`를 완성하고 인계 설명을 출력한 직후에는, 사용자의 추가 지시를 기다리지 말고 ulw-orca 스킬을 같은 slug로 이어서 호출한다. 단, 사용자가 "리뷰 생략" 또는 "감독관 없이"라고 말한 경우는 예외다.

### 6.3 plan-review.mjs

- 입력: `.omo/plans/<slug>.md`. scaffold-plan이 만든 고정 헤더(`## TL;DR (For humans)`, `## Scope` → `### Must have` / `### Must NOT have`, `## Verification strategy`, `## Execution strategy` → `### Parallel execution waves` / `### Dependency matrix`, `## Todos`의 `- [ ] N. <title>` 블록과 하위 필드, `## Final verification wave`, `## Success criteria`)를 파싱한다. 파싱은 결정론적이며 LLM을 쓰지 않는다.
- 출력: `.omo/ulw-orca/<slug>/review.html`(단일 파일, 외부 리소스 없음).
- 페이지 구성:
  1. TL;DR과 "What it will NOT do".
  2. 웨이브·의존 그래프(SVG): 노드 = Todo, 간선 = Dependency matrix. 노드 클릭 시 해당 Todo 카드로 이동.
  3. Todo 카드: What to do / Must NOT do, References, Acceptance criteria, QA scenarios, Recommended category. 카드마다 "메모" 입력란.
  4. "플래너가 대신 정한 것"(UNCLEAR 판정 시 announced defaults, draft의 `## Open assumptions`) 목록: 항목마다 **거부** 토글.
  5. Must NOT have 목록: 항목마다 "추가" 입력란.
  6. 예산 패널: `config/defaults.json`의 `usage_budget`·`context_steer`·`cycle_max_minutes`·창 크레딧과 계산기(앞선 가이드의 계산식 재사용). 값 변경 가능.
  7. 하단 고정 바: `Approve` 버튼, `Request changes` 버튼, 힌트 문장.
- 서버: `--serve`면 127.0.0.1의 임의 포트로 정적 페이지를 서빙하고 `POST /decision`을 받아 `review.json`을 쓴다. 파일 저장 후 서버 종료. `--serve` 없이는 html만 생성(파일로 열어도 읽기 가능, 결정은 채팅 `approve`로).
- `review.json` 스키마:
  ```json
  { "slug": "...", "decision": "approve" | "changes", "at": "<ISO>",
    "vetoes": ["<assumption id>"], "must_not_add": ["..."],
    "todo_notes": { "3": "..." }, "budget": { "usage_budget": 600000, "context_steer": 100000, "cycle_max_minutes": 90, "window_credits": 2300 } }
  ```
- P 세션의 반영 규칙: `vetoes`는 해당 기본값을 질문으로 되돌려 사용자에게 한 번 묻고, `must_not_add`는 Must NOT have에 추가, `todo_notes`는 해당 Todo의 What to do에 병합. 계획이 바뀌면 plan-reviewer 1라운드 후 재렌더 없이 진행(사용자가 이미 결정을 내렸으므로).

### 6.4 launch.mjs

- 입력: slug, `config/defaults.json`, `review.json`(예산).
- 동작:
  1. `orca status --json`으로 런타임 확인. 실패 시 `orca open --json` 후 재시도.
  2. 기준 브랜치에서 `feat/<slug>` worktree 생성: `orca worktree create --name feat-<slug> --no-parent --json` `[확인: 브랜치명 지정 옵션]`. 이미 있으면 재사용(재개 경로).
  3. 감독관 터미널 생성: `orca terminal create --worktree active --title "ulw-orca:<slug>" --command "<OMO_PROFILE=supervisor 접두> omo" --json` → handle. 모델은 §2.1의 `supervisor` 프로필 체인이 고른다(`--model` 사용 금지).
  4. `orca terminal wait --terminal <h> --for tui-idle --timeout-ms 60000 --json`. `satisfied`가 아니면 한 번 더 큰 타임아웃으로 재시도, 그래도 실패면 오류 종료(프롬프트 유실 방지).
  5. `templates/supervisor.md`에 slug·경로·예산을 치환한 텍스트를 `orca terminal send --terminal <h> --text "<...>" --enter --json`으로 전송.
  6. `.omo/ulw-orca/<slug>/state.json` 생성: `{ phase: "supervising", supervisor_handle, feat_worktree, plan, created_at }`.
- 출력: JSON(handle, title, worktree id).

### 6.5 templates/supervisor.md (감독관 첫 프롬프트)

포함해야 하는 내용(고정 문장 + 치환 변수):

1. 정체: "너는 ulw-orca 감독관이다. 계획 `<slug>`를 워커 세션에 나눠 실행시키고 토큰 경제성만 관리한다."
2. 금지: goal 생성 금지(`create_goal` 호출 금지, `ulw`·`ulw-loop` 발동 금지), 코드·트랜스크립트·계획 본문 읽기 금지, 워커 프롬프트 즉흥 작성 금지(드라이버가 템플릿으로 만든다), 직접 구현 금지.
3. 루프: `python <skill>/scripts/omo_driver.py cycle --slug <slug>`를 **백그라운드 셸**로 실행하고 종료 알림을 기다린다(폴링·sleep 금지). 알림이 오면 결과 JSON 한 줄을 읽고 §6.7의 판단 규칙을 적용한다.
4. 판단 규칙(§6.7 `decision` 필드에 따름): `continue` → 다음 cycle, `finish` → `omo_driver.py finish`, `ask_human` → §4 힌트 문장으로 사람을 부르고 `go`/`stop` 대기, `stopped` → 종료 보고.
5. 보고 형식: 사이클마다 §4의 한 줄. `status` 요청 시 `omo_driver.py status` 출력만 전달.
6. 사용자 입력 처리: `stop` → `omo_driver.py stop`(현재 워커에 착륙 후 종료 steer), `status`, `go`. 그 외 문장은 "이 세션은 감독관입니다. 계획 변경은 새 /ulw-plan에서" 안내.

### 6.6 templates/worker-spec.md (워커 spec)

Orca가 프리앰블(Task/Dispatch ID, worker_done 명령)을 앞에 붙여 워커 TUI에 주입한다. spec 본문은 Orca 계약대로 Target / Change / Constraints / Ownership / Observable acceptance를 갖추고, 안에 ulw-execute 실행 지시를 넣는다. 슬래시가 아니라 이름으로 호출한다(스킬은 이름으로 발동).

- **TASK**: "Run ulw-execute for plan `<slug>` in this worktree until the plan is complete or a stop condition holds."
- **실행 옵션**: `--make-pr` 없음(웨이브는 이 worktree의 브랜치에 직접 착륙). 머지·PR 생성 금지.
- **goal**: ulw-execute가 만드는 goal을 그대로 쓴다. 예산 파라미터는 넣지 않는다(senpi native goal에 예산 상한 없음). 감독관이 `.omo/goal/<sessionId>.json`의 `tokensUsed`를 밖에서 읽는다.
- **격리 규칙**: 새 세션·터미널·Orca 명령(orca worktree/terminal/orchestration 중 프리앰블에 적힌 send/check 제외) 금지, ulw-orca 스킬 호출 금지.
- **메인 컨텍스트 규칙**: `.omo/**/sessions/*.jsonl`, SKILL.md, 5,000토큰 초과 파일 읽기 금지. 자식 결과는 1,500토큰 이하 요약 계약. `task_output`은 완료 후 1회 tail 40줄 이하.
- **조기 종료 규칙(MVP)**: 프리앰블의 `check --terminal <handle>`을 체크포인트마다(웨이브 착륙 직후, 새 웨이브 dispatch 직전, 자식 완료 알림 처리 직후) 실행하고, 감독관의 `LAND_AND_HANDOFF` 메시지를 받으면 새 웨이브를 시작하지 않고 진행 중 웨이브만 착륙시킨 뒤 `.omo/handoffs/<slug>-<UTC>.md`에 인계 문서(완료된 체크박스 번호, 남은 체크박스, 착륙한 커밋, 실행 중 결정, 다음 세션 시작 지시)를 쓰고 `worker_done`을 보낸다. **goal은 닫지 않는다** — 감독관이 `worker-release`로 세션을 종료하므로 필요 없다.
- **자식 모델 지정 금지**: 자식은 `category`로만 spawn한다. `model`을 직접 지정하지 않는다(폴백 체인이 한도·포화를 처리하도록).
- **완료 보고**: 프리앰블의 `worker_done` 명령을 정확히 1회. `--outcome succeeded`는 계획 complete 또는 정상 인계, `failed`는 그 외. 본문 3문장 고정 형식:
  1. `LANDED: <k>/<total> checkboxes; last commit <sha>`
  2. `REASON: complete | budget | context | blocked(<one line>)`
  3. `NEXT: <handoff path or "none">`
- **이전 인계 문서**: 있으면 경로를 넣고 "먼저 읽고 이어서 하라".

### 6.7 omo_driver.py

공통: `ORCA_CLI_COMMAND` 우선, 없으면 `orca`. 모든 orca 호출은 `--json`. 상태는 `.omo/ulw-orca/<slug>/state.json`, 사이클 기록은 `cycles.jsonl`.

| 서브커맨드 | 동작 | 출력(JSON 한 줄) |
|---|---|---|
| `init --slug` | run 생성(`orchestration run-create --objective "<slug> 완주"`), state 초기화 | `{run_id}` |
| `spawn --slug [--profile worker|dummy]` | ① `terminal create --worktree id:<feat> --title "W<n>:<slug>" --command "<OMO_PROFILE=<profile> 접두> omo"` ② `terminal wait --for tui-idle --timeout-ms 60000` ③ `task-create --spec "<worker-spec 치환본>"` ④ `worker-start --task <task_id> --terminal <handle>` (`--model`/`--effort`는 쓰지 않음) | `{handle, task_id, dispatch_id, session_hint}` |
| `wait --slug` | `orchestration check --wait --types "worker_done,escalation,question" --timeout-ms <check_timeout_ms>`를 반복. 타임아웃은 체크포인트(재대기). 매 재대기 전 §6.7.1 조기 종료 판정 수행. `question`이 오면 `ask_human` 반환 | `{event, outcome, landed, reason, next, delivery_id}` |
| `release --slug` | 배달 `--ack`, `worker-release --dispatch <id>`(터미널 종료) | `{released: true}` |
| `report --slug` | 워커 세션 JSONL을 찾아(§7) `omo_session_report.py --json --ledger` 실행 | 리포트 요약(5지표 OK/FIX, 크레딧) |
| `cycle --slug` | init(필요시) → spawn → wait → release → report → 판단 | `{cycle, decision, landed, reason, report_summary, hint_line}` |
| `finish --slug` | `finish-spec` 워커 spawn → wait → release → 리포트. PR URL 회수 | `{pr_url, decision}` |
| `stop --slug` | state에 `stop_requested` 기록 + 진행 중 dispatch에 `LAND_AND_HANDOFF` 전송(§6.7.1과 같은 경로). 워커가 착륙·인계 후 `worker_done`을 보내면 다음 사이클을 시작하지 않는다 | `{ok}` |
| `status --slug` | state·cycles 요약 | 한 줄 |

#### 6.7.1 조기 종료 판정과 steer(wait 중)

재대기(`check --wait` 타임아웃)마다 드라이버가 세 값을 읽어 `cycles.jsonl`에 기록하고, 하나라도 임계값을 넘으면 **한 번만** steer한다.

| 근거 | 읽는 곳 | 임계값(§8) |
|---|---|---|
| goal 사용량(비캐시 입력+출력) | `.omo/goal/<sessionId>.json`의 `tokensUsed` | `usage_budget` |
| 프롬프트 크기 | 워커 JSONL 마지막 assistant usage의 `input+cacheRead+cacheWrite` | `context_steer` |
| 사이클 경과 시간 | spawn 시각 | `cycle_max_minutes` |

- steer: `orchestration send --to dispatch:<id> --subject LAND_AND_HANDOFF --body "reason=<usage|context|time>; land current wave, write handoff, then worker_done" --json`. 성공은 큐 적재 증명일 뿐이므로 `state.json`에 `steer_sent_at`을 기록한다.
- 유예: steer 후 `steer_grace_minutes` 안에 `worker_done`이 없으면 `worker-stop --dispatch <id>`로 세션을 종료하고 사이클을 `killed`로 기록한다. 착륙되지 않은 웨이브는 다음 워커가 계획 체크박스·원장·남은 task-owned worktree에서 이어간다(`[확인 6]`).
- 콜드 리드(비캐시 ≥ 100K) 횟수는 기록만 한다(리포트에서 FIX로 드러남).

#### 6.7.2 판단 규칙(cycle의 `decision`)

| 조건 | decision |
|---|---|
| REASON=complete | `finish` |
| REASON=budget 또는 context, 남은 체크박스 있음, 사이클 수 < `max_cycles` | `continue`(다음 spawn에 인계 문서 경로 주입) |
| REASON=blocked, 또는 같은 REASON이 2사이클 연속 착륙 0 | `ask_human` |
| 리포트 FIX ≥ 3개가 2사이클 연속 | `ask_human`(사유: "규칙 조정 필요") |
| `stop_requested` | `stopped` |
| 사이클 수 ≥ `max_cycles` | `ask_human` |

`continue`일 때 드라이버는 다음 spec에 최신 인계 문서 경로와 "사이클 N/M"만 넣는다. FIX 항목에 따른 교정 문장 자동 추가는 MVP에서 제외하고(v0.3 후보), FIX는 리포트·ledger로 사람이 본다.

### 6.8 리포트(omo_session_report.py)

기존 스크립트를 그대로 쓰되 `--json`과 `--ledger`를 사용한다. ledger에는 §7의 산출 지표 두 개(착륙 체크박스 수, 재시도 노드 수)를 열로 추가한다 `[구현 시 확장]`.

### 6.9 templates/finish-spec.md (마무리 워커)

- TASK: `main...feat/<slug>` 전체 diff에 대해 내장 `omo-senpi-code-reviewer`(설정된 모델)로 리뷰하고, 계획의 `## Final verification wave`를 다시 실행한다.
- 지적 사항은 quick/unspecified-low 자식으로 수정하고 재검증한다. 기능 추가 금지.
- 통과 시 PR 1개 생성(`gh pr create`, 본문에 계획 TL;DR·검증 결과·사이클 요약). `auto_merge=true`면 CI·리뷰 게이트 통과 후 저장소 정책대로 머지, 아니면 URL만 보고.
- `worker_done` 3문장: `LANDED: PR <url>` / `REASON: complete` / `NEXT: none`.

## 7. 상태·신호·경로

| 대상 | 경로/규칙 |
|---|---|
| 계획 | `.omo/plans/<slug>.md`, 초안 `.omo/drafts/<slug>.md` |
| 리뷰 | `.omo/ulw-orca/<slug>/review.html`, `review.json` |
| 감독 상태 | `.omo/ulw-orca/<slug>/state.json`, `cycles.jsonl`, `usage-ledger.csv` |
| 인계 문서 | `.omo/handoffs/<slug>-<UTC>.md` |
| goal 상태(워커) | `.omo/goal/<sessionId>.json`(`status`: active/paused/blocked/complete, `tokensUsed`) — 조기 종료 판정 근거이자 worker_done 미수신 시 예비 신호 |
| 워커 세션 JSONL | `~/.omo/agent/sessions/<cwd 슬러그>/<UTC>_<sessionId>.jsonl`. 워커 생성 직후 해당 디렉터리에서 가장 최근 파일을 잡고, goal 파일의 sessionId와 대조해 확정 |
| 워커→감독관 신호 | 1순위 `worker_done`(check), 2순위 goal 파일 상태 변화 + 인계 문서 생성, 3순위 `terminal wait --for exit` |
| 감독관→워커 신호 | `orchestration send --to dispatch:<id>` (LAND_AND_HANDOFF만 사용) |

## 8. 기본값(config/defaults.json)

| 키 | 기본 | 의미 |
|---|---|---|
| `usage_budget` | 600,000 | goal 파일 `tokensUsed`(비캐시 입력+출력)가 이 값을 넘으면 steer |
| `context_steer` | 100,000 | 프롬프트 크기가 이 값을 넘으면 steer(컨텍스트 팽창의 직접 지표) |
| `cycle_max_minutes` | 90 | 사이클 경과 시간이 이 값을 넘으면 steer(안전망) |
| `steer_grace_minutes` | 10 | steer 후 worker_done을 기다리는 유예. 초과 시 `worker-stop` |
| `worker_profile` / `supervisor_profile` / `dummy_profile` | `worker` / `supervisor` / `dummy` | `OMO_PROFILE`로 켜는 설정 프로필 이름(§2.1). 모델 id는 여기 두지 않는다 |
| `window_credits` | 2,300 | 5시간 창 크레딧 상당(Pro x5 추정) |
| `window_share_max` | 0.7 | 사이클 누적이 이 비율을 넘으면 다음 사이클 전에 `ask_human` |
| `max_cycles` | 8 | 계획 하나당 워커 세션 상한 |
| `check_timeout_ms` | 900,000 | Orca check --wait 1회 타임아웃 |
| `auto_merge` | false | 마무리 워커의 자동 머지 |
| `report_targets` | context 120K · calls/spawn 8 · warmup 0 · cold 3 | 리포트 판정 목표 |

## 9. 장애 처리

| 상황 | 처리 |
|---|---|
| `terminal wait` 미충족(omo TUI 준비 안 됨) | 타임아웃 2배로 1회 재시도, 실패 시 터미널 닫고 사이클 실패 기록, `ask_human` |
| worker_done 없이 워커 idle 장기화 | goal 파일 상태·인계 문서를 예비 신호로 판정. 둘 다 없고 `terminal read --screen`에 오류 화면이면 `worker-stop` 후 재spawn(최대 1회) |
| 한도 오류(429/usage limit)로 워커 정지 | 워커 폴백 체인이 처리. 그래도 `blocked`면 감독관이 `ask_human`(사유: 두 구독 모두 한도) |
| Orca 재시작으로 handle stale | `terminal list --worktree id:<feat>`로 재획득. dispatch id로 주소 지정은 유지 |
| 리뷰 서버 포트 충돌 | 임의 포트 재시도 3회, 실패 시 html만 생성하고 채팅 `approve`로 진행 |
| 계획 파일 둘 이상·없음 | 있음: 한 번 질문. 없음: ulw-orca는 시작하지 않고 `/ulw-plan` 안내 |
| feat 브랜치 기존 존재 | 재개로 간주(state.json 확인). 상태 없으면 사용자에게 재사용/새 이름 질문 |
| 워커가 새 세션을 만들려 함 | spec 금지 조항 + 감독관은 `terminal list`로 예기치 않은 터미널을 발견하면 닫고 기록 |
| 워커가 `LAND_AND_HANDOFF`를 무시 | 유예 후 `worker-stop`. 더미 검증에서 무시가 반복되면 spec의 check 주기를 "도구 호출 3회마다"로 강화하고, 그래도 안 되면 프리앰블 준수를 규칙 파일로 끌어올린다 |

## 10. 보안·권한

- 워커 격리는 worktree 격리이며 보안 샌드박스가 아니다. Orca 권한 모드(yolo/manual)는 사용자 정책에 따른다.
- 인계 문서·리포트에는 비밀 값(토큰·키)을 쓰지 않는다. 드라이버는 메시지 본문을 읽지 않고 usage와 메시지 종류만 집계한다.
- 감독관은 코드에 접근할 도구를 쓰지 않도록 프롬프트로 제한한다(도구 자체 차단은 `[확인: 감독관용 agent 도구 제한 설정]`).

## 11. 검증 계획(수용 기준)

| 기준 | 측정 |
|---|---|
| 사람 입력 횟수 | 브리핑 1 + 인터뷰 답변 n + `okay` 1 + 클릭/`approve` 1 + 머지 1. 그 외 입력이 필요하면 결함 |
| PR 수 | 기능당 1 |
| 감독관 세션 | 호출당 프롬프트 ≤ 30K, 사이클당 호출 ≤ 3, goal 없음 |
| 워커 세션 | 리포트 5지표 목표 달성률을 ledger로 추적. 첫 목표: 컨텍스트 중앙값 ≤ 120K, 워밍업 턴 0 |
| 재개 | 감독관·워커를 강제 종료해도 `state.json`과 계획 체크박스로 이어감 |

테스트 순서: ① 리뷰 렌더러 단독(기존 계획 md로) → ② launch로 감독관 1개 생성·힌트 출력 → ③ 버리는 리포에서 체크박스 1개(quick, README 한 줄)짜리 더미 계획으로 cycle 1회(`OMO_PROFILE=dummy`) → ④ `usage_budget`을 50,000으로 낮춰 steer → 착륙·인계 → worker_done → 재spawn이 한 번씩 일어나게 → ⑤ finish로 그 리포에 PR 1회 생성 → ⑥ 실제 Stage 계획. ③~⑤에서 확인할 것: OMO 워커가 프리앰블대로 `worker_done`을 보내는가, `worker-release`로 옛 세션이 실제 종료되는가, 재개 세션이 끝난 체크박스를 건너뛰는가, 리포트가 워커 JSONL을 올바르게 찾는가. 5시간 창이 새로 시작된 뒤 실행한다.

## 12. 구현 순서

1. `plan-review.mjs`(렌더 + 서버) — 사람이 바로 쓸 수 있고 다른 구성 요소와 독립.
2. `omo_driver.py`의 `spawn/wait/release/report`를 orca 명령과 대조하며 하나씩.
3. `templates/*`와 `SKILL.md`, 규칙 문단.
4. `launch.mjs`, `cycle`, `finish`.
5. 임계값 튜닝은 ledger 3세션 이후.

## 13. 확인 필요 사항

| # | 항목 | 확인 방법 |
|---|---|---|
| 1 | `orca orchestration worker-start --terminal <handle>`이 `--task`와 함께 현재 설치본에서 동작하는지 | `orca orchestration worker-start --help` |
| 2 | `orca worktree create`에 브랜치명 지정 옵션 | `orca worktree create --help` |
| 3 | Orca 브라우저로 로컬 URL을 여는 CLI 명령 | `orca --help`(browser/open 계열), 없으면 `terminal send`로 기본 브라우저 열기 |
| 4 | `OMO_PROFILE` 환경변수가 `profiles.<name>` 층을 켜고 그 층의 `model_profile`이 새 세션 시작 모델을 정하는지(senpi native) | `OMO_PROFILE=dummy omo` 시작 후 세션 시작 알림("model profile ... selected ...") 확인 |
| 4b | Orca `terminal create --command`에서 환경변수 접두가 전달되는지, 터미널 기본 셸(PowerShell/cmd/bash) | `terminal create --command "<접두> omo"` 후 `terminal read --screen` |
| 5 | OMO 워커가 Orca 프리앰블(heartbeat·check·worker_done)을 따르는지 | ③번 더미 테스트에서 관찰. 안 따르면 spec 상단에 프리앰블 준수 문장 강화, 예비 신호(goal 파일)로 보완 |
| 6 | ulw-execute의 통합 베이스가 "워커가 시작한 브랜치"인지 | 더미 계획 실행 후 `git log feat/<slug>` |
| 7 | senpi native의 백그라운드 셸·monitor 최대 실행 시간 | 로그(`senpi-terminal:notification`)로 확인. 상한이 있으면 드라이버 `wait`를 여러 번 나눠 호출 |
| 8 | 프로젝트 규칙 파일 경로·형식(senpi native) | `rule-activation` 기록의 targetPath 참조, OMO 문서 |
| 9 | (해소) senpi native goal에는 예산 상한·`budgetLimited`가 없음 — 로그의 goal 응답 키로 확인. `.omo/goal/<sessionId>.json`이 실제로 존재하고 `tokensUsed`가 갱신되는지만 확인 | 워커 실행 중 파일 관찰 |
| 11 | OMO 워커가 `check --terminal`로 steer를 읽고 `LAND_AND_HANDOFF`에 따라 착륙·인계·`worker_done`을 하는지 | 더미 검증 ④에서 `usage_budget`을 아주 낮게 두고 관찰 |
| 12 | `worker-stop`으로 강제 종료된 뒤 다음 워커가 계획 체크박스·원장에서 이어가는지, 남은 task-owned worktree 처리 | 더미 검증에서 유예 0으로 한 번 강제 종료 |
| 10 | 감독관 도구 제한(코드 읽기 차단) 설정 가능 여부 | `agents.<name>.tools` / `disallowed_tools` 문서 |
