# 유휴 비용 실측 결과 (20260925-161302+20260927-052028)

합친 실행 2개(오래된 순, 시간이 겹치지 않음): 20260925-161302, 20260927-052028. 실험마다 모든 시도(attempt)를 판정과 함께 적고, 끝까지 기록되고 창이 깨끗한 시도(valid 또는 upper_bound)만 합산했다. 제외한 시도의 행은 합산 결과, 계수, 정책 답 어디에도 들어가지 않는다.
20260925-161302 증거: requests.jsonl sha256 `05ea9e7aca8203bece685c8c277a6bf936bbbff61ef1a4ab1782e941f37a8886`, events.jsonl sha256 `0ba89423479b803f737132621b3691f6a66226af3f431baf8a404d7f7fa39e84`.
20260927-052028 증거: requests.jsonl sha256 `df39a125431893862db4b3036816d938fe5c08387caac84e36e384adc51868df`, events.jsonl sha256 `7e6d17dad7b5f847d8b70799c3cb864b09bae50bff0327842730ee449808fb8e`.
게이지 해상도는 0.01이므로 모든 계수는 양자화 구간으로만 보고한다. 이 구간은 신뢰구간이 아니며 점추정값은 발표하지 않는다(발표하는 점은 구간의 상단이라고 명시한다).
20260925-161302 증거 무결성: 해석 불가 요청 행 0개 -> 없음.
20260927-052028 증거 무결성: 해석 불가 요청 행 0개 -> 없음.

## 1. fable-write-tick (쓰기 tick)
- 판정: valid
- 시도 20260925-161302#1: aborted (cap_exceeded) -> 합산에서 제외
- 시도 20260927-052028#1: valid -> 합산에 포함
- 블록 1 [20260927-052028#1]: W=71572 tokens, n=0, m=16, phi=[0, 0.027] -> W/T [0.536041, 0.600763], T [119135.1, 133519.8] tokens/tick
  - hold: 7/7개, 규정 오프셋 충족 예 (허용오차 30000 ms)
- 블록 2 [20260927-052028#1]: W=71639 tokens, n=0, m=16, phi=[0, 0.027] -> W/T [0.536041, 0.600763], T [119246.7, 133644.7] tokens/tick
  - hold: 7/7개, 규정 오프셋 충족 예 (허용오차 30000 ms)
- 블록 교집합 T: [119246.7, 133519.8] tokens/tick
- 가설: H6 (근거 interval_below_h6_threshold, 경계 0.645/0.755, 지연 tick 0개)
- 사전값과의 pooled T: [122387.3, 171342.2] (prior 6/8 tick은 reported_unverified)
- 건너뛴 arm: fable-write-5m (adapter_capability) -> k_write5 미측정

## 2. output-quota (출력 계수)
- 판정: upper_bound (blocks_disjoint: 블록마다 구한 k_out 구간이 서로 겹치지 않는다(Appendix A: 블록 2는 블록 1과 겹쳐야 한다). 이 증거에는 모형이 맞지 않으므로 측정값은 발표하지 않고, 블록 상한 중 가장 큰 값만 상한으로 보고한다)
- 시도 20260925-161302#1: aborted (short_output) -> 합산에서 제외
- 시도 20260927-052028#1: upper_bound (blocks_disjoint) -> 합산에 포함
- 블록 1 [20260927-052028#1]: 목표 8000 tokens, N=9, tick=2, Sum_out=72778, phi [0, 0.027027], phi 출처 carried_phase_from_events, k_out [0.000026893964, 0.000030698234] ticks/token, 유효 비율 1
- 블록 2 [20260927-052028#1]: 목표 8000 tokens, N=7, tick=2, Sum_out=56728, phi [0, 0.24862], phi 출처 chained_residual_of_block_1, k_out [0.00003072544, 0.000040969521] ticks/token, 유효 비율 1
- 블록 3 [20260927-052028#1]: 목표 4000 tokens, N=13, tick=2, Sum_out=54106, phi [0, 0.332124], phi 출처 chained_residual_of_block_2, k_out [0.000030437556, 0.000039688073] ticks/token, 유효 비율 1
- 위상 근거: 블록 1의 위상은 experiment_started.carryPhase(기계가 기록한 직전 tick 이후 위상)이고, 그 사이의 조용한 settle PING은 블록 1의 합에 넣었다. 다음 블록의 위상은 직전 블록의 두 번째 tick이 남긴 잔여 구간이다: 0 이상이고, 그 tick을 낸 OUT 호출의 비용보다 작으며, 직전 블록의 k_out 구간으로 제한한다. 직전 블록의 hold PING은 그 사이의 비용으로 합에 넣었다. DIAL 읽기의 rho는 가정하지 않는다. hold PING에서 tick이 나오면 연쇄가 끊기고, 그 다음 블록의 위상은 미관측(상한만)이다.
- k_out: 상한만 < 0.000040969521 ticks/token, 블록 겹침 아니오 (블록 구간이 서로 겹치지 않아 측정값은 없다. 상한은 블록 상한 중 가장 큰 값이다)
- 읽기 비용 차감에 쓴 사전 범위: 5390000-5550000 tokens/tick (quota-test/2026-09-19/REPORT.md, reported_unverified)
- 쓰기 대비 비율 r = k_out * T: 미측정
- 유효 요청 비율: 1 (기준 0.9)

## 3. ttl-1h-unique-prefix (1h TTL 갱신)
- 판정: valid
- 시도 20260925-161302#1: contaminated (anomalies_present) -> 합산에서 제외
- 시도 20260927-052028#1: valid -> 합산에 포함
- run 1 [20260927-052028#1]: 처치 ping HIT, 처치 check HIT, 대조 check MISS (valid, 일정 준수 예)
- run 2 [20260927-052028#1]: 처치 ping HIT, 처치 check HIT, 대조 check MISS (valid, 일정 준수 예)
- 결론: renews_at_55min (55분 읽기가 TTL을 갱신함, n=2, measured)

## 4. restore-decomposition (복원 분해)
- 판정: valid
- 시도 20260925-161302#1 (run 1): aborted (big_context_rewrite) -> 합산에서 제외
- 시도 20260925-161302#2 (run 2): aborted (big_context_rewrite) -> 합산에서 제외
- 시도 20260927-052028#1 (run 1): valid -> 합산에 포함
- 시도 20260927-052028#2 (run 2): contaminated (anomalies_present) -> 합산에서 제외
- run 1 [20260927-052028#1] (resume-sysfile): 파킹 경로 [0.00443, 0.00599] / 원문 경로 [0.0026, 0.00276] (unified-5h 환산, 구간)
  - 복원 지연: 파킹 18835 ms, 원문 3200 ms
  - phase별 요청 수: ctx_create=1, observe=1, park_parent=1, restore_child=3, resume_raw=2, useful_work=12
  - 품질(park_path): guard true, 정답 6/6, 재설명 요청 1, handoff 유실 false
  - 품질(raw_path): guard true, 정답 6/6, 재설명 요청 미상(not_applicable), handoff 유실 미상(not_applicable)

## 5. policy-effect (정책 효과)
- 판정: valid
- 시도 20260925-161302#1: aborted (big_context_rewrite) -> 합산에서 제외
- 시도 20260927-052028#1: valid -> 합산에 포함
- 쌍 수 n=3 (평균과 범위만, 구간 추정 주장 없음)
  - unified-5h: 평균 차이 [0.00146, 0.0035], 최소 0.0013, 최대 0.00372 (후보 - 현행)
  - unified-7d: 평균 차이 [-0.001, 0.00239], 최소 -0.00104, 최대 0.00247 (후보 - 현행)
  - unified-7d_oi: 평균 차이 [-0.00135, 0.00356], 최소 -0.00142, 최대 0.00368 (후보 - 현행)
  - 품질 차이(정답 수 평균): 0
  - 상태: complete

## 6. 지출 (meter별)

| meter | 관측 | 상한 | 창 수 |
| --- | --- | --- | --- |
| `unified-5h` | 0.39 | 0.42 | 3 |
| `unified-7d` | 0.06 | 0.08 | 2 |
| `unified-7d_oi` | 0.11 | 0.13 | 2 |
| `unified-5h` (20260925-161302) | 0.16 | 0.17 | 1 |
| `unified-7d` (20260925-161302) | 0.02 | 0.03 | 1 |
| `unified-7d_oi` (20260925-161302) | 0.04 | 0.05 | 1 |
| `unified-5h` (20260927-052028) | 0.23 | 0.25 | 2 |
| `unified-7d` (20260927-052028) | 0.04 | 0.05 | 1 |
| `unified-7d_oi` (20260927-052028) | 0.07 | 0.08 | 1 |

## 7. 계수 레코드

| meter | sourceKind | cacheWrite1h 구간 | 발표값(상단) | 출력 계수 |
| --- | --- | --- | --- | --- |
| `unified-5h-utilization-fraction` | measured | [7.4895e-8, 8.3860e-8] | 8.3860e-8 | 없음 (upper_bound: blocks_disjoint) |
| `unified-7d-utilization-fraction` | reported_unverified | [9.3619e-9, 3.1059e-8] | 3.1059e-8 | 없음 (unidentified: no_output_observation_on_this_meter) |
| `unified-7d_oi-utilization-fraction` | reported_unverified | [1.6643e-8, 4.7920e-8] | 4.7920e-8 | 없음 (unidentified: no_output_observation_on_this_meter) |

측정하지 않은 필드는 null로 두었다(0으로 채우지 않았다). evidenceRef는 문자열이며 구조화된 출처는 `coefficientProvenance`에 따로 둔다.

## 8. 정책 답 (범위 양 끝)
- 결론: **LET_EXPIRE** (both_range_ends_agree)
- 엔진: evaluateIdleCost, 예측 분포는 측정하지 않았다(no_calibrated_forecast: q를 지어내지 않는다. 아래 가정 시나리오는 라벨을 붙인 가정일 뿐이다). V=0 기준.
- 엔진에 넣은 출력 계수(unified-5h, 출력 토큰당 사용률): 하단 3.7448e-8, 상단 4.0970e-7 (prior_ratio_0.5_to_2.5_x_write_high_end_raised_to_evidence_upper_bound)
- 범위 하단: LET_EXPIRE (no_calibrated_forecast, 증거 uncertain)
- 범위 상단: LET_EXPIRE (no_calibrated_forecast, 증거 uncertain)
- 가정 시나리오 `q1_return_after_2h` (라벨: hypothetical, 채택 아니오): 범위 하단 WAIT / 범위 상단 WAIT -> WAIT (both_range_ends_agree)
- 가정 시나리오 `q0.5_return_after_2h` (라벨: hypothetical, 채택 아니오): 범위 하단 WAIT / 범위 상단 WAIT -> WAIT (both_range_ends_agree)

## 9. 모르는 것

- cacheWrite5m 계수: CLI는 1h 캐시에만 쓰므로 5m 갈래는 건너뛰었고(adapter_capability) k_write5는 모른다. 1h 값으로 대신 채우지 않는다
- uncachedInput 계수(k_input): 모른다. 1h 쓰기 계수보다 크지 않다는 상한만 있다
- cacheRead 계수: tick당 5390000-5550000 토큰이라는 값은 quota-test/2026-09-19/REPORT.md에 보고된 검증 전 사전 범위(reported_unverified)이며, 이 실행에서 측정하지 않았다
- 복귀 예측 q: 측정하지 않았다. 계획기의 항목은 가정 시나리오라는 라벨을 붙였을 뿐 사실로 쓰지 않는다
- skillRestoreEq / sharedLossEq / parkQualityEq: 측정하지 않았다. 엔진 모델에는 0 기준값으로 넣었다
- k_out(출력 토큰당 tick): 이 증거로는 정하지 못했다(blocks_disjoint)
- output-quota: upper_bound (blocks_disjoint)
- fable-write-tick 시도 20260925-161302#1: aborted (cap_exceeded) - 합산 분석에서 제외했다
- output-quota 시도 20260925-161302#1: aborted (short_output) - 합산 분석에서 제외했다
- ttl-1h-unique-prefix 시도 20260925-161302#1: contaminated (anomalies_present) - 합산 분석에서 제외했다
- restore-decomposition 시도 20260925-161302#1 (run 1): aborted (big_context_rewrite) - 합산 분석에서 제외했다
- restore-decomposition 시도 20260925-161302#2 (run 2): aborted (big_context_rewrite) - 합산 분석에서 제외했다
- restore-decomposition 시도 20260927-052028#2 (run 2): contaminated (anomalies_present) - 합산 분석에서 제외했다
- policy-effect 시도 20260925-161302#1: aborted (big_context_rewrite) - 합산 분석에서 제외했다
- 복원 1@20260927-052028회차 raw_path handoffLossy: not_applicable
- 복원 1@20260927-052028회차 raw_path reexplainNeeded: not_applicable

이 문서는 측정된 범위를 넘는 절감 주장을 하지 않는다. 쌍 실행은 계획한 3쌍 중 3쌍을 마쳤고, 마친 쌍의 차이는 평균과 범위로만 보고한다.
