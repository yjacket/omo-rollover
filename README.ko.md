# omo-rollover

[English](README.md) | 한국어

오래 실행되는 OMO 메인 세션의 컨텍스트가 토큰 예산을 넘으면 새 세션으로
넘겨주는(handoff) Senpi/OMO 확장이다. JSONL 이벤트 로그와 정적 추세 대시보드를
함께 제공한다. `docs/microworld.html`은 의도한 동작을 보여주는 기준 시각화다.

## 동작

```
watching ──컨텍스트 ≥ 예산 (또는 opt-in: reread 비율 ≥ max가 3개 메시지 연속)──▶ armed
watching ──idle 타이머 (사용자 입력 없음 ≥ idleMinutes ∧ 컨텍스트 ≥ idleMinTokens ∧ isIdle ∧ Σ 자식 wake == 0)──▶ armed(reason=idle)
armed    ──(turn_end | agent_settled | idle tick) ∧ Σ 자식 wake == 0 ∧ !hasPendingMessages──▶ handoff_requested
handoff_requested ──(agent_settled | turn_end) ∧ 마지막 assistant 응답에 <successor> 있음 ∧ Σ 자식 wake == 0 ∧ !hasPendingMessages──▶ rollover
```

- **armed**: goal을 일시정지하고(아래 "Goal 일시정지" 참고), `tool_call` 훅에서
  스폰 도구를 차단하며 대기 중인 handoff를 설명하는 오류를 돌려준다. 차단
  목록은 정확히 `task`와 `task_create`다(omo-task는 두 이름을 모두 노출한다).
  `task_output`, `task_list`, `task_cancel`, `task_get`, `task_update`,
  `task_send`는 허용되어 메인이 결과를 계속 수집할 수 있다. 차단은 `watching`을
  제외한 모든 상태에서 유지된다. 실행 중인 자식은 자연스럽게 끝날 때까지 둔다.
- **handoff_requested**: wake 합이 0인 첫 `turn_end`에서 진입하거나(지시가
  steer로 전달되므로 긴 단일 에이전트 실행에서도 다음 턴 전에 도착한다), 자식이
  모두 끝난 뒤 `agent_settled`에서 진입한다. 가드가 하나라서 정확히 한 번만
  주입된다. 사용자 메시지 하나가 주입된다: 새 일을 시작하지 말고,
  `<cwd>/.omo/rollover/handoff-<sessionId>.md`를 쓰고(goal, 완료, 진행 중, 다음
  단계, 핵심 파일, 제약), 응답 끝에 후속 세션의 첫 프롬프트를
  `<successor>...</successor>`로 붙이라는 내용이다. 태그가 없으면 한 번 더
  요청하고, 그래도 없으면 `ctx.ui.notify` 후 armed로 돌아간다. 이 지시는
  일부러 엄격하다(현장 세션 01a09c07은 handoff 자체에 139K→234K 컨텍스트를
  썼다. ledger/plan 파일을 다시 읽고 task를 스폰했기 때문이다): 이미 컨텍스트에
  있는 내용으로 파일을 쓸 것, 어떤 파일도 읽지 말고 어떤 명령도 실행하지 말고
  어떤 task도 스폰하지 말 것, 최대 약 80줄, 섹션은 Goal / Done / In progress /
  Next step / Key files / Constraints, 서버·모니터·백그라운드 셸을 죽이지 말고
  Key files 아래에 `port/PID/command`로 나열해 후속 세션이 재사용하거나 정리할
  수 있게 할 것, `<successor>`는 25줄 이하로 후속 세션이 handoff 파일과
  `tail -n 30 .omo/ulw-execute/ledger.jsonl`만 읽고 `ulw-execute/SKILL.md`나
  전체 ledger는 읽지 말라고 지시할 것. 추출 계약은 바뀌지 않았다.
- **rollover 유예(deferred)**: wake 합이 unknown이거나 > 0일 때(또는
  `hasPendingMessages()`) `<successor>`가 발견되면 `rollover_deferred{total}`을
  기록하고 `handoff_requested`에 머문다. 다시 요청하지 않으며 successor
  프롬프트는 유지된다. 이후 모든 `agent_settled`와 `turn_end`에서 재검사하고
  합이 0이 되면 `/rollover now`를 디스패치한다. 이것이 없으면 `newSession`이
  handoff 턴 중에 스폰된 자식을 고아로 남겼다(현장: task st_01a09c25가 옛
  부모를 가진 채 `running`으로 남음).
- **rollover**: `/rollover now`를 디스패치한다. 핸들러가
  `ctx.newSession({parentSession, withSession})`을 호출하고 새 세션에서
  successor 프롬프트를 보낸다. 핸들러 자체는 wake 합이 > 0이면 거부한다(notify +
  `rollover_refused{total}`). `/rollover now force`는 이를 무시한다. unknown
  합(아직 이벤트 없음)은 수동 명령을 막지 않는다.

omo-task 자식 세션에서는 비활성이다(로깅도 arming도 없음). env
`OMO_SENPI_TASK_RPC_CHILD`(모든 스폰된 자식에 설정됨) 또는
`SENPI_TASK_MEMBER*`로 감지한다.

### 사용하는 신호

| 신호 | 용도 |
|---|---|
| `message_end` (`message.usage`) | 컨텍스트 = `ctx.getContextUsage().tokens`. tokens가 null이면(compaction 직후) `input + cacheRead + cacheWrite`로 대체 |
| `pi.events "wake_source_state"` | 소스별(`senpi-task`, `omo-dag`, senpi 내장) 최신 `activeCount`. 합 0 = 주차된 메인을 깨울 것이 없음. 아직 이벤트가 없으면 unknown이며 0이 아님 |
| `turn_end` | 각 LLM 응답 + 도구 호출 뒤. armed이고 wake 합이 0이면 `sendUserMessage(..., {deliverAs: "steer"})`로 실행 도중에 handoff를 요청 |
| `agent_settled` | 진짜 idle. wake 합과 AND. turn_end 시점에 자식이 아직 실행 중이었다면 여기서 handoff를 확정. `<successor>` 태그도 여기서 추출 |
| `tool_call` | watching이 아닐 때 `task`와 `task_create` 차단 |
| `input` | interactive/rpc 입력에서 사용자 시계를 갱신(확장이 주입한 입력은 제외). idle로 armed된 handoff를 `watching`으로 되돌림(`idle_aborted`, 보관 중이던 successor 폐기, 이 확장이 만든 goal 일시정지 재개) |
| `deps.timer` (60초 간격) | idle 주차 tick. 유효 idle 임계값이 > 0일 때만 생성, `session_shutdown`에서 해제, `session_start`와 `/rollover idle`에서 재설정 |
| `before_agent_start` | 모드가 `off`가 아닌 동안 메인 세션의 모든 턴에서 `event.systemPrompt`에 컨텍스트 예산 블록(아래)을 추가 |

### Goal 일시정지

arming은 senpi 내장 goal을 일시정지해 handoff 응답과 rollover 사이에
goal-continuation이 다시 발화하지 않게 한다(현장: 모든 state 파일이
`goalPaused:false`였고, 일시정지 없이는 continuation이 plan, ledger, 자식
transcript를 다시 읽어 +90K 컨텍스트를 썼다. 세션 01a09c27은 이전 세션의
JSONL을 3번, 자식 transcript 하나를 6번 읽었다). 이전 구현은
`import.meta.resolve("@code-yeongyu/senpi")`를 썼는데 이는
`~/.omo/agent/extensions/`에서 절대 해석되지 않는다(`node_modules`가 없다).
현재 `pauseGoal`은:

1. bare `import("@code-yeongyu/senpi")`를 시도한다. senpi의 확장 로더가 jiti를
   통해 `dist/index.js`로 alias한다. `readGoal`, `updateGoal`, `goalStoreRef`를
   export할 때만 사용한다(senpi 2026.9.13은 하지 않는다. 진입점은 session,
   tools, TUI, CLI 조각을 재export하지만 `core/extensions/builtin/goal`은
   없다);
2. 아니면 `process.argv[1]`에서 senpi의 `dist/`를 유도한다(omo 런처는
   `<senpi>/dist/cli.js`를 스폰하므로 `dirname(argv[1])`이 dist다. 직접
   `node <omo-ai>/bin/omo.js`로 실행하면
   `<omo-ai>/node_modules/@code-yeongyu/senpi/dist`로 매핑되고, 런처가 설정한
   `OMO_BIN`도 같은 루트를 준다). `core/extensions/builtin/goal/{store,store-ref}.js`가
   존재하는지 확인한 뒤 import한다;
3. `goalStoreRef(sessionManager, cwd)`로 goal을 읽고, `active`이면
   `updateGoal(ref, {status: "paused"}, "user")`를 호출한다. `active→paused`
   전이는 source가 `user`일 때만 허용된다;
4. 매번 `goal_pause{ok, method: "main"|"dist"|"none", error?}`를 기록한다.

`ok`가 false이면 handoff 프롬프트에 모델 측 대안이 남는다: `update_goal`을
status `blocked`, reason "session rollover handoff in progress"로 호출하라는
것이다. 거기서 `paused`는 불가능하다(모델용 `update_goal`은
`complete|blocked`만 받는다). `blocked`도 goal-continuation을 멈추고
`blocked→active`는 후속 세션(또는 사용자)이 나중에 취할 수 있는 합법적
전이다. 도구가 `blocked`를 거부할 수도 있으므로(blocker가 몇 goal 턴을
버텨야 한다) 직접 일시정지가 중요한 쪽이다.

idle 주차가 사용자 입력으로 중단되면 `resumeGoal`이 이 확장이 만든
일시정지를 되돌리고(`paused→active`, source `user`)
`goal_resume{ok,method,error?}`를 기록한다. 사용자가 독립적으로 일시정지한
goal은 그대로 둔다.

omo의 kibitzer nudge는 이 확장이 통제하지 않는 별도의 continuation 소스다.
아래 시스템 프롬프트 블록이 그 비용을 제한하는 수단이다.

### 스킬 연속성

현장 결과: `ulw-execute` 세션의 후속 세션이 오케스트레이터가 아닌 일반
에이전트처럼 행동했다. 원인: 시스템 프롬프트에는 스킬 이름/설명만 들어가고,
스킬 본문은 사용자가 호출하거나 모델이 SKILL.md를 읽을 때만 컨텍스트에
들어간다. 우리 kickoff는 스킬을 호출한 적이 없었다. senpi `docs/skills.md`
(2026.9.13, "How Skills Work" / "Skill Invocation", 66-95행):

> 3. When a task matches, the agent uses `read` ... to load the full SKILL.md
> (models don't always do this; use prompting or `/skill:name` to force it)
> ...
> ```
> /skill:brave-search           # Load and execute the skill
> $brave-search                 # Equivalent leading dollar invocation
> ```
> ...
> OmO Desktop skill chips serialize as `$skill:name`. Senpi expands that
> explicit form even when it appears inline. Bare inline dollar text remains
> literal ...
> After resolving the explicit tokens, Senpi removes only those tokens and
> wraps the remaining text once as the user request. Unknown tokens stay
> literal, duplicates are skipped, and at most five distinct skills expand per
> prompt.

토큰 문법(`dist/core/agent-session.js:149-150`):

```js
const LEADING_SKILL_INVOCATION_PATTERN = /^(?:\/skill:([a-zA-Z][a-zA-Z0-9:_-]*)|\$([a-zA-Z][a-zA-Z0-9:_-]*))(?=\s|$)/;
const INLINE_DOLLAR_SKILL_INVOCATION_PATTERN = /(^|\s)\$skill:([a-zA-Z][a-zA-Z0-9:_-]*)(?=\s|$)/g;
```

확장은 메시지를 옵션과 함께 보낼 때만 일어난다.
`dist/core/extensions/types.d.ts:1412-1420`(`withSession` 컨텍스트인
`ReplacedSessionContext`도 같음, 539-542행):

> Set expandPromptTemplates to dispatch extension commands and expand skill
> commands and prompt templates.
> `sendUserMessage(content, options?: { deliverAs?: "steer" | "followUp"; expandPromptTemplates?: boolean }): void;`

확장이 하는 일:

1. **arm 시점에 감지.** `detectActiveSkill(branch, known, cwd)`가 현재
   브랜치의 사용자 메시지를 순서대로 훑어 가장 먼저 나오는 선행
   `/skill:<name>`, `$skill:<name>`, `$<name>`, `/<name>` 토큰을 찾는다(`known`
   = `pi.getCommands()`에서 `source: "skill"`인 이름들. bare `$x` / `/x` 형태는
   `x`가 알려진 스킬일 때만 인정하므로 `/rollover status`나 `$HOME`은 매치되지
   않고 omo의 `/ulw-execute <plan>`은 매치된다). 이미 확장된 호출의 저장 형태
   `<skill-instruction name="<name>"`도 매치한다(senpi는 `/skill:`이나
   `$skill:` 토큰을 스킬 본문으로 바꾼 뒤 메시지를 저장하므로 브랜치에 원래
   토큰이 없다). 그도 아니면 `<cwd>/.omo/boulder.json`의 `active_work_id`가
   truthy이면 `ulw-execute`로 본다. 결과는 `st.activeSkill`(영속)과 로그의
   `active_skill{name, source: "message"|"boulder"}`다.
2. **Handoff 프롬프트.** 활성 스킬이 있으면 프롬프트에 다음을 추가한다:
   `<successor>` 블록은 `` `$skill:<name>` `` 줄로 시작해야 하고(정확한 토큰,
   앞에 아무것도 없이), 그 다음 handoff 지시가 온다. 새 세션은 스킬 이름만
   보기 때문이다.
3. **Kickoff.** `/rollover now`는 successor 프롬프트를
   `{ expandPromptTemplates: true }`로 보내므로 senpi가 선행 토큰을 스킬 본문 +
   `<user-request>`로 확장한다. 추출된 successor에 그 스킬의 선행 호출이 없으면
   `$skill:<name>\n`을 앞에 붙인다(`withSkillToken`). 활성 스킬이 없으면
   프롬프트를 그대로 보내되 옵션은 유지한다(무해: 토큰이 없으면 아무것도
   확장되지 않는다).

한계: 감지는 텍스트 기반이다. omo 자체의 포인터/키워드 메커니즘(`ulw` 매직
워드)으로 로드된 스킬은 위 형태가 없으면 boulder.json으로만 잡히므로
`ulw-execute`에 한한다.

### 컨텍스트 예산 시스템 프롬프트 블록

`CONTEXT_BUDGET_BLOCK`(5줄)은 `before_agent_start`를 통해 메인 세션의 모든
턴의 시스템 프롬프트에 추가된다(자식 세션은 핸들러를 등록하지 않는다.
`/rollover off`가 비활성화한다): 전체 ledger, plan, 이전 세션 JSONL, 자식
transcript를 통째로 읽지 말고 `tail`/`grep`/offset+limit을 쓸 것, 한 파일
범위는 세션당 한 번만 읽을 것, 자식 task는
`task_list`/`task_get`/`task_output`만 쓰고 `running` + residency
`persisted_only`는 죽은 것으로 취급할 것(취소하고 조사하지 말 것), rollover
handoff는 컨텍스트만으로 쓸 것. handoff 프롬프트의 `<successor>` 안내가 다음
세션을 위해 JSONL과 자식 transcript 규칙을 반복한다.


## 설치

```powershell
.\install.ps1        # Windows
```
```sh
sh install.sh        # Git Bash / *nix
```

`extension/rollover.ts`를 `~/.omo/agent/extensions/`로 복사한다. 그 다음 실행
중인 세션에서 `/reload`(또는 재시작). 명령:

- `/rollover` 또는 `/rollover help` – 명령 목록 출력
- `/rollover status` – 상태, 모드, 사유, 컨텍스트/예산(출처), wake 합, 차단 횟수, idle 시계
- `/rollover auto|on|off` – `auto`(기본)는 자율 세션(활성 goal, 또는 `AUTONOMOUS_SKILLS` = ulw-execute, ulw-loop, ultrawork, mass-ulw, hyperplan 중 하나의 스킬)에서만 handoff를 강제하고 그 외에는 예산 도달 시 경고만 한다. `on`은 항상 강제. `off`는 비활성화
- `/rollover now` – 지금 handoff(마지막 응답에 `<successor>` 블록 필요. 자식 실행 중이면 거부)
- `/rollover now force` – 자식이 실행 중이어도 handoff(자식은 고아가 된다)
- `/rollover park` – 수동 idle 방식 handoff: 후속 세션이 보고하고 사용자를 기다린다
- `/rollover limit <K> [save]` – 세션 토큰 예산(천 단위). `save`는 `config.json`에도 기록
- `/rollover idle <minutes>|off` – idle 주차 임계값(분 단위, "Idle 주차" 참고). 인자 없는 `/rollover idle`은 유효값과 시계를 보여준다

## 설정

`~/.omo/rollover/config.json`(로드 시 읽음):

```json
{ "budgetTokens": 150000, "rereadRatioMax": 0, "idleMinutes": 50, "idleMinTokens": 100000, "idleGraceMinutes": 5 }
```

`rereadRatioMax`(opt-in, 기본 off)는 각 assistant 메시지의
`cacheRead / output`을 비교한다. 이를 넘는 메시지가 3번 연속이면 예산 아래여도
handoff를 arm한다. 기본 off인 이유는 도구 루프에서 오발동하기 때문이다: 도구
호출만 내는 턴은 output이 약 50토큰이라 정상적인 72K 컨텍스트 세션이 비율 약
1200으로 읽혀 현장에서 96K에 arm되었다. 양수를 설정하면 다시 켜진다. `0`,
음수, 누락은 off다. 비율은 대시보드를 위해 모든 `message_end`에 여전히
기록된다(`ratio`).
`OMO_ROLLOVER_DIR`이 데이터 디렉터리를 재정의한다(테스트가 사용).

## Idle 주차

60초 타이머(테스트에서는 `deps.timer`로 주입)가 idle 상태의 세션을 주차한다:
`idleMinutes`(기본 50) 동안 사용자 입력 없음, 컨텍스트 >= `idleMinTokens`(기본
100K), `idleGraceMinutes`(기본 5) 동안 활동 없음, 에이전트가 busy 아님, 대기
메시지 없음, 자식 wake 합 0(unknown이면 절대 주차하지 않음). 주차는
`arm(ctx, "idle")` 후 `handoff_requested{at:"idle"}`이고, handoff 프롬프트는
세션이 주차 중이라고 말하며 후속 세션의 kickoff는 "5줄 이하로 보고한 뒤
사용자를 기다려라"로 끝난다. idle로 armed된 상태에서 interactive/rpc 입력이
오면 시도를 `watching`으로 되돌린다(`idle_aborted`): 보관 중이던 successor는
버리고 이 확장이 만든 goal 일시정지는 재개한다(`goal_resume`). 타이핑한
`/rollover` 명령은 input 훅을 우회하지만 사용자 시계는 갱신하므로, 아직
`arm()` 안에 있는 idle 시도는 취소한다(await 이후의 시계 검사). handoff가 이미
요청된 뒤에는 타이핑한 명령이 더 이상 중단시키지 않는다. interactive 입력만
그렇게 한다. idle로 armed된 재시도는 `enabled()`와 `ctx.isIdle()`도 재확인하므로
`/rollover off`나 busy 런타임이 전송을 취소한다.
`/rollover idle <minutes>|off`는 세션 재정의를 설정한다. `/rollover park`는
같은 경로를 수동으로 트리거한다. idle 시계는 메모리에만 있다. reload나
resume이 초기화하므로 복원된 세션이 즉시 주차되는 일은 없다.

## 이벤트 로그

`~/.omo/rollover/sessions/<sessionId>.jsonl`, 한 줄에 객체 하나:
`{t, session, cwd, ev, ...}`. `ev` ∈ `session_start{parent?}`,
`message_end{input,output,cacheRead,cacheWrite,context,ratio}`,
`wake_source_state{source,activeCount,total}`, `turn_end{total}`(armed일 때만),
`agent_settled{total}`, `armed{reason,context}`, `active_skill{name,source}`, `goal_pause{ok,method,error?}`, `tool_call_blocked{tool}`,
`command{verb}`, `user_input{source,streaming}`, `budget_notice{reason,context,budget}`(UI 알림과 함께 throttle됨),
`autonomy{autonomous,skill,goal}`(평가할 때마다 기록), `goal_resume{ok,method,error?}`(idle 중단이 자체 일시정지를 되돌림),
`idle_park{sinceUserMin,sinceActivityMin,context,childWake}`, `idle_skip{why,sinceUserMin,sinceActivityMin,context,childWake}`(조치 가능한 why만, 변경당 한 번), `idle_aborted`,
`handoff_requested{at: "turn_end" | "agent_settled" | "idle", context}`,
`successor_found|successor_missing`, `rollover_deferred{total,wake,reason?}`, `rollover_refused{total}`,
`state_restored{state}`, `rollover{newSession,parentSession}`.
`~/.omo/rollover/summary.jsonl`에는 rollover와 세션 종료마다 한 줄이 추가된다
(최대 컨텍스트, 메시지 수, cacheRead/output 비율, 차단 횟수, rollover 횟수,
`armReason`).

## 상태 영속화

상태 머신은 모든 전이(arm, handoff 요청, successor 발견, 재요청, 스폰 차단,
`/rollover on|off`, rollover)마다 `~/.omo/rollover/state/<sessionId>.json`에
원자적으로(tmp + rename) 기록된다. 필드:
`state, mode, blocked, rereadStreak, goalPaused, rollovers, armedAt,
handoffAskedCount, peak, messages, cacheRead, output, startedAt, activeSkill, reason, budgetOverride, idleOverride, lastNoticeContext, updatedAt`.
arm 시점의 `autonomous` 판정과 메모리상의 idle 시계는 의도적으로 영속화하지
않는다. 카운터는 모든 `message_end`에서도 기록되어 summary 행(최대 컨텍스트,
메시지 수, 비율)이 `/reload`를 견딘다. 실시간 `context`는 저장하지 않고 다음
`message_end`에서 다시 계산한다. `session_start`(어떤 사유든)는 자기 세션 id의
파일을 복원하고 `state_restored{state}`를 기록한다. 복원된 상태가
`handoff_requested`(또는 `rollover`)이면 현재 브랜치에서 즉시 `<successor>`를
확인하고 `/rollover`를 디스패치한다(또는 유예: reload 직후에는 omo-task가 다시
emit할 때까지 wake 합이 unknown이므로 보통 다음 `agent_settled`에서
디스패치된다). 따라서 모델 응답과 `agent_settled` 사이에 `/reload`가 끼어도
handoff가 완료된다. rollover 뒤 옛 세션의 파일은 `state: "rolled_over"`로
남는다. 그 세션을 resume하면 새로 시작하고, 후속 세션은 자기 id를 가진다.

## 대시보드

```sh
node dashboard/build.mjs            # ~/.omo/rollover (또는 $OMO_ROLLOVER_DIR, 또는 디렉터리 인자)를 읽음
node dashboard/build.mjs --sample   # dashboard/sample/의 합성 데이터
```

데이터를 내장한 `dashboard/out/index.html`을 쓴다(파일을 열면 되고 서버는
없다). 세션 체인별 타임라인(컨텍스트 영역 + 예산선, 메인 턴, handoff 턴, 차단
마커, armed/rollover 마커, wake 소스 레인, 세션 경계)과 추세 표. 라이트/다크
테마. 유일한 외부 자산은 Google Fonts. 샘플 재생성은
`node dashboard/sample/generate.mjs`.

## 테스트

```sh
node --test
```

Node ≥ 22.6(여기서는 24 사용): 테스트는 `.mjs`이고 Node 내장 type stripping으로
`extension/rollover.ts`를 직접 import한다. 가짜 `pi`/`ctx`가 상태 머신을
구동한다. senpi도 LLM 호출도 없다.

## 한계

- 유료 라이브 세션에서 절대 실행하지 말 것. senpi의 `types.d.ts` /
  `docs/extensions.md`(2026.9.x)와 가짜 하네스로만 검증했다.
- Goal 일시정지는 senpi 내부 `dist/core/extensions/builtin/goal/` 레이아웃과
  `process.argv[1]` / `OMO_BIN`이 omo-ai 설치를 가리키는 데 의존한다("Goal
  일시정지" 참고). 두 경로 모두 해석되지 않으면 `goal_pause{ok:false}`가
  기록되고 handoff 프롬프트는 `update_goal` status `blocked`로 대체한다.
- 컨텍스트 예산 블록은 시스템 프롬프트의 조언이지 강제가 아니다. kibitzer
  nudge와 다른 omo continuation 소스는 이 확장 밖이다.
- wake 소스 합은 공유 버스를 신뢰한다. 소스가 하나라도 emit하기 전까지 합은
  unknown(0이 아님)이고 armed 세션은 확정되지 않는다. omo-task는 세션 시작 시
  `senpi-task`를 emit하므로 실제로는 시작 시점에 해결된다. 끝내 해결되지 않으면
  `/rollover now`가 여전히 수동으로 동작한다.
- 이전에는 `/reload`(같은 세션 id, 새 확장 인스턴스)가 상태를 `watching`으로
  초기화해 armed나 대기 중인 handoff를 잃었다. 위의 상태 영속화가 이를
  해결한다. reason이 `reload`인 `session_shutdown`은 여전히 summary 줄을
  건너뛴다.
- `/rollover now`는 `pi.sendUserMessage("/rollover now", {expandPromptTemplates: true})`가
  등록된 확장 명령을 디스패치하는 데 의존한다.
- `turn_end` 확정은 에이전트가 스트리밍 중일 때 senpi가 `deliverAs: "steer"`를
  존중하는 데 의존한다. steer 전달이 지연되어도 handoff는 늦어도 다음 모델 호출
  전에 도착한다. 자식이 실행 중일 때는 `agent_settled`가 대안으로 남는다. 한 턴
  자체가 매우 길게 실행되는 경우(거대한 도구 호출 하나)는 중단되지 않는다.
- Idle 주차 주의점: 다른 확장의 타이핑된 `/command`는 idle 시계를 초기화하지
  않는다(interactive/rpc `input`만 한다). 시계는 `/reload`와 `--resume`에서
  초기화되므로 복원된 세션이 즉시 주차되는 일은 없다. 아직 unknown인 wake 합은
  주차를 완전히 막는다. 타이머는 프롬프트 캐시 TTL이 아니라 벽시계 idle을
  기준으로 유예한다. 캐시가 따뜻하다고 주차된 세션이 살아 있지는 않다.
