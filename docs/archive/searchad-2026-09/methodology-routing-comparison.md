**SearchAd 개발 방식·모델 라우팅·지연 비교 — 2026-09-14**

**판단: 현재 구성 그대로 Stage 전체에 ulw-execute를 계속 적용하는 것은 권하지 않는다.** 필요한 병렬화가 실제로 실행되지 않았고, 제품 요구에 비해 확장된 설계를 중간에 재판단하지 못했으며, 재개·도구 장애가 산출물 저장까지 막았다. 다만 예전 방식에도 긴 컨텍스트와 한도 소진 문제가 있었으므로 설정을 통째로 원복하면 해결된다고 볼 수는 없다.

분석 대상은 SearchAd OMO 메인 JSONL 17개를 통한 세션 식별과 그중 개발·계획 관련 7개 세션의 상세 집계다. 실제 provider/model 기록, child completion의 category/agent_type/resolved_model/run_stats, 최초 지시와 자동 continuation, 계획 및 과거 설정 백업을 확인했다. 현재 설정으로 과거 라우팅을 추정하지 않았다. 이 문서는 제품 코드를 재검증한 결과가 아니다.

집계 재현: [분석 스크립트](C:/dev/searchad/.omo/analysis/compare_session_routing.py), [모델·역할·작업별 원자료](C:/dev/searchad/.omo/analysis/session-routing-metrics.json).

**1. 실제 전환 순서**

| 시기/대상 | 메인 | 자식 모델·역할 | 적용 방식 |
|---|---|---|---|
| Stage 4 마무리–Stage 8 중심 장기 세션 `01a07cf9` | 주로 Codex Sol, 일부 Astra·Opus·Copilot Sol로 변경 | `deep` Opus 5 high가 구현·조사·리뷰 다수, `quick` Luna/Haiku, 일부 visual/writing 모델 | 사용자 정의 오케스트레이션 지시. 최초에는 Codex 리뷰 1회만, 이후 Opus 리뷰로 지시 |
| Stage 8 마무리–Stage 9 `01a08c36` | Copilot Sol → Codex Sol | `deep` Opus high 구현, `quick` Haiku 탐색, `unspecified-high`/code-reviewer Opus, 후반 GPT 계열 작업 및 Astra gate | `searchad-sdlc-orchestrator`를 명시적으로 로드. ulw-plan/execute 전환 전 |
| Stage 10 `01a091fa` | Codex Sol 단독 | task dispatch 없음 | context files/skills/nested agents/memory/fallback 없이 실행하라는 명시 요청. 메인이 직접 구현·검증 |
| Stage 11 계획 `01a0926e` | Codex Sol high | explore Luna-fast, ultrabrain Astra, plan-consultant/reviewer Astra. architect Fable와 consultant SWE-2 실패도 있음 | ulw-plan 명시 실행 |
| Stage 11 첫 실행 `01a092d1` | Codex Sol high | Todo 1–6 주로 `deep` Astra high 구현, gate-reviewer Astra. 후반 Sol 대체 구현, Opus implementer 1회는 인증 차단 | ulw-execute |
| Stage 11 후속 `01a09678`, `01a09716` | Codex Sol high | `implementer` Opus high 구현, Astra/Sol gate, Sol code-reviewer, Luna 보조 | ulw-execute |

따라서 “Stage 8 정도부터 ULW로 바꿨다”는 기억은 남아 있는 이 로그와 다르다. 명확히 확인되는 전환은 Stage 11이다. Stage 8·9에도 OMO 도구는 사용했지만 개발 절차는 사용자 정의 skill이었다. OMO 하네스를 사용한다는 사실과 ULW 개발 workflow를 사용한다는 사실을 구분해야 한다.

구독 등급은 메시지와 과거 문서의 사용자 진술로만 확인된다. 세션별 실제 플랜 잔량·한도 차감은 이 telemetry로 재구성할 수 없다.

근거: [자체 방식 시작 지시](C:/Users/yjack/.omo/agent/sessions/--C--dev-searchad--/2026-09-07T17-45-48-880Z_01a07cf9-ec50-746c-a881-ebbe090aab2b.jsonl:12), [Stage 8/9 자체 skill](C:/Users/yjack/.omo/agent/sessions/--C--dev-searchad--/2026-09-10T16-46-13-387Z_01a08c36-718b-71f7-8dfb-3b9c358c1aee.jsonl:8).

**2. category를 유지해도 모델과 역할은 바뀌었다**

바닐라 전환 전 백업의 `deep.models[0]`은 `claude-sdk-oauth/claude-opus-5:high`였다. 초기 Stage 11에서는 같은 `deep` 요청이 `openai-codex/gpt-6-astra`로 실행됐다. 구현자 모델까지 바뀐 실험이었다.

최종 문제 세션의 정확한 역할 구분:

| 역할/카테고리 | 실제 모델 | 실행 횟수 | 맡은 일 |
|---|---|---:|---|
| 메인 | Codex Sol high | 응답 193개 | 계획·ledger·dispatch·결과 판정·재개 |
| implementer | Claude Opus 5 high | 12 | Todo 7/8/9 구현·수정·테스트·자체 QA |
| omo-senpi-gate-reviewer | Codex Astra high | 6 | 독립 동작 검증과 adversarial 재현 |
| omo-senpi-gate-reviewer | Codex Sol | 1 | Todo 8 Fix1 독립 검증 |
| omo-senpi-code-reviewer | Codex Sol high | 2 | Todo 8 Fix2/Fix3 코드·테스트 품질 리뷰 |
| explore | Codex Luna-fast low | 1 | 중단된 변경 상태 조사 |
| quick | Codex Luna-fast low | 2 | ledger 기록 |
| writing | Claude Fable medium | 1 | handoff 작성 시도, 인증 차단 |
| unspecified-high | Codex Sol high | 1 | 대체 handoff 작성, patch 도구 부재로 산출물 실패 |

여기서 26회는 실행 횟수이고 고유 task ID는 24개다. 같은 구현자 두 명을 각각 한 번 재개했다. usage-stats의 `agent:agent`는 실제 gate-reviewer/code-reviewer/explore 역할을 가리는 집계 라벨이며, 모두 같은 역할이었다는 뜻이 아니다.

Stage 8/9 후반 completion 20회는 `model: default`, `agent_type: task`로 남아 정확한 모델이 해당 배너에서 누락돼 있다. 입력·캐시 필드만 보고 모델명을 임의 확정하지 않았다. 같은 세션의 초기 13개 child만 집계했던 기존 9월 11일 usage 문서는 중간 snapshot이므로 전체 Stage 9가 Claude-only였다는 근거로 사용할 수 없다.

근거: [전환 전 라우팅 백업](C:/Users/yjack/.omo/omo.jsonc.backup-20260911-vanilla), [최종 세션 상세 집계](C:/dev/searchad/.omo/analysis/session-routing-metrics.json).

**3. 최대 병렬화를 원했지만 실제로는 독립 작업도 직렬화됐다**

Stage 11 계획은 Wave 1의 Todo 1–3을 독립 병렬 작업으로 정의했고 메인도 첫 설명에서 그렇게 선언했다. 실제 dispatch는 다음과 같다(UTC, 모두 2026-09-12에 걸친 구간).

| 작업 | 시작 |
|---|---|
| Todo 1 구현 | 09-11 23:38:17 |
| Todo 1 독립 검증 | 09-11 23:56:22 |
| LSP 복구 | 09-12 00:05:48부터 여러 재개 |
| Todo 2 구현 | 09-12 00:24:56 |
| Todo 3 구현 | 09-12 00:49:55 |
| Wave 1 완료 후 Todo 4 시작 | 09-12 01:18:26 |

Todo 1 대기 중 Todo 2·3을 시작하지 않았다. 명시된 병렬 wave가 약 100분의 직렬 구현→검증 흐름으로 실행됐다. Wave 2의 Todo 4·5·6도 차례대로 시작했다. 반면 마지막 세션의 Todo 8·9는 실제로 같은 시각에 병렬 dispatch됐다. 병렬 기능이 전혀 없었던 것이 아니라 계획대로 지속적으로 적용되지 않은 것이다.

자동 continuation은 반복해서 “FIRST unchecked checkbox”를 고르라고 지시했고, 메인은 실행 중인 첫 task를 “sole live dependency”라고 반복 서술했다. 최대 병렬화 지시와 충돌하는 실행 유도다. 내부 모델 인과를 단정할 수는 없지만, 계획의 dependency-ready 집합 대신 첫 미완료 항목에 묶인 행동은 직접 확인된다.

근거: [병렬화 선언](C:/Users/yjack/.omo/agent/sessions/--C--dev-searchad--/2026-09-11T23-33-27-559Z_01a092d1-a386-7081-b4b9-871c57f81082.jsonl:30), [Todo 1 dispatch](C:/Users/yjack/.omo/agent/sessions/--C--dev-searchad--/2026-09-11T23-33-27-559Z_01a092d1-a386-7081-b4b9-871c57f81082.jsonl:49), [Todo 2 dispatch](C:/Users/yjack/.omo/agent/sessions/--C--dev-searchad--/2026-09-11T23-33-27-559Z_01a092d1-a386-7081-b4b9-871c57f81082.jsonl:222).

**4. 느린 모델 응답과 불필요하게 긴 작업을 구분해야 한다**

| 비교 구간 | 하네스 child 통계의 관측치 |
|---|---|
| Stage 11 첫 실행, deep Astra | 알려진 run 합계 170.2분 중 generation_ms 합계 159.7분, 기록상 출력 약 29.1 tokens/s |
| Stage 11 첫 실행, Astra gate | 91.0분 중 87.5분, 약 31.5 tokens/s |
| 마지막 세션, Astra gate 6회 | 93.8분 중 88.7분, 약 29.3 tokens/s |
| 마지막 세션, Opus implementer 12회 | run 합계 307.9분 중 generation_ms 85.9분. 나머지 시간은 도구·실행·대기 등을 포함 |

Astra 작업의 실제 완료를 기다리는 시간이 상당했던 것은 맞다. 그러나 초기와 마지막 모두 약 29–32로 비슷해 이 기록에서 “출시 부하로 갑자기 TPS가 붕괴했다”는 패턴을 찾지는 못했다. 낮은 속도가 평소 성능인지 부하인지 구분할 동일 작업·동일 추론·동일 컨텍스트의 대조 실험도 없다.

메인의 성공 응답 완료 지연 중앙값은 Stage 8/9 Codex Sol 약 14.3초, Stage 11 첫 실행 7.9초, 마지막 11.2초였다. 이는 `message.timestamp`에서 JSONL 기록 시각까지의 관측 지연이며 요청 복잡도와 컨텍스트가 다르다. 성능 벤치마크는 아니지만 메인 전체가 일관되게 더 느려졌다는 설명을 뒷받침하지 않는다.

`generation_ms`/TPS는 하네스의 메시지 이벤트 기반 계측이다. 순수 GPU decode 속도나 TTFT, 서버 큐 대기를 분리한 값이 아니다. Claude 작업에서는 수백 TPS 또는 오류 직전 729 TPS처럼 표시되며 provider별 이벤트·usage 의미 차이를 배제할 수 없다. 이를 근거로 “Opus가 Astra보다 정확히 N배 빠르다”고 계산해서는 안 된다. 외부 서비스 장애나 출시 부하를 확인한 결과도 아니다.

**avg-time 집계에도 주의점이 있다.** 마지막 usage snapshot의 Opus runtime은 394.4분/12회=32.9분이지만, completion의 개별 `run_stats.runtime_ms` 합계는 307.9분/12회=25.7분이다. 재개된 task의 `duration_ms`가 최초 시작부터의 수명을 포함하기 때문이다. 예를 들어 Fix7 실행 자체는 17.2분인데 completion duration은 63.8분으로, 앞선 실행과 리뷰 대기를 다시 포함한다. 토큰 합계는 원본과 일치하지만 avg-time은 순수 작업 시간으로 해석하면 과대평가된다.

**5. 확실히 불필요했던 지연과 장애**

- 첫 실행 Todo 1은 focused pytest 105개, Ruff·format·type 검사는 통과했는데 LSP daemon이 닿지 않아 완료가 막혔다. 별도 복구 worker를 여러 번 재개했다. 개발 환경 복구가 제품의 다음 독립 기능을 막는 직렬 의존성이 됐다.
- 첫 실행 Todo 6에는 기존 시각 QA와 별개로 dual-oracle 시각 리뷰들이 붙었고, 보안 수정 후 3상태·50개 캡처를 다시 생성·재리뷰했다. 자식이 사라져 시각 리뷰를 다시 시작한 사례도 있다.
- 첫 실행에서 Codex usage-limit 오류 1건과, 프로세스 재시작 후 `in-process task from a previous process cannot be reattached`라는 lost 통지 4건이 있다. 이 lost 통지들은 일부 이미 끝난 실행을 가진 동일 task의 후속 상태이므로 4개 전체 작업의 모든 결과가 유실됐다는 뜻은 아니다. 재연결과 재검증에는 실제 비용이 들었다.
- 마지막 세션은 공급자 실패 5건, 잘못된 reset 시각으로 재시도, 같은 차단 공급자의 writer 재사용, tool registered/inactive 불일치, handoff 저장 실패가 있었다.
- Todo 7/8의 파일시스템·DB 보장 범위 확대와 7회 리뷰 반려는 모델 응답을 빠르게 해도 없어지지 않는 재작업이다.

**6. 이전 자체 방식과 비교해 잃은 통제 장치가 있다**

| 이전 명시 지시 | ULW 세션의 실제 행동 |
|---|---|
| 한 자식 한 결과물, 15분 이상이면 범위 재검토 | Opus Fix3 단독 52분·124턴·190 tool calls |
| 리뷰 수정 최대 2회 후 판단 이관 | Todo 7 Fix7, Todo 8 Fix4까지 같은 큰 작업 안에서 반복 |
| 같은 실패 두 번이면 중단·handoff | 장애·도구 문제 후에도 자동 continuation과 재개 시도, 마지막 handoff 저장 실패 |
| root가 통합·실제 QA 소유 | 제품 편집·테스트·QA 전부 위임하는 절대 규칙 |
| 검증된 증분마다 커밋·짧은 복구 경계 | Stage 11 전체 최종 단일 커밋. 누적 변경과 hash/evidence로 매번 상태 복구 |
| issue+diff 중심 리뷰, 필요한 경우 병렬화 | skill·계획·누적 증거와 광범위 adversarial 검증 반복 |

이전 지시를 그대로 정답으로 삼으면 안 된다. 예를 들어 reviewer에게 spec을 항상 금지하면 오히려 이번처럼 제품 요구 적합성을 놓칠 수 있다. 15분도 강제 종료 타이머보다 재분할 판단 기준이어야 한다. 고쳐 쓸 부분은 짧은 작업·실패 시 재판단·명확한 복구 경계다.

또한 이전 자체 방식의 Stage 8/9 장기 세션에도 goal-continuation 114회와 메인 약 2.27억 누적 토큰이 있었다. 이는 하루 가까운 여러 활동을 포함한 전체 세션 수치이며 마지막 Stage 11 세션과 작업량이 같지 않다. 구 방식에도 같은 하네스의 과도한 반복 호출과 긴 컨텍스트 문제가 존재했다. 단순한 바닐라 대 커스텀 비교로 인과를 확정할 수 없다.

**7. 권장 운영 방식**

1. ulw-execute의 stage 전체 무기한 실행은 당분간 쓰지 않는다. 먼저 현재 계획의 제품 요구 적합성을 검토하고 실제 사용할 수 있는 작은 기능 단위로 완료 경계를 바꾼다.
2. 메인이 제품 목표·단순한 설계·작업 범위·통합·종료를 책임진다. 단순 수정과 상태 저장까지 무조건 위임하지 않는다.
3. 기존에 사용한 모델로 구현자와 독립 리뷰어를 명시하고, category 문자열에 따른 암묵적 모델 변경을 피한다. 시작 전에 resolved provider/model/effort를 기록한다. 고성능 모델은 중요한 설계·금전·데이터 무결성 판단에 집중한다.
4. 병렬화는 독립 산출물 2–3개로 시작한다. 첫 작업이 끝나기 전에 나머지 dependency-ready 작업이 실제로 시작됐는지 확인한다. 공유 파일·공유 DB 수정은 소유권 또는 통합 순서를 정한다.
5. 리뷰는 원래 요구와 짧은 설계 이유, 변경 diff, 핵심 회귀 증거를 받는다. 데이터 손상·광고비 안전 문제와 선택적 강화·미지원 환경·스타일을 분리한다. 두 번 반려되면 승인 기준을 낮추는 대신 공통 원인과 설계를 재검토한다.
6. 검증은 변경 관련 테스트부터 시작하고, 변경이 안정된 시점에 통합 gate를 실행한다. 같은 최종 bytes를 여러 reviewer가 독립적으로 전부 재실행해야 하는 항목은 위험에 근거해 제한한다. LSP 장애는 정상 작동하는 CLI type checker와 별도 환경 문제로 판단한다.
7. provider rate-limit/auth와 도구 장애는 개발 결함으로 취급하지 않고 구조화된 복구 정책을 적용한다. 종료·handoff는 막힌 구현 provider에 의존하지 않아야 한다.
8. 비교 실험은 모델/effort를 고정하고 작은 기능 하나로 한다. 비교 지표는 실행 시간, 수동 개입, 핵심 시나리오 통과, 반려·재작업, 새 입력과 cache read, 산출물 저장 성공이다. total tokens/TPS 하나로 개발 효율을 판단하지 않는다.

ulw-plan도 자동으로 좋은 계획을 보장하지 않는다. 계획 리뷰에서 “이 계획을 정확히 실행할 수 있는가”에 앞서 “요구를 만족하는 더 작은 설계가 있는가”를 검사해야 한다. 이번 Stage 11은 그 판단이 부족한 채 정밀한 실행·검증만 계속됐다는 것이 핵심이다.

이 분석에서는 모델 설정·skill·workflow·제품 파일을 변경하지 않았다. 분석용 script/metrics/report만 `.omo/analysis/`에 추가했다.
