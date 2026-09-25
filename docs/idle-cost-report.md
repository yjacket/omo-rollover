# Idle 비용 정책 v2: 최종 보고 (실측 1회 포함)

**결론 한 문장:** 원시 usage 재집계, 비용·시간 모델 보완, 기록 전용 shadow 연동,
서명된 승인 파일 아래의 무인 실측 1회(runId `20260925-161302`, 유료 호출 22건, 세 meter
모두 상한 안)와 그 분석·보고까지 완료했지만, 실측은 다섯 실험 중 네 개가 중단되고
하나가 오염돼 계수를 하나도 식별하지 못했고, 엔진의 정책 답은 `NO_DECISION`이며,
실제 운영 정책은 바뀌지 않았다(`idleCostMode` 기본 `off`, `enforce` 없음, 설치·배포·재시작
없음, `/rollover` 설정 변경 없음, master 미병합).

목표는 같은 작업을 제대로 완료한다는 조건에서 유휴 시작부터 작업 완료까지의 총 quota
낭비를 줄이는 것이다. 비용에는 데우기, 부모 handoff 생성, 후속 복원, 복귀 후 본 작업이
들어가고, 돌아오지 않은 작업에서 이미 발생한 비용도 포함한다. 품질 손실과 복귀 지연은
비용과 합산하지 않는 별도 승인 조건이다. 이 문서는 어떤 절감도 주장하지 않는다.

## 작업 상태

| 작업 | 상태(완료/부분/차단) | 근거 파일·명령·결과 | 남은 조건 |
|---|---|---|---|
| 계수·복원 집계 | 부분 | 09-19 캡처: `scripts/quota-analysis.mjs`, [idle-cost-evidence.md](idle-cost-evidence.md)/`.json`. 09-26 실측: `scripts/idle-live-analyze.mjs`, [idle-live-results.md](idle-live-results.md)/`.json`, 독립 재계산 `verify.mjs` 257 MATCH. 세 meter 계수 레코드 3건 추가, 전부 `sourceKind: unknown`, 계수 필드 전부 `null` | 깨끗한 창에서 식별된 계수 없음. Fable 쓰기 tick(H6/H8), `k_out`, 복원 `Rw`/`Rr` 모두 미측정. 아래 "다음에 승인받아야 할 실행" |
| 비용·시간 모델 보완 | 완료 | `extension/rollover.ts`의 `idle-cost-engine/1.0.0`(`convertUsage`, `cacheStateAtArrival`, `planIdle`, `evaluateIdleCost`), `test/idle-cost.test.mjs`. 수학 fixture(AGENT_TASK 8절) 재현: PARK 27,350 / WARM→EXPIRE 24,075 / K=126,375 변형 21,712.5 | 실측 계수와 보정된 복귀 예측이 없어 엔진에 넣을 값이 없음 |
| shadow 연동 | 완료(기록 전용) | `idleCostMode: "shadow"`, `idle_cost_shadow`/`idle_shadow_error` 이벤트, `test/idle-shadow.test.mjs`, `scripts/idle-replay.mjs` | 호스트가 `observeTaskEnd`를 자동 호출하지 않음. 검증된 prefix 근거 공급자 없음 |
| 회귀·독립 검증 | 완료(이 worktree 기준) | `npm test`(`node --test "test/*.mjs"`) exit 0. todo-9 게이트: fresh checkout에서 분석기가 `docs/idle-live-results.json`을 바이트 단위로 재현, `verify.mjs` 257 MATCH / 0 MISMATCH, D1 독립 재도출 일치. todo 12(smoke resume 전면 거부: "count idle-live smoke paid requests and refuse to resume a smoke", "refuse every idle-live smoke resume before side effects and pin the late-dial paid count", "report folded counts on idle-live smoke resume refusals and make the runner smoke tests self-contained"), todo 13(헤더 지연 귀속과 settle point: "attribute idle-live gauge ticks under header lag and stop after a fallback miss", "settle the idle-live meter before run end", "include settle charges in idle-live per-experiment spend"), todo 14(분석기 라벨 정합: "align idle-live policy notes and ttl labels with their status"), todo 15(fallback-miss 설명과 settle 창 분리, 프로토콜 사유 코드 설명, 보고서 정합: "explain idle-live fallback-miss aborts and keep settle pings out of experiment windows", "update idle-cost report status, N10 notes and the live results doc for todo 15", "explain every idle-live protocol abort reason and correct the report status and approval list") - 모두 wt/idle-experiments-live-run-w2에 커밋 SUBJECT로 반영됐다(해시는 랜딩마다 바뀌므로 적지 않는다) | 최종 F1-F4 게이트 미실행 |
| 실제 실험·배포 | 실험 실행됨(별도 서명 파일 아래), 배포 안 함 | 승인: `docs/idle-experiments-approval-2026-09-23.json`(제안 JSON과 별개, `scripts/idle-live/approval.mjs`가 검증). 실행: `scripts/idle-live-runner.mjs`, 2026-09-26 01:13-03:14 KST, detached launcher로 무인 실행, exit 3, 유료 22건. 결과: 실험 4개 aborted, 1개 contaminated, 계수 0개 | enforce 조건 미충족(`minimumEvidenceForEnforcement` 어느 실험도 못 채움). 재실행은 아래 승인 항목 |

AGENT_TASK 8절의 구분을 그대로 적용한다. **이번 작업 완료**에 해당하는 것은 raw 분석,
모델 수정, 로컬 테스트, shadow, 실험 계획·runner·분석기, 실측 1회와 미확정 목록이다.
**배포 준비 완료가 아니다.** 총 quota 절감, 실제 업무 품질, 허용 지연, 계수와 TTL의
충분한 근거는 이번 실측으로도 확보되지 않았다.

## 수치로 확인된 결과

### 실측 실행 자체 (runId `20260925-161302`)

- 시간: UTC 2026-09-25 16:13:02-18:14:37, KST 2026-09-26 01:13-03:14. 모델
  `claude-fable-5-1`, CLI 2.1.278, 1h TTL lane만. detached launcher가 무인으로 실행했고
  그동안 세션은 호출을 내지 않았다.
- 종료: exit 3(상한/중단 사유로 캠페인 종료), 유료 호출 22건. `requests.jsonl` 22행,
  `events.jsonl` 62행(sha는 [idle-live-results.md](idle-live-results.md) 머리에 있다).
- 지출(meter별, 한 리셋 창 안, 게이지 관측치). 상한은 승인 파일의 누적 상한이다.

| meter | 시작 -> 끝 | 관측 | 상한값(+0.01 양자화) | 누적 상한 |
|---|---|---|---|---|
| `unified-5h` | 0.00 -> 0.16 | 0.16 | 0.17 | 0.53 |
| `unified-7d` | 0.01 -> 0.03 | 0.02 | 0.03 | 0.12 |
| `unified-7d_oi` | 0.00 -> 0.04 | 0.04 | 0.05 | 0.12 |

  lag 1 모델(아래)에서는 마지막 호출의 비용이 아직 안 보였을 수 있어 각 상한값이 최대
  +0.01이다. 그래도 모두 한도 안이다. meter 총합만 귀속과 무관하고, 실험별 5h 지출은
  러너의 lag 0 귀속에 기대므로 이 표에 싣지 않는다.

- 원시 토큰 합계(22건): input 44, cacheRead 447,581, cacheWrite1h 1,367,023, cacheWrite5m 0,
  output 14,398. 그룹별 표는 [idle-cost-evidence.md](idle-cost-evidence.md)의
  "2026-09-26 live run" 절에 있다.

### 실험별 판정

| 실험 | 판정 | 뜻 |
|---|---|---|
| `fable-write-tick` | aborted (`cap_exceeded`) | 유일한 호출(DIAL 읽기, cache_read 146,397, 쓰기 0)에서 헤더가 +2 tick 움직였고 러너가 그 2 tick을 이 블록에 청구해 다음 WRITE-2400을 거부했다. D1에서 lag 0이 기각되므로 이 2 tick은 직전 restore 호출의 몫으로 보는 것이 데이터와 맞다. 러너 귀속 결함(todo 13) |
| `output-quota` | aborted (`short_output`) | OUT-8K 프롬프트가 출력 5,106 토큰(thinking 104, `end_turn`)을 냈고 게이트 기준 6,000 미만. CLI가 자른 것이 아니다. 이 프롬프트 형태는 한 번도 측정된 적이 없었다 |
| `ttl-1h-unique-prefix` | contaminated (`anomalies_present`) | 첫 쓰기 호출에 `gauge_moved_without_own_call`(59.6K 쓰기에 +2 tick). lag 1에서는 직전 실험(restore run 2)의 지연 tick이다. 기계는 `valid`로 닫았지만 분석기의 더 엄격한 판정이 우선한다(todo-8 게이트 Q3 규정) |
| `restore-decomposition` (run 1, 2) | aborted (`big_context_rewrite`) | `--resume` 재생의 첫 턴이 바이트가 달라 전체 재쓰기(read 3,035 / 1h write 143,423). rf-emulation 폴백은 같은 텍스트 블록 안에 접미사를 붙여 캐시 경계가 안 맞고 역시 재쓰기(143.4K-143.5K). 정확히 어느 바이트가 다른지는 모른다(요청 본문 미캡처) |
| `policy-effect` | aborted (`big_context_rewrite`) | 위와 같은 원인. 첫 쌍의 park_parent에서 중단 |

### TTL 갱신: 오염 상태 아래의 사용량 기반 결과

게이지가 아니라 usage 필드로 읽은 결과다. 두 run 모두 일정 ±90 s를 지켰다.

| run | 1h 쓰기 | 55분 읽기(처치) | 110분 검사 |
|---|---|---|---|
| 1 | A 59,602 / B 59,703 | A HIT (read 62,637) | A HIT (read 62,637, write 0); B MISS (59,703 재쓰기) |
| 2 | C 59,627 / D 59,723 | C HIT (read 62,662) | C HIT (read 62,662, write 0); D MISS (59,723 재쓰기) |

분석기 결론은 `renews_at_55min`(55분 읽기가 1h 수명을 갱신), n=2. 그러나 창이 오염돼
`measured`로 세지 않는다. 승격하려면 Appendix B 개정과 테스트가 필요하고, 계획에 없다.

### 게이지 헤더 지연 (D1)

헤더가 floor(누적/0.01)이고 사용량에 선형이라는 가정 아래 호출 단위 지연 L=0,1,2를 검사했다.

- lag 0과 lag 2는 데이터와 모순된다. 직접 반례: `restore-decomposition/shared/0`이
  1h 143,362를 썼는데 자기 헤더는 0.00 그대로였고 다음 호출에서 0.02가 됐다.
- lag 1은 1h 쓰기 T가 0.01당 80.5K-89.5K 토큰이고 출력 가중이 쓰기의 1.55배 이상일
  때만 맞는다. 이 T는 사전 범위 102K-143K보다 낮고 09-19 H8 구간(79.3K-102K) 안이다.
- 지연이 호출 단위인지 시간 정산인지는 밝히지 못했다. 그래서 T는 `unknown`이고 측정으로
  기록하지 않는다.
- lag 1을 채택하면 바뀌는 것: fable의 `cap_exceeded`는 발생하지 않았을 것이고(투영
  0+1 ≤ 2 tick), TTL 오염은 restore run 2로 옮겨가며, meter 상한값은 각각 최대 +0.01.
  바뀌지 않는 것: output/restore/policy 중단, TTL HIT/MISS, 정책 답.

### 정책 답 (범위 양 끝)

엔진(`evaluateIdleCost`)의 답은 **`NO_DECISION`** (`evidence_incomplete`)이다.
`KEEP_WARM`, `PARK`, `LET_EXPIRE` 중 어느 것도 고를 수 없었다. restore-decomposition과
policy-effect가 중단돼 phase 비용 모델이 없고, 측정된 계수 구간이 없고(분석기는 보고된(미검증)
사전 범위의 양 끝을 그대로 들고 있을 뿐 이번 실측에서 계수를 갱신하지 못했다) `evidence_incomplete`로
평가 자체를 건너뛰어, 분석기는 범위 하단과 상단 어느 쪽에서도 엔진을 돌리지 않았다.
V=0 기준이고 복귀 예측 q는 측정하지도
지어내지도 않았다(`no_calibrated_forecast`). 쌍 실행은 0쌍 완료(계획 3쌍)이므로 비교할
정책 차이가 없다. 복귀 지연과 품질 결과도 측정치가 없다.

### 09-19 캡처에서 유지되는 것

원시 캡처(`quota-test/2026-09-19/raw.jsonl`, 603행, 299개 usage 응답)의 재집계는 그대로다:
uncachedInput 4,122 / cacheWrite5m 4 / cacheWrite1h 9,395,995 / cacheRead 20,555,717 /
billedModelOutput 2,840. Fable 쓰기 tick은 H6·H8 두 가설이 모두 살아 있고, 읽기/쓰기 비
0.0137-0.0576은 H6에서만 식별된다. 모두 양자화 구간이지 신뢰구간이 아니다.

## 현재 모르는 것

- **Fable 1h 쓰기 계수 W/T:** fable-write-tick이 중단돼 미측정. D1의 lag 1 적합
  80.5K-89.5K는 오염된 창의 모델 의존 값이라 `unknown`. H6/H8 미해결.
- **출력 계수 `k_out`:** 미식별. OUT-8K 게이트 호출 1건뿐이고 그것도 짧았다.
- **복원 비용 `Rw`/`Rr`와 phase 합:** 큰 컨텍스트 요청이 전부 재쓰기여서 park/restore
  분해가 없다. 이전 추정 `Rw=6K`, `Rr=125K`는 여전히 `reported_unverified`.
- **쌍 정책 차이:** 0쌍 완료. 총 quota, 재개 지연, 재설명 여부 모두 없음.
- **5m lane `k_write5`:** CLI가 1h만 쓰므로 arm 건너뜀(`adapter_capability`). 1h 값을
  기본값으로 쓰지 않는다.
- **`k_input`:** 1h 쓰기 계수로 위에서만 묶인다.
- **읽기 계수:** 5.39M-5.55M/tick은 09-19 REPORT의 보고값(미검증)이고 이 실행이 측정하지 않았다.
- **복귀 예측 q:** 없음. shadow는 `no_calibrated_forecast`를 기록한다.
- **게이지 지연 메커니즘:** 호출 단위인지 시간 정산인지, floor인지 round인지, 토큰에
  선형인지.
- **`--resume`이 바꾸는 정확한 바이트:** 요청 본문을 캡처하지 않았다.
  `<system-reminder>` 순서 가설은 검증되지 않았다.
- **out-8k 답변 텍스트:** 저장되지 않아(`needsText: false`) "1..2000 전체 출력"은 토큰
  산술 추정이다.
- **시스템·스킬 중복:** 분리 가능한 것은 매 miss마다 나오는 시스템 프롬프트 읽기 3,035뿐.

meter 읽기 자체의 비용은 이번 실행에서 헤더로 관측했으므로 더는 "미지" 목록에 두지 않는다.
읽기는 유료 응답의 헤더에서 오고 별도 호출이 아니다.

## 다음에 승인받아야 할 실행

todo 11의 2026-09-26 결정: 이 계획 안에서는 유료 재실행 없음. fable-write-tick과 ttl은
`caps_exhausted`(계획 상한 잔여 0.01 < 필요 0.03; ttl은 잔여 0이고 n=2로 답을 얻음),
output-quota / restore-decomposition / policy-effect는 `protocol_amendment_required`(그대로
다시 돌리면 같은 결정론적 중단이 반복되고, 고치려면 구속력 있는 Appendix A 숫자를 바꿔야
한다). 그래서 다음 순서로 승인이 필요하다.

1. **무료 캡처(quota 0):** 로컬 stub에 대고 claude.exe의 요청 본문을 캡처해 `--resume`
   첫 턴과 rf-emulation이 원본과 어느 바이트에서 다른지 확인한다. 유료 호출 없음.
2. **Appendix A 개정:** 출력 프롬프트를 `outp(3000)`으로, 캡처가 적중하는 형태를 보여주면
   그 형태로 복원 폴백 교체. (범위 지정 baseline 앞 settle PING은 이미 todo 13으로 구현되고
   Appendix A/B에 "Amendment 2026-09-26 (todo 13)"으로 기록됐다 - 아래 4번.)
3. **크레딧 결정:** D1로 fable-write-tick에 잘못 귀속된 0.02를 되돌릴지. 상한 회계가
   바뀌므로 사용자 결정이 필요하다.
4. **todo 13 러너 수정 (구현 완료, 실행은 미승인):** 헤더 지연을 반영한 귀속, 미설명 phase
   이월 금지, 폴백 miss 뒤 나머지 큰 컨텍스트 실험 무료 종료, 그리고 실험 경계·run 끝의
   settle PING(scope boundaries and run end)까지 모두 구현되어 코드에 있다(commit subjects:
   "attribute idle-live gauge ticks under header lag and stop after a fallback miss", "settle
   the idle-live meter before run end", "include settle charges in idle-live per-experiment
   spend"). Appendix A/B는 이 settle point를 "Amendment 2026-09-26 (todo 13)"으로 이미
   기록했고 그 상태는 "implemented in code … governs a future paid run only after the user
   approves that run"이다. todo 15가 분석기 쪽 settle 창 분리와 새 사유 코드 설명을 추가했다.
   다음 유료 실행에 이 수정된 러너(settle point 포함)를 쓰려면 사용자의 재실행 승인이
   필요하다.
5. **새 5h 창에서 launcher 재실행:** 예상 5h 약 0.21, 최대 0.28; 7d_oi 0.055-0.07.
   잔여 상한은 5h 0.36, 7d 0.09, 7d_oi 0.07이라 7d_oi 캠페인 정지선에 가깝다.
   Appendix A의 drop order를 적용한다.
6. 그 뒤에야 enforce 조건(다섯 승인 설정, `minimumEvidenceForEnforcement`: 계수는 리셋
   없는 단일 창 2회, policy-effect는 쌍 3회), 추가 쌍 실행, 5m lane 경로(CLI 밖 어댑터
   필요)를 논의할 수 있다.

승인 서명은 `docs/idle-experiments-approval-2026-09-23.json`에 있다(30일 만료). 제안
문서 [idle-experiments-approval-proposal.md](idle-experiments-approval-proposal.md)/`.json`
자체는 `proposed` 그대로이며 바뀌지 않았다.

## 재현 명령

```sh
npm test                                                            # node --test "test/*.mjs"
node scripts/quota-analysis.mjs <raw.jsonl> --json                  # 09-19 집계 재현
node scripts/idle-experiments.mjs                                   # 5개 계획 dry-run
node scripts/idle-experiments.mjs --execute                         # 거부, exit 2
node scripts/idle-live-runner.mjs --dry-run --approval docs/idle-experiments-approval-2026-09-23.json --evidence tmp/dry
node scripts/idle-live-analyze.mjs <runDir> --md tmp/results.md     # 실측 분석 재현
node scripts/idle-replay.mjs --sample                               # 샘플 재생
```

실측 원본은 gitignore된 `.omo/ulw-execute/evidence/idle-live-run/live/20260925-161302`(worktree
w2)에만 있다. 분석기를 `--md docs/idle-live-results.md`로 다시 돌리면 그 파일의 손으로
쓴 10절이 지워지므로 임시 경로로 출력한다.

## 롤백

기본값이 `off`이므로 아무것도 하지 않으면 된다. `idleCostMode`를 지우거나 `off`로 두면
shadow 기록이 멈추고 운영 동작은 처음부터 끝까지 동일하다. 실측은 운영 설정을 건드리지
않았으므로 되돌릴 것이 없다.
