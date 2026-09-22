# Idle 비용 shadow: 근거와 한계 보고

**결론 한 문장:** 원시 usage 재집계, 비용·시간 모델 보완, 기록 전용 shadow 연동,
오프라인 실험 계획·재생기까지 로컬에서 완료했고, 실제 운영 정책은 바뀌지
않았다(`idleCostMode` 기본 `off`, `enforce` 없음, 실제 요청 0건).

목표는 같은 작업을 제대로 완료한다는 조건에서 유휴 시작부터 작업 완료까지의
총 quota 낭비를 줄이는 것이다. 비용에는 데우기, 부모 handoff 생성, 후속 복원,
복귀 후 본 작업이 들어가고, 돌아오지 않은 작업에서 이미 발생한 비용도
포함한다. 품질 손실과 복귀 지연은 비용과 합산하지 않는 별도 승인 조건이다.

## 작업 상태

| 작업 | 상태 | 근거 파일·명령·결과 | 남은 조건 |
|---|---|---|---|
| 계수·복원 집계 | 완료(범위 내) | `scripts/quota-analysis.mjs`, `docs/idle-cost-evidence.md`/`.json`. `node scripts/quota-analysis.mjs <raw.jsonl> --json` 재현 가능 | 확정된 OAuth quota 점계수 없음; 조건부 관측 범위만 보존. H6/H8 미해결, 출력·복원 미측정 |
| 비용·시간 모델 보완 | 완료 | `extension/rollover.ts`의 `idle-cost-engine/1.0.0`(`convertUsage`, `cacheStateAtArrival`, `planIdle`, `evaluateIdleCost` 등), `test/idle-cost.test.mjs` | 실제 계수·예측이 들어올 어댑터 없음 |
| shadow 연동 | 완료(기록 전용) | `idleCostMode: "shadow"`, `idle_cost_shadow`/`idle_shadow_error` 이벤트, `test/idle-shadow.test.mjs` | 호스트가 `observeTaskEnd`를 자동 호출하지 않음. 검증된 요청/prefix 근거 공급자 없음 |
| 오프라인 실험 계획 | 완료(계획만) | `scripts/idle-experiments.mjs`, `docs/idle-experiments.md`. `--execute`는 항상 exit 2 | 다섯 승인 설정 모두 `unconfigured`. 실제 실행은 별도 승인 필요 |
| 오프라인 재생 | 완료 | `scripts/idle-replay.mjs`, `docs/idle-shadow-sample.json`, `test/idle-replay.test.mjs` | 로그에 없는 시나리오 재계산은 명시적 입력 필요 |
| 회귀·독립 검증 | F1 통과, 최종 F2 미승인 | 캡처된 최종 F1 결과: `npm test`(`node --test "test/*.mjs"`) 284/284 통과, 원본 참조 테스트는 격리된 CommonJS fixture에서 30/30 통과 | 이후 변경의 최신 전체 스위트 결과는 최종 전달에서 별도 확인. 실측 절감은 입증되지 않음 |
| 실제 실험·배포 | 미실행 | 승인된 요청 없음. enforce 모드 없음 | 아래 승인 표의 항목들 |
| 실측 승인안 | 제안(미승인) | docs/idle-experiments-approval-proposal.md/.json, test/idle-experiments-approval.test.mjs | 사용자 서명, 별도 검토된 runner |

## 수치로 확인된 결과

원시 캡처(`quota-test/2026-09-19/raw.jsonl`, 603행)를 재집계했다. 299개의
`/v1/messages` 응답에서 usage를 얻었고 나머지 304행에는 집계 가능한 모델 usage가 없다.
중복 0, usage 충돌 0, malformed 0.

| 필드 | 토큰 |
|---|---|
| `uncachedInput` | 4,122 |
| `cacheWrite5m` | 4 |
| `cacheWrite1h` | 9,395,995 |
| `cacheRead` | 20,555,717 |
| `billedModelOutput` | 2,840 |

quota meter는 세 개(`unified-5h`, `unified-7d`, `unified-7d_oi`)이고 각각
독립된 제한 창이라 하나의 스칼라로 합치지 않았다. utilization은 0.01
단위로만 공개되므로 계수는 점 추정 없이 quantization 범위로만 남겼다.
CLI의 `costUSD`에서 역산한 USD 단가는 `reported_unverified` 회계 기준이지
공식 가격표도, 실제 quota meter 측정도 아니다.

수학 fixture(AGENT_TASK 8절)는 엔진에서 재현됐다: PARK 27,350,
KEEP_WARM 24,075, K=126,375 변형 21,712.5(쓰기 환산 토큰). 이 값들은
회귀용 수학 입력이지 실측 절감이 아니다.

## 현재 모르는 것

- Fable 쓰기 블록의 tick 귀속: H6(6틱)과 H8(8틱) 두 가설이 모두 살아 있다.
  게이지 지연과 동일 계정의 관측 불가능한 동시 사용을 이 캡처로는 배제할 수
  없다.
- 출력 계수 `k_output`: 출력 블록이 출력 위주 시행 전에 끝나 미식별
  (`null`, 0이 아님).
- 복원 비용: 이전 추정치 `Rw=6K`, `Rr=125K`는 `reported_unverified`로만
  남고 phase별 실측 분해가 없다.
- 시스템·스킬 중복: phase 귀속 없이는 분리 불가.
- 거부된 요청의 청구 여부: 게이지가 요청 단위로 읽히지 않아 불확실.
- meter 읽기 자체의 비용: 이 저장소에 근거가 없어 모든 계획이
  `observationCost: "unknown"`을 달고, 0이라고 주장하는 계획은 거부된다.
- 복귀 예측: 보정된 예측이 없으면 shadow는 `no_calibrated_forecast`를
  기록하고 후보 비용은 `null`이다. 임의의 q를 넣지 않는다.

## 다음에 승인받아야 할 실행

다섯 계획 모두 dry-run이며, 승인 설정 다섯 개(`maxProactiveSpendPerIdle`,
`maxTotalExperimentalSpend`, `maxResumeDelay`, `allowedQualityDegradation`,
`minimumEvidenceForEnforcement`)는 전부 `unconfigured`다. `unconfigured`는
0도 아니고 무제한도 아니다. 전부 승인되더라도 계획상 유료 요청 62건과
관측 30회이고, 관측 비용 자체가 미지다. 아무것도 이 저장소에서 발행할 수
없다.

| 실험 | 측정 항목 | 호출 계획 | 예산 단위·상한 | 중단 조건 | 미실행 시 영향 |
|---|---|---|---|---|---|
| output-quota | 입력/읽기/쓰기 고정 후 `k_output` | 12 유료 + 6 게이지 | 지출 단위로 승인된 상한 필요. 현재 `unconfigured` | quota 리셋, 출력 절단/거부, 동시 계정 사용 | `k_output` 미지 유지, 출력 측 절감 주장 불가 |
| fable-write-tick | Fable 쓰기당 tick, 1h/5m 분리 | 2 유료 + 12 게이지 | 게이지와 같은 meter의 지출 상한 | 창 내 다른 요청, 리셋 경계, t+60분에 게이지 미안정 | 6/8틱 문제 미해결, 쓰기 계수 "측정" 불가 |
| ttl-1h-unique-prefix | t+55분 핑이 1h TTL을 갱신하는지 | 5 유료 + 4 게이지 | 5회 유료 호출을 포함하는 상한 | 계획 외 요청, 시간 창 이탈, lane/모델 변경, 단계 실패 | TTL 갱신 불확실 유지, warm/cold/uncertain 3상태 유지 |
| restore-decomposition | phase별 실제 read/write/output과 복원 종료점 | 19 유료 + 4 게이지 | meter별 상한 | 상한 초과, phase 경계 누락, 작업 범위 발산 | `Rw`/`Rr` 미검증 유지 |
| policy-effect | 총 quota, 재개 지연, 품질 결과 | 24 유료 + 4 게이지 | 다섯 설정 전부 필요 | 작업 범위 발산, 품질 가드 발동, 라이브 정책 변경 | 정책 비교 미측정, shadow는 기록 전용 유지 |

## 재현 명령

```sh
npm test                                                            # node --test "test/*.mjs"
node scripts/quota-analysis.mjs <raw.jsonl> --json                  # 집계 재현
node scripts/idle-experiments.mjs                                   # 5개 계획 dry-run
node scripts/idle-experiments.mjs --execute                         # 거부, exit 2
node scripts/idle-replay.mjs --sample                               # 샘플 재생
node scripts/idle-replay.mjs events.jsonl [--scenario inputs.json]  # 기록 재생
```

Windows의 Node 24는 `node --test test/` 같은 베어 디렉터리 인자를
MODULE_NOT_FOUND로 거부하고, 범위 없는 탐색은 호환되지 않는 번들 fixture를
집어들이므로 `npm test`는 `node --test "test/*.mjs"`로 고정했다. 원본 참조
테스트 30개(`references/v1/tests/cache-policy.test.cjs`)는 CommonJS라 이
스위트에 섞이지 않고 격리 fixture에서 별도로 통과했다.

## 롤백

기본값이 `off`이므로 아무것도 하지 않으면 된다. `idleCostMode`를 지우거나
`off`로 두면 shadow 기록이 멈추고 운영 동작은 처음부터 끝까지 동일하다.
