# 유휴 비용 실측 결과 (20260925-161302)

증거: requests.jsonl sha256 `05ea9e7aca8203bece685c8c277a6bf936bbbff61ef1a4ab1782e941f37a8886`, events.jsonl sha256 `0ba89423479b803f737132621b3691f6a66226af3f431baf8a404d7f7fa39e84`.
게이지 해상도는 0.01이므로 모든 계수는 양자화 구간으로만 보고한다. 이 구간은 신뢰구간이 아니며 점추정값은 발표하지 않는다(발표하는 점은 구간의 상단이라고 명시한다).
증거 무결성: 해석 불가 요청 행 0개 -> 없음.

## 1. fable-write-tick (쓰기 tick)
- 판정: aborted (cap_exceeded: 다음 호출이 지출 한도를 넘을 것으로 예측되어 게이트가 거부했다: 이 실험만 중단했다)

## 2. output-quota (출력 계수)
- 판정: aborted (short_output: 기계가 기록한 사유 코드(추가 설명 없음))

## 3. ttl-1h-unique-prefix (1h TTL 갱신)
- 판정: contaminated (anomalies_present)
- run 1: 처치 ping HIT, 처치 check HIT, 대조 check MISS (valid, 일정 준수 예)
- run 2: 처치 ping HIT, 처치 check HIT, 대조 check MISS (valid, 일정 준수 예)
- 결론: renews_at_55min (55분 읽기가 TTL을 갱신함, n=2, measured)

## 4. restore-decomposition (복원 분해)
- 판정: aborted (big_context_rewrite: 기계가 기록한 사유 코드(추가 설명 없음))

## 5. policy-effect (정책 효과)
- 판정: aborted (big_context_rewrite: 기계가 기록한 사유 코드(추가 설명 없음))

## 6. 지출 (meter별)

| meter | 관측 | 상한 | 창 수 |
| --- | --- | --- | --- |
| `unified-5h` | 0.16 | 0.17 | 1 |
| `unified-7d` | 0.02 | 0.03 | 1 |
| `unified-7d_oi` | 0.04 | 0.05 | 1 |

## 7. 계수 레코드

| meter | sourceKind | cacheWrite1h 구간 | 발표값(상단) | 출력 계수 |
| --- | --- | --- | --- | --- |
| `unified-5h-utilization-fraction` | unknown | 미측정 | 없음 | 없음 (upper_bound: experiment_not_valid:short_output) |
| `unified-7d-utilization-fraction` | unknown | 미측정 | 없음 | 없음 (unidentified: no_output_observation_on_this_meter) |
| `unified-7d_oi-utilization-fraction` | unknown | 미측정 | 없음 | 없음 (unidentified: no_output_observation_on_this_meter) |

측정하지 않은 필드는 null로 두었다(0으로 채우지 않았다). evidenceRef는 문자열이며 구조화된 출처는 `coefficientProvenance`에 따로 둔다.

## 8. 정책 답 (범위 양 끝)
- 결론: **NO_DECISION** (evidence_incomplete)
- 엔진: evaluateIdleCost, 예측 분포는 측정하지 않았다(no_calibrated_forecast: q is never invented; the entries below are labelled hypothetical scenarios). V=0 기준.
- 범위 하단/상단 평가 없음: 증거가 불완전하여 엔진을 돌리지 않았다.

## 9. 모르는 것

- cacheWrite5m coefficient: the CLI writes only the 1h lane, so the 5m arm is skipped (adapter_capability) and k_write5 stays unknown - never defaulted from the 1h lane
- uncachedInput coefficient (k_input): unknown, only bounded above by the 1h write coefficient
- cacheRead coefficient: the 5390000-5550000 tokens per tick figure is a reported_unverified prior range from quota-test/2026-09-19/REPORT.md, not measured by this run
- return forecast q: not measured; the planner entries are labelled hypothetical scenarios, never facts
- skillRestoreEq / sharedLossEq / parkQualityEq: not measured; entered as 0 baselines in the engine model
- T (tokens per 5h write tick): not identified by this evidence; the prior range 102K-143K is reported_unverified
- k_out (ticks per output token): not identified by this evidence (experiment_not_valid:short_output)
- fable-write-tick: aborted (cap_exceeded)
- output-quota: aborted (short_output)
- ttl-1h-unique-prefix: contaminated (anomalies_present)
- restore-decomposition: aborted (big_context_rewrite)
- policy-effect: aborted (big_context_rewrite)

이 문서는 측정된 범위를 넘는 절감 주장을 하지 않는다. 쌍 실행 n=3의 차이는 평균과 범위로만 보고한다.

---

<!-- 이 아래는 손으로 쓴 부분이다 (plan todo 9, D1-D3). 위의 1-9절은 분석기가 생성했다. 분석기를 `--md docs/idle-live-results.md`로 다시 돌리면 이 부분이 지워진다. F3은 JSON(docs/idle-live-results.json)만 바이트 단위로 비교한다. -->

## 10. 중단 원인과 판정 근거 (손으로 작성, todo 9)

모든 수치는 아래 파일로 직접 검증했다.

- 원시 기록: `requests.jsonl`(요청 행 번호 #1-#22), `events.jsonl`(seq), 코드 file:line.
- 독립 재계산: `verify.mjs` 257개 MATCH, `d1-lag.mjs`. 둘 다 `.omo/ulw-execute/evidence/idle-live-run/task-9/`에 있다.
- 읽기 전용 진단(task-9/diagnosis)은 가설을 얻는 데만 썼다. 결론은 위 스크립트의 출력으로 다시 확인했다.

### 10.1 D1: 게이지 헤더 지연

모델(Appendix A 0절): 5h 헤더는 floor(누적/0.01)이고, 사용량에 선형이다. 호출 N의 헤더가 호출 1..N-L까지를 반영한다고 두고 L = 0, 1, 2를 검사했다. 탐색 범위는 다음과 같다.

- T(0.01당 1h 쓰기 토큰): 60K-200K
- 읽기: 0.01당 5.39M-5.55M
- 출력 가중: 쓰기의 0.5-12배

| 가정 | 사전 범위 T 102K-143K | 넓힌 범위 T 79K-102K | 전체 60K-200K |
| --- | --- | --- | --- |
| lag 0 (자기 호출에 반영) | 불가능 | 불가능 | 불가능 (첫 위반: #4) |
| lag 1 (다음 호출에 반영) | 불가능 (첫 위반: #7) | T 80.5K-82.75K, 출력 비 1.55-2.5에서만 가능 | T 80.5K-89.5K, 출력 비 1.55 이상에서만 가능 |
| lag 2 | 불가능 | 불가능 | 불가능 (첫 위반: #5) |

- 직접 반례(적합 없이 확인): #4 `restore-decomposition/shared/0`은 1h 143,362를 썼는데 자기 헤더는 0.00 그대로였고, 다음 호출 #5에서 0.02가 됐다. lag 0에서 이 관측이 성립하려면 T > 147,418이어야 한다.
- **판정:**
  - 데이터는 "사전 가격에서 lag 0"을 기각한다.
  - lag 1은 T가 사전 범위보다 낮을 때(80.5K-89.5K, 09-19 H8 구간 안)만 허용된다.
  - floor·선형 가정 아래 호출 단위 지연 L = 0, 1, 2 중 남는 것은 lag 1뿐이다. 그러나 시간 기반 정산 모델은 검사하지 않았으므로 lag 1을 확정하지는 않는다.
  - T는 오염된 창에서 모델에 의존해 얻은 적합이므로 `unknown`으로 둔다.
- **두 모델에서 달라지는 게이지 파생 수치** (5h, tick = 0.01):
  - 실험별 지출:

    | 실험 | lag 0 | lag 1 |
    | --- | --- | --- |
    | restore run 1 | 3 | 5 |
    | fable | 2 | 0 |
    | output | 0 | 1 |
    | policy | 2 | 3 |
    | restore run 2 | 4 | 4 |
    | ttl | 5 | 3 + 마지막 호출(#22)의 미표시분 |

  - 미터 상한: lag 0에서 5h 0.17 / 7d 0.03 / 7d_oi 0.05, lag 1에서 각각 최대 +0.01 (5h 0.18). 모두 한도 안이다.
  - 계수 구간: 분석기가 하나도 내지 않았으므로 달라지는 것이 없다.
  - **판정이 바뀌는 것:**
    - fable의 `cap_exceeded` 중단: lag 1에서는 발생하지 않는다. 투영치가 0 + 1 ≤ 2가 된다.
    - ttl 오염 이상의 귀속: lag 1에서는 restore run 2의 꼬리다.
  - **바뀌지 않는 것:** output-quota·restore·policy의 중단, TTL HIT/MISS(사용량 기반), 정책 답 NO_DECISION.

### 10.2 D2: TTL 판정 (규정대로)

- ttl-1h-unique-prefix는 **contaminated** (`anomalies_present`)로 보고한다.
  - 기계는 `valid`로 닫았다(events seq 60).
  - 그러나 #13 `ttl-1h-unique-prefix/treatment/0`에 `gauge_moved_without_own_call`이 있다. 헤더가 +2 tick 움직였는데, 이 호출은 59.6K 쓰기로 약 0.4-0.75 tick이다.
  - Appendix B는 창 청결 판정의 권한을 분석기에 둔다. 따라서 더 엄격한 판정이 이긴다(todo-8 게이트 st_01a0d9d1 Q3 규정).
- 이 상태 아래 사용량 기반 결과(n = 2, 일정 ±90 s 준수):
  - run 1: A 55분 읽기 HIT (read 62,637) → 110분 A HIT (read 62,637, write 0). B MISS (재쓰기 59,703).
  - run 2: C HIT (62,662) → C HIT (62,662, write 0). D MISS (59,723).
  - 분석기 결론: `renews_at_55min`. `measured` 기록으로 승격하려면 Appendix B 개정과 테스트가 필요하다(계획에 없음).

### 10.3 D3: 네 중단의 근본 원인

| 실험 | 중단 사유 | 분류 | 근거 |
| --- | --- | --- | --- |
| fable-write-tick | `cap_exceeded` (seq 21-22) | **러너 코드 결함** (게이지 귀속) | 아래 (1) |
| output-quota | `short_output` (seq 26) | **프로토콜 전제** (OUT-8K 형태를 실측한 적 없음) | 아래 (2) |
| restore-decomposition run 1·2 | `big_context_rewrite` (seq 16, 38) | **CLI/프로토콜 전제**. 러너가 알려진 실패 모드로 계속 진행한 것은 코드 결함 | 아래 (3) |
| policy-effect | `big_context_rewrite` (seq 32) | (3)과 같음 | 아래 (3) |

**(1) fable-write-tick.**

- 블록의 유일한 호출 #7(DIAL):
  - 사용량: `cache_read` 146,397 = 3,035 + 143,362, 1h 쓰기 0, 출력 4. 즉 HIT였다.
  - 자기 비용은 146,397 / 5.39M-5.55M = 0.0264-0.0272 tick이다.
  - 그런데 헤더는 0.03 → 0.05로 +2 tick을 보였다.
- 러너가 이 2 tick을 fable 블록에 넣은 경로:
  - 블록 기준값은 직전 호출 #6(restore `park_path/2`, 1h 143,444, 출력 4,238)의 헤더에서 가져왔다. `snapshotBaselines`, scripts/idle-live/machine.mjs:1261.
  - 2 tick 전부를 블록에 청구했다. `attribute`, machine.mjs:812.
  - 설명되지 않은 움직임은 "spend로 계산"한다. machine.mjs:832-839 주석과 플래그.
- 그 결과: 다음 WRITE-2400은 예측 1 tick(caps.mjs:113 `Math.max(1, ...)`)으로 투영치 0.02 + 0.01 > 0.02가 되어 거부됐다(caps.mjs:245-247).
- D1에서 lag 0이 기각되므로, 이 청구는 기각된 모델에 기대고 있다. lag 1에서 그 2 tick은 #6의 비용이다.
- 부수 결함: #7의 위상 [0, 0.027]이 output-quota로 이월됐다(machine.mjs:1345-1346, seq 23 `carryPhase`). 이 tick은 dial tick이 아니었다.
- 수정은 todo 13(a)의 몫이다.

**(2) output-quota.**

- #8 `output-quota/out-8k/0`: `output_tokens` 5,106(thinking 104), `stop_reason` `end_turn`, read 3,035, 1h 1,009.
- 게이트 조건은 6,000 이상 AND `end_turn`이다(scripts/idle-live/protocols.mjs:51 `gateMinOutput`, :325·:332-333).
- CLI가 출력을 자른 것이 아니다. 잘렸다면 `max_tokens`였을 것이다. 어댑터 run.json에도 `maxOutputTokens: null`로 기록돼 있다.
- Appendix A 0절의 "out ~8K"는 기대값이었다. 09-19 Ot 블록은 0 시행이었다. 즉 이 형태는 한 번도 측정된 적이 없다.
- 추정(검증 안 됨): 보이는 출력 5,002(= 5,106 − 104)가 999×2 + 1,001×3 = 5,001과 거의 같으므로 1..2000 목록 전체가 약 5K 토큰일 가능성이 높다. 답변 텍스트는 저장되지 않았다(`needsText: false`라 cli/ 파일이 없다).

**(3) restore-decomposition과 policy-effect.**

- 큰 컨텍스트 쓰기 이후의 모든 큰 컨텍스트 요청이 전체 재쓰기였다. 각 요청은 시스템 프롬프트 3,035만 읽었다.

  | 호출 | 방식 | read | 1h write | 비고 |
  | --- | --- | --- | --- | --- |
  | #5 | `--resume` a1d34673, NULLP | 3,035 | 143,423 | 게이트 기준 read ≥ 131,040 실패, protocols.mjs:414 |
  | #6 | rf-emulation | 3,035 | 143,444 | |
  | #10 | rf-emulation | 3,035 | 143,424 | |
  | #12 | rf-emulation | 3,035 | 143,486 | |

  #6·#10·#12는 `cacheWrite1h >= 100000` 규칙으로 중단됐다(protocols.mjs:61, :435).
- #4가 쓴 캐시가 살아 있었다는 증거: #7이 #4와 바이트가 같은 프롬프트(sha `d27fe235`, 204,457자)를 새 세션으로 57초 뒤에 보내 146,397을 읽었다.
- rf-emulation이 맞지 않는 이유:
  - #6의 프롬프트는 `c0720691`, 204,711자다. #4 프롬프트에 `"\n\n"`과 park 텍스트를 **같은 텍스트 블록 안에** 붙인 것이다(filler.mjs:49-50 `appendPrompt`, protocols.mjs:420-424 `bigContext`). 어댑터는 이것을 하나의 stdin 프롬프트로 보낸다(adapters/claude-cli.mjs:113).
  - 캐시 적중에 필요한 블록 경계가 시스템 프롬프트 뒤에 없다. 그래서 읽기가 정확히 3,035에 머문다.
  - 이것은 Appendix A 4절 2단계("정확한 prefix 바이트 + 접미사")의 전제가 문자 수준에서는 맞지만 캐시 키 수준에서는 틀렸음을 뜻한다.
- `--resume`이 왜 재쓰기인지:
  - 입력 합계는 #4 146,399 대비 #5 146,460으로 비슷하다. 크기가 아니라 바이트가 다르다는 뜻이다.
  - 09-19 로그의 `fable.WR.r.*`에서도 같은 현상이 있었다.
- 러너 코드 결함: restore run 1이 rf-emulation에서 `big_context_rewrite`로 끝난 뒤에도 policy-effect(#9-#10)와 restore run 2(#11-#12)가 같은 방식으로 실행됐다. 143K 쓰기 4회가 더 들었고, lag 0 기준 5h 0.06이다(seq 27 `mode: {resumeHit:false}` 이월). 수정은 todo 13(b)의 몫이다.

### 10.4 모르는 채로 남는 것

- `--resume` 재생의 첫 턴이 원래 요청과 **어떤 바이트에서** 다른지. 요청 본문을 캡처하지 않았다. 진단의 가설(첨부 `<system-reminder>`의 순서 차이)은 검증되지 않았다.
- 게이지 지연이 호출 단위인지 시간 기반 정산인지, floor인지 round인지, 미터가 토큰에 선형인지.
- out-8k 답변 텍스트. 저장되지 않아서 "1..2000 전체 출력"은 토큰 산술에서 나온 추정이다.
- stream-json 두 메시지 형태로 ctx 캐시를 재사용할 수 있는지(시험하지 않음).
- T, k_out, 읽기/쓰기 비, 복원 비용 Rw/Rr, 파킹 분해. 이 실행은 이 중 어느 것도 측정하지 못했다.
