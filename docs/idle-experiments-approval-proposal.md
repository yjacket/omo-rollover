# Idle 실험 실측 승인안 (제안, 미승인)

**한 문장 요약:** 다섯 개 오프라인 실험 계획에 대해 서명만 하면 되는 조건표다. 이 문서와
`docs/idle-experiments-approval-proposal.json`은 둘 다 `status: "proposed"`이고, 서명 전까지는
어떤 실행도 허가하지 않는다.

기계가 읽는 값의 원본은 `docs/idle-experiments-approval-proposal.json`이다. 이 문서의 숫자와
JSON이 어긋나면 JSON이 맞고, 이 문서를 고친다. 거부하고 싶은 값이 있으면 서명 전에 JSON을
고치면 된다.

## 목적

승인 대상은 실행 자체가 아니라 조건표다. 즉 "이 다섯 실험을 이 순서로, 이 상한 안에서, 이
중단 조건 아래에서 돌려도 된다"는 조건 집합에 서명하는 것이고, 실제 요청은 별도 검토된
runner가 나중에 낸다. `docs/idle-experiments.md`의 다섯 계획은 지금 모두 dry-run이며 승인
설정 다섯 개가 전부 `unconfigured`다. 이 제안은 그 빈칸을 채울 값을 정한다.

서명 전에는 다음이 그대로다.

- 실계정 요청 0건. `node scripts/idle-experiments.mjs --execute`는 여전히 exit 2.
- 파킹, 핑, 예산, rollover 설정 변경 없음.
- 절감 주장 없음. 실측 절감은 입증되지 않음이며, 이 문서도 그렇게 주장하지 않는다.

## 대상 계정, 모델, lane, meter

| 항목 | 값 | 이유 |
|---|---|---|
| `modelId` | `claude-fable-5-1` | 기존 캡처와 shadow 엔진이 이 모델을 기준으로 한다 |
| `authLane` | `claude-sdk-oauth` | 1h cache TTL을 가진 유일한 lane (`docs/field-notes.md`) |
| `ttlLane` | `1h` | 실험이 검증하려는 TTL이 1h lane이다 |
| `quotaMeters` | `unified-5h`, `unified-7d`, `unified-7d_oi` | 세 meter가 각각 독립된 제한 창이라 합치지 않는다 |
| `gaugeResolution` | `0.01` (utilization fraction) | 공개 게이지가 0.01 단위로만 움직인다 |

계정은 실험 기간 동안 독점 사용해야 한다. 다른 omo 세션, 백그라운드 워커, 사용자의 직접
요청이 하나라도 섞이면 게이지 델타를 귀속할 수 없다.

## 실행 순서와 이유

한 번에 한 계획만 돌린다. 같은 계정에서 두 계획을 겹치지 않는다.

1. `fable-write-tick`: 가장 싸고(유료 2건) 나머지 실험이 쓰는 쓰기 tick 가설(H6/H8)을 먼저 정리한다.
2. `output-quota`: 쓰기 tick을 안 뒤 출력 계수 `k_output`을 따로 본다.
3. `restore-decomposition`: 쓰기와 출력 계수가 있어야 phase별 분해가 해석된다.
4. `ttl-1h-unique-prefix`: t+55분, t+110분 대기가 있어 계정을 오래 묶는다. 뒤로 미룬다.
5. `policy-effect`: 가장 비싸고(유료 24건) 앞선 네 실험의 결과를 모두 전제한다. 마지막이다.

앞 단계가 중단되면 뒤 단계로 넘어가지 않는다. 다시 시작할지는 새 서명으로 정한다.

## 실험별 승인 설정

지출 단위는 두 지출 상한 모두 `quota_fraction`이다. meter가 공개하는 utilization의 델타이고,
0.01이 한 tick이다. 지출 상한은 가장 먼저 묶이는 `unified-5h` meter 기준이다. 유료 요청 수와
게이지 읽기 수는 `docs/idle-experiments.md`의 계획 값이다. 게이지 읽기 자체의 비용은 `unknown`이다.

다섯 설정의 단위는 서로 다르고 합치지 않는다.

- `maxProactiveSpendPerIdle`: `quota_fraction` (spend)
- `maxTotalExperimentalSpend`: `quota_fraction` (spend)
- `maxResumeDelay`: `ms` (time). 복귀 단계가 없는 계획은 `unlimited`이고, 근거는 "no resume phase in this plan"이다.
- `allowedQualityDegradation`: `lost_context_events` (quality). 다섯 계획 모두 `0`. 품질 가드가 발동한 run은 실패이고, 싼 결과가 아니다.
- `minimumEvidenceForEnforcement`: `observations` 또는 `paired_runs` (evidence). 계수는 리셋 없는 단일 요청 창 두 번에서 재현될 때만 인정한다.

| 실험 id | 유료 요청 수 | 게이지 읽기 수 | 다섯 승인 설정 값·단위 | 실험별 중단 조건 | 미실행 시 영향 |
|---|---|---|---|---|---|
| fable-write-tick | 2 | 12 | `maxProactiveSpendPerIdle` 0.02 `quota_fraction`; `maxTotalExperimentalSpend` 0.04 `quota_fraction`; `maxResumeDelay` `unlimited` `ms`; `allowedQualityDegradation` 0 `lost_context_events`; `minimumEvidenceForEnforcement` 2 `observations` | 창 안에 다른 요청; 창 안 리셋 경계; t+60분에 게이지 미안정 | H6/H8 미해결, 쓰기 계수 미측정 유지. 5m 계수를 1h 기본값으로 재사용하지 않음 |
| output-quota | 12 | 6 | `maxProactiveSpendPerIdle` 0.03 `quota_fraction`; `maxTotalExperimentalSpend` 0.08 `quota_fraction`; `maxResumeDelay` `unlimited` `ms`; `allowedQualityDegradation` 0 `lost_context_events`; `minimumEvidenceForEnforcement` 2 `observations` | quota 리셋; 출력 절단 또는 거부; 동시 계정 사용; 입력/읽기/쓰기가 고정되지 않으면 `not_identifiable` | `k_output` 미지 유지, 출력 측 절감 주장 불가 |
| restore-decomposition | 19 | 4 | `maxProactiveSpendPerIdle` 0.08 `quota_fraction`; `maxTotalExperimentalSpend` 0.15 `quota_fraction`; `maxResumeDelay` 120000 `ms`; `allowedQualityDegradation` 0 `lost_context_events`; `minimumEvidenceForEnforcement` 2 `observations` | 상한 초과; phase 경계 누락; 작업 범위 발산; meter 간 비교 불가 | `Rw`/`Rr` 미검증 유지, 복원 비용은 불확실 범위로 남음 |
| ttl-1h-unique-prefix | 5 | 4 | `maxProactiveSpendPerIdle` 0.03 `quota_fraction`; `maxTotalExperimentalSpend` 0.06 `quota_fraction`; `maxResumeDelay` `unlimited` `ms`; `allowedQualityDegradation` 0 `lost_context_events`; `minimumEvidenceForEnforcement` 2 `observations` | 두 prefix 중 어느 쪽이든 계획 외 요청; 시간 창 이탈; lane 또는 모델 변경; 단계 실패; t+55분 핑 외의 probe | TTL 갱신 불확실 유지, warm/cold/uncertain 3상태 유지, 핑 갱신에 의존하는 enforcement 불가 |
| policy-effect | 24 | 4 | `maxProactiveSpendPerIdle` 0.10 `quota_fraction`; `maxTotalExperimentalSpend` 0.20 `quota_fraction`; `maxResumeDelay` 120000 `ms`; `allowedQualityDegradation` 0 `lost_context_events`; `minimumEvidenceForEnforcement` 3 `paired_runs` | 작업 범위 발산; 품질 가드 발동; 라이브 정책 변경; 한 쌍에서 일반화 | 정책 비교 미측정, shadow는 기록 전용 유지 |

다섯 계획 합계: 유료 요청 62건, 게이지 읽기 30회. `maxTotalExperimentalSpend`를 단순 합산하면
0.53이다.

### meter별 누적 상한

`perMeterCumulativeCaps`는 다섯 계획을 모두 돌렸을 때 각 meter의 누적 델타 상한이다.

| meter | 누적 상한 (`quota_fraction`) | 근거 |
|---|---|---|
| `unified-5h` | 0.53 | 다섯 계획의 `maxTotalExperimentalSpend` 합 |
| `unified-7d` | 0.12 | 7d tick이 5h tick의 약 5.7배라는 보고값(미검증)에서 0.53 / 5.7 ≈ 0.09를 올림. 이전 run의 abort 상한 0.15보다 낮게 둠 |
| `unified-7d_oi` | 0.12 | `unified-7d`와 같은 근거 |

어느 meter든 누적 델타가 상한에 닿으면 그 시점의 계획을 중단하고 뒤 계획으로 넘어가지 않는다.

## 전 실험 공통 중단 조건

아래 여섯 개는 순서까지 고정이며, 실험별 조건보다 먼저 적용된다.

1. 어느 meter든 누적 델타가 계획 상한 또는 누적 상한에 닿으면 그 계획을 중단한다.
2. 관측 창 안에 리셋 또는 rollover 경계가 들어오면 그 창을 무효로 한다. 창을 이어 붙이지 않는다.
3. 창 안에 계정의 다른 요청(두 번째 omo 세션, 백그라운드 워커, 사용자)이 있으면 다음 단계 전에 중단한다.
4. HTTP 401/403/429, `stop_reason: refusal`, 또는 모델 fallback(응답 model에 `claude-fable-5-1`이 그대로 오지 않음)이 나오면 멈춘다. 자동 재시도하지 않고, 이후 cache 상태는 unknown으로 취급한다.
5. 단계 후 60분이 지나도 게이지가 안정되지 않으면 그 단계는 귀속 불가(unattributed)로 남긴다.
6. `scripts/idle-experiments.mjs`에 있는 각 계획 자체의 `stopConditions`.

## 실행 전제

- 별도 검토된 runner가 필요하다. request adapter와 scheduler를 갖춘 runner는 이 제안의 범위 밖이고, 현재 저장소에는 없다. `node scripts/idle-experiments.mjs --execute`는 지금도 exit 2이고, 서명 후에도 그대로다.
- 실험 기간 동안 계정을 독점 사용한다.
- 프롬프트는 자연문으로 쓴다. Fable은 "reply with exactly" 같은 명령형 단문을 거부하고, 거부는 fallback으로 이어진다(보고값(미검증)).
- cache-write 단계 하나가 5h tick 하나 이상이 되도록 크기를 잡는다. fable-5-1의 1h 쓰기 기준 약 119K 토큰이 한 tick이라는 보고값(미검증)을 출발점으로 쓰되, 실측으로 확인되기 전까지는 추정으로만 다룬다. 0.01 게이지가 쓰기를 볼 수 있어야 하기 때문이다.
- 게이지 원시 timestamp를 모두 기록하고, 리셋 없는 단일 요청 창 안에서만 귀속한다.

## 성공과 비교 방법

- 비교는 같은 작업, 같은 복원 범위, 같은 완료 종점에서만 한다. "첫 실질 작업"은 작업이 정한 편집, 명령, 검증이고, 첫 응답이나 첫 tool call이 아니다.
- meter별 총 quota, resume delay, 품질 이벤트를 각각 따로 보고한다. 셋을 하나의 점수로 합치지 않는다.
- 계수는 리셋 없는 단일 요청 창 두 번에서 재현될 때 인정한다(`minimumEvidenceForEnforcement`). `policy-effect`는 쌍 run 세 번이다.
- 한 쌍의 run은 일반 절감 주장이 아니다. 결과는 조건부 관측으로 기록하고, 정책 변경 근거로 쓰려면 다시 별도 승인을 받는다.
- 이 문서는 어떤 계수나 절감치도 측정된 값으로 제시하지 않는다.

## 모르는 것

- Fable 쓰기 블록의 tick 귀속: H6(6틱)과 H8(8틱) 두 가설이 모두 살아 있다.
- 출력 계수 `k_output`: 미식별(`null`, 0이 아님).
- 복원 비용 `Rw=6K`, `Rr=125K`: `reported_unverified`, phase별 실측 분해 없음.
- meter 읽기 자체의 비용: `unknown`. 이 제안도 0이라고 가정하지 않는다.
- 7d tick 대 5h tick 비율 5.7: 보고값(미검증). 7d 누적 상한이 이 값에 의존하므로 실측 후 갱신한다.
- 한 tick의 쓰기 토큰 수 약 119K: 보고값(미검증).
- 절감 여부와 크기: 모른다.

## 서명 절차

1. 이 문서와 JSON을 읽고, 바꿀 값이 있으면 JSON을 먼저 고친다.
2. 사용자가 서명하면 JSON의 `status`를 `approved`로 바꾸는 별도 커밋을 만든다. 같은 커밋에서 `approvedAt`(서명 시각, ISO 8601)과 `approvalExpiresAt`(서명 시각 + 30일)을 채운다. 이 커밋은 사용자만 만든다.
3. 만료는 30일이다. 만료 후에는 `stale_budget_approval`로 검증기가 거부하므로 새 서명이 필요하다.
4. 서명은 조건표에 대한 것이다. runner는 별도 검토를 통과해야 첫 요청을 낼 수 있다.

이 문서가 존재한다는 사실, 그리고 값이 채워져 있다는 사실은 승인이 아니다.

## 롤백

없다. 이 제안은 아무것도 실행하지 않고 어떤 설정도 바꾸지 않는다. 서명 후에 되돌리려면
JSON의 `status`를 `proposed`로 돌리고 두 시각 필드를 `null`로 비우는 커밋 하나로 끝난다.
