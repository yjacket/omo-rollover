**OMO 세션 사후 분석 — 2026-09-14**

대상: `01a09716-f93f-7c11-829f-d94f423bec60`, `C:/dev/searchad`의 Stage 11 월간 보고서 작업.
분석은 원본 메인 JSONL, 직접 자식 24개의 task metadata와 transcript, usage snapshot, 계획·ledger·리뷰를 대조했다. 제품 테스트를 다시 실행하거나 제품·기존 실행 상태를 수정하지 않았다. 아래 리뷰 재현 결과는 당시 증거이며 현재 코드를 재검증한 결과가 아니다.

**판단**

장기화의 중심은 Todo 7/8의 파일시스템·트랜잭션 경계 결함을 여러 차례 부분 수정한 것이다. 여기에 광범위한 검증과 증거 작성 반복, 늘어나는 메인 컨텍스트, 공급자 장애 대응 실수, 도구 활성화/재개 실패가 겹쳤다. 독립 리뷰는 실제 결함을 찾아냈으므로 리뷰 자체를 없애는 처방은 맞지 않는다. 같은 불변조건을 관련 경로 전체에 적용하는 설계와 검증이 늦었다.

마지막에는 제품 작업뿐 아니라 사용자가 요청한 handoff 파일 저장도 실패했다. 따라서 이 세션의 문제는 속도와 사용량에 더해, 실패 시 상태를 확실히 보존하는 종료 절차의 신뢰성 문제다.

**성과와 실패를 분리한 집계**

| 항목 | 확인 결과 |
|---|---|
| 사용량 집계 구간 | 2026-09-13 11:37:58–21:41:50 KST, 10시간 3분 52초 |
| 계획 진척 | 6/16 → 8/16. Todo 7·9 확정, Todo 8 Fix4 부분 구현 후 중단 |
| 직접 자식 task ID | 24개: metadata `completed` 19개, `error` 5개 |
| usage-stats의 task 합계 | 26회. 같은 task ID에서 재개한 Todo 7 Fix7과 Todo 9 Fix1이 별도 실행으로 집계됨 |
| 독립 검증/리뷰 | 9회: 반려 7회, 확인 2회 |
| 공급자 오류 | 사용량 제한 2회, OAuth 폐기/전체 계정 차단 3회 |
| 별도 산출물 미완료 | `completed`로 끝난 ledger scribe와 GPT handoff 작업 각 1개는 도구 부재로 아무 파일도 쓰지 못함 |
| 최종 handoff | 파일 갱신 실패. 채팅에 successor 프롬프트만 출력 |

`completed`는 작업 실행이 끝났다는 상태다. 산출물 성공이나 리뷰 승인과 같지 않다. 반려한 리뷰어는 맡은 일을 성공적으로 수행한 것이므로 이들을 모델 실행 실패로 세면 원인이 흐려진다.

**시간대별 병목 — 모두 9월 13일 KST**

| 시간 | 사건과 해석 |
|---|---|
| 11:40–13:18 | Todo 7 Fix5 검증 → 반려 → Fix6 → 반려 → Fix7 → 확인. 약 98분 |
| 13:20–14:33 | Todo 8·9 병렬 시작. Todo 9는 1회 수정 후 확인 |
| 13:20–19:45 | Todo 8 최초 구현과 Fix1–Fix4 진행. 이 구간에는 아래 대기·정체가 포함됨 |
| 15:52–16:51 | Claude 사용량 제한으로 약 59분 뒤 재투입. 첫 재시도는 잘못된 reset 시각 때문에 실패 |
| 17:47–18:14 | Fix2 리뷰 반려 이후 새 구현자 없이 약 27분간 기록상 진행 공백. 사용자가 “막힌 거 같은데”라고 보낸 뒤 재개 |
| 18:17–19:09 | Todo 8 Fix3 구현 52분. 이후 리뷰에서 다시 반려 |
| 19:45–20:18 | Fix4 OAuth 폐기 → 같은 공급자 재시도 실패 → 재인증 질문 30분 대기 |
| 20:18–21:29 | 차단 보고 후 다음 사용자 메시지까지 약 71분. 이 구간은 능동 작업 시간이 아님 |
| 21:29–21:41 | handoff 요청 처리. 차단된 Claude writer, GPT writer, 메인 patch 시도 모두 파일 저장에 실패 |

10시간 전부를 모델이 계산하거나 코딩한 시간으로 해석하면 안 된다. 특히 사용자 입력 대기 약 71분, 재인증 질문 대기 30분, rate-limit 회복 약 59분이 포함된다. 각 행은 일부 겹치므로 합산하지 않는다.

17:47의 진행 공백 직전에는 `devin/swe-2-high` 모델 전환 거절도 있었다. 로그만으로 UI 조작이나 스케줄러 내부 원인까지 확정할 수는 없다. 다만 진행 가능한 수정이 남았는데 live worker 없이 멈췄고, 사용자의 재촉 이후 실제 dispatch가 이루어진 것은 확인된다.

**1. 같은 종류의 결함을 경로별로 뒤늦게 수정했다 — 가장 큰 재작업 원인**

Todo 7은 단순한 파일 저장을 넘어 Windows 핸들 공유 모드, 디렉터리 엔트리 변경, publication proof 시점과 실패 후 회수 문제로 진행됐다.

- Fix5: 같은 이름 PDF 바꿔치기를 받아들이고, 회수할 이름이 충돌하면 partial final이 남는 문제가 재현됐다.
- Fix6: 그 문제를 고쳤지만 파일을 읽고 닫은 뒤의 변경, 디렉터리 열거 이후 엔트리 추가를 놓쳤다.
- Fix7: 파일들을 함께 잠근 동안 내용을 검증하고 마지막에 membership을 관측하는 방식으로 수정했다. 검증자는 작업 내부 경쟁과 publication 이후 변조의 경계를 구분한 뒤 승인했다.

Todo 8도 유사하다.

- 최초 구현: 물리 DBAPI commit 실패 뒤 audit 기록이 실패한 작업까지 commit할 수 있음, corrupt DRAFT 복구 불능, audit 실패 은폐, 유효한 winner 덮어쓰기, 추가 skip 등의 반려.
- Fix1: 복구 중 status 변경, 교체된 정상 bundle 잘못 처리, commit과 invalidate의 복합 실패가 남음.
- Fix2: 일부 예외 종류만 처리해서 원래 오류를 잃고, 오류 note에 임의 메시지를 넣음. POSIX에서는 열린 descriptor가 아니라 바뀔 수 있는 이름을 rename 대상으로 사용.
- Fix3: 예외 보존과 repair 경로를 고쳤지만 detach callback 실패 시 close를 실행하지 않음. POSIX publication take-back 경로는 여전히 이전 rename을 호출.

Fix3 리뷰는 실제 SQLAlchemy detach 이벤트를 이용해 SQLite 연결과 write lock이 남는 것을 재현했다. 기존 테스트는 fixture가 대신 연결을 닫은 뒤 검사해서 제품의 cleanup 실패를 가렸다. 다른 테스트도 예외 타입만 검사하고 동일 객체인지는 검사하지 않았다.

즉 “테스트가 많으니 완료”라고 판단할 수 없는 상황이었다. 필요한 것은 실패 경계 전체의 모델이었다: commit → invalidate → detach → close 각각의 실패 조합, publication/repair/withdrawal 전체 호출 경로, Windows와 POSIX의 실제 보장 차이. 이를 처음부터 정리하지 않아 후속 리뷰가 그 역할을 반복 수행했다.

근거: [Fix2 리뷰](C:/dev/searchad/.omo/review/stage11-todo8-fix2.md), [Fix3 리뷰](C:/dev/searchad/.omo/review/stage11-todo8-fix3.md), [Todo 7 Fix7 검증](C:/dev/searchad-evidence/stage11/wave3a/task-7-adversarial-verify-fix7.md).

**2. 검증·정책을 적용하는 비용이 매 수정마다 커졌다**

Fix3 한 작업은 124턴, 190 tool calls, 약 3,753만 토큰, 52.1분이었다. 결과에는 full 1,977 passed/1 skip, 관련 632, store 184, lifecycle 60, Windows QA 259개, POSIX QA 60개 검사가 포함됐고, 별도 리뷰가 이어졌다. 이 수치들은 중복 범위가 있어 고유 테스트 수로 합산하면 안 된다.

검증 실행 자체보다 테스트·QA driver·baseline·hash·receipt를 만들고 해석하는 비용도 컸다. 이미 Todo 7이 확인된 뒤 Todo 8 수정에서 store와 session까지 다시 바뀌어 검증 범위가 계속 넓어졌다. 역할별 분담은 했지만 검증된 모듈의 경계가 안정되지 않았다.

250 pure LOC 규칙은 실제 blocker로 적용됐다. Fix3에서 테스트 파일이 793 → 605 LOC로 줄었어도 기준을 충족하지 않아 Fix4에서 다시 분할했다. 기존 규칙을 따른 반려이므로 리뷰어의 임의 요구라고 볼 수는 없다. 다만 이런 기계적 기준은 구현 완료 직전에 자동 확인했어야 하며, 10여 분의 독립 리뷰를 돌린 뒤 발견할 이유가 없다.

원 계획은 경로 이탈·symlink·변조와 실패 보존을 요구했다. 따라서 모든 공격적 검증을 무단 범위 확장이라고 할 수는 없다. 그러나 동시 로컬 변조자의 권한, 지원 OS별 exact-object 보장, publication 완료 시점은 계획에서 충분히 구체화되지 않았고 실행 중에 정해졌다. POSIX의 안전한 거절을 허용하는 결정도 뒤늦었다.

**3. 컨텍스트 누적이 실제 운영 제약으로 이어졌다**

원본 child transcript의 usage 합계 207,822,764 + main 52,627,253 = 제공된 총계 260,450,017과 정확히 일치했다. 이번 분석에서 중복 집계 버그의 증거는 찾지 못했다.

- cache read: 250,062,783 tokens, 전체의 **96.01%**.
- 일반 input: 6,033,783; cache write: 2,757,490; output: 1,595,961.
- 제공된 CHILD 출력에서 빠진 Claude cache-write 2,757,490이 `total`에는 포함돼 있다.
- 이는 반복 요청을 합한 처리량이다. 2.6억 개의 새로운 컨텍스트나 실제 청구액을 뜻하지 않는다.
- 메인 요청의 `input + cacheRead`는 첫 28,083에서 마지막 449,125까지 증가했다. 평균은 약 272,162이다.
- 메인 JSONL에는 `compaction` 이벤트가 없다. 일부 child에는 존재한다.
- 메인의 직접 read와 eval 내부 read를 집계하면 ledger 52회, plan 47회, boulder 14회다. 모두 전문 읽기는 아니며 상당수는 부분 읽기다.
- `omo-senpi:wake` 33개, `goal-continuation` 7개가 있다. cache-warmup 32개는 scheduled 25/resumed 7로, 이를 32회 별도 모델 호출이라고 해석하면 안 된다.
- Fix3 spawn prompt 54,182자 중 programming/debugging skill 본문이 50,446자, **93.1%**다. 여기에는 추가 언어·방법론 문서를 읽으라는 요구도 있다. 이는 전체 모델 입력 중 비율이 아니라 spawn prompt 문자열의 비율이다.

17:47 모델 전환은 `context-budget`으로 실제 거절됐다. 당시 live context 330,619, reserve 등을 포함한 요구량 464,291, 대상 window 262,000이었다. 컨텍스트 누적이 단순히 토큰 통계만 크게 만든 것이 아니라 복구 선택지까지 제한한 사례다.

근거: [usage snapshot](C:/Users/yjack/.omo/agent/usage-stats/01a09716-f93f-7c11-829f-d94f423bec60.json), [메인 로그의 모델 전환 거절](C:/Users/yjack/.omo/agent/sessions/--C--dev-searchad--/2026-09-12T19-27-40-351Z_01a09716-f93f-7c11-829f-d94f423bec60.jsonl:415), [Fix3 task](C:/dev/searchad/.omo/senpi-task/tasks/st_01a09a0e.json).

**4. 공급자 장애 자체와 대응 실수가 함께 있었다**

| Task | 실패 |
|---|---|
| `st_01a09977` | 작업 20.3분 후 Claude session limit |
| `st_01a0998c` | 재시도 1.1분, tool 0, 같은 limit |
| `st_01a09a4a` | Fix4 작업 22.9분 후 OAuth revoked 401; 부분 수정은 남음 |
| `st_01a09a60` | 1.0분, tool 0, 전체 Claude 계정 차단 |
| `st_01a09ac0` | handoff writer 1.0분, tool 0, 같은 계정 차단 |

첫 limit 메시지는 16:50 KST reset을 명시했다. 그런데 메인은 monitor target을 이미 지난 `06:52:30Z`로 설정했다. monitor는 바로 READY를 냈고, 메인은 이를 reset 완료로 받아들여 실패할 재시도를 했다. timeout도 처음에 최대 3,600,000ms를 넘는 7,200,000ms를 넣었다가 거절됐다. 이후 올바른 reset 시각으로 수정했다.

인증이 폐기된 뒤 handoff를 다시 Claude writing category에 보낸 것도 불필요한 실패였다. category는 달라도 같은 공급자 인증을 공유한다. 구현 fallback은 당시 메인이 정책상 금지됐다고 보고했으므로 임의 모델 전환을 못 한 것 자체를 잘못이라고 단정하지 않는다. 문제는 장애 상태를 공급자 전체에 적용하지 못하고 실행 가능성을 확인하기 전에 “작업 중”이라고 보고한 점이다.

토큰 폐기의 외부 원인, 계정 상태, 모델별 일반 성능 우열은 로그만으로 확정할 수 없다. Opus는 구현, GPT는 리뷰를 맡았으므로 이 한 세션으로 모델 성능을 직접 비교할 수도 없다.

근거: [잘못된 monitor target](C:/Users/yjack/.omo/agent/sessions/--C--dev-searchad--/2026-09-12T19-27-40-351Z_01a09716-f93f-7c11-829f-d94f423bec60.jsonl:310), [실패 task 기록](C:/dev/searchad/.omo/senpi-task/tasks/st_01a09a60.json).

**5. 재개와 도구 가용성이 불안정했고 handoff까지 막았다**

완료한 구현자에게 수정 요청을 보내려 했지만 이미 evicted라 새 task로 바뀐 사례가 Todo 8 Fix1과 Fix3에 있다. 재사용할 컨텍스트가 사라져 새 구현자는 skill·계획·이전 증거·현재 변경을 다시 읽었다. 재개 가능한 상태와 최종 완료 상태를 검증 루프에 맞게 유지하지 못했다.

후반에는 더 직접적인 도구 장애가 나타났다.

- Fix4 ledger scribe: `apply_patch`가 없어 파일 수정 0, 하지만 task status는 completed.
- GPT handoff writer: 메인이 “apply_patch 없으면 대체 수단을 쓰지 말고 중단”이라고 명시. 도구 부재로 handoff/Boulder/ledger 수정 0.
- 메인: tool_search는 apply_patch를 찾지 못했지만 Python tool_schema에는 등록 정보가 보임.
- 실제 호출은 `stale extension generation after reload`; 다른 탐색 도구도 registered but inactive.
- 마지막에는 prepared patch를 채팅으로 출력했으나 파일에 적용하지 못함.

확인 가능한 것은 도구 등록·활성화·실행 세대 사이의 불일치다. 어떤 extension 코드나 설정 변경이 이를 일으켰는지는 추가 소스 분석 없이는 확정할 수 없다. 단순히 모델이 파일 쓰기 방법을 몰랐던 상황은 아니다. 메인에게 허용된 상태 문서까지 특정 도구 하나에 묶어 둔 지시가 복구를 더 어렵게 했다.

현재 읽은 durable 파일도 최종 응답과 일치한다: handoff는 Fix5/6-of-16 시점 문서, Boulder는 active, ledger 마지막은 Fix3 code-review dispatch다. 계획은 8/16이다. 다음 세션이 이 파일을 모두 “유일한 진실”로 읽으면 서로 다른 시점이 충돌한다.

근거: [GPT handoff 실패와 명시적 도구 제한](C:/dev/searchad/.omo/senpi-task/tasks/st_01a09ac1.json), [실패한 최종 patch](C:/Users/yjack/.omo/agent/sessions/--C--dev-searchad--/2026-09-12T19-27-40-351Z_01a09716-f93f-7c11-829f-d94f423bec60.jsonl:568), [기존 handoff](C:/dev/searchad/.omo/ulw-execute/stage11-monthly-reports-handoff.md).

**재발 방지 우선순위 — 이 분석에서 설정이나 구현을 변경하지는 않았다**

1. **먼저 종료·복구 경로를 보장한다.** dispatch 전에 필요한 도구가 실제 호출 가능한지 확인하고, reload 후 오래된 도구 참조를 갱신한다. 상태 문서 저장은 메인이 직접 수행할 수 있게 하며, 허용된 대체 저장 경로를 둔다. task terminal 상태와 별도로 산출물 검증 결과를 기록한다.
2. **공급자 전체에 장애 상태를 공유한다.** rate-limit은 구조화된 retry 시각으로 한 번 예약하고, revoked auth는 인증 갱신 전 같은 provider의 구현·writing 모두 중지한다. fallback 허용 여부는 시작 시 정한다. STARTED와 실제 첫 모델/tool 성공을 구분한다.
3. **두 번 반려되면 수정 반복을 잠시 멈추고 공통 원인을 재설계한다.** 횟수를 넘었다고 승인하거나 작업을 포기하라는 뜻이 아니다. 트랜잭션 cleanup 전체 실패 조합과 store 전체 호출 경로를 한 번에 표로 만들고, OS별 가능한 보장과 안전한 거절 조건을 확정한다.
4. **테스트가 결함을 감추지 않도록 한다.** fixture cleanup 전 lock 상태를 검사하고 예외 객체 identity를 직접 비교한다. 재현된 회귀 테스트와 관련 호출자 검사를 먼저 통과시킨 다음 광범위 gate를 수행한다. LOC·lint 같은 기계적 반려 조건은 리뷰 dispatch 전에 검사한다.
5. **컨텍스트를 단계별로 정리한다.** 완료 wave/큰 remediation 경계에서 실제 handoff checkpoint 또는 compaction을 수행한다. 불변 skill 전문과 누적 ledger를 재주입하기보다 현재 계약·변경 delta·미해결 항목을 짧게 유지한다. 컨텍스트 한계는 현재 모델뿐 아니라 예정된 fallback도 기준으로 삼는다.
6. **검증자 반환까지 구현자 재개 가능성을 유지한다.** 같은 작업의 빠른 수정을 위해 reviewer가 돌아오기 전 eviction을 피하거나, 정확한 hash·diff·미해결 항목만 담은 작은 복구 패키지를 남긴다.
7. **진행 지표를 산출물 기준으로 바꾼다.** 벽시계 시간, 모델 실행 시간, 공급자/사용자 대기, 리뷰 반려 횟수, 새 입력/cache read, 산출물 실패를 분리한다. live worker도 외부 대기도 없이 다음 행동이 남은 경우에는 정체로 탐지한다.

사용자는 14:27에 이번 wave 완료 후 handoff를 요청했고 “강제 완료가 아니라 완료될 때까지 기다리라”고 명시했다. 미완료를 억지로 승인하지 않은 판단은 맞았다. 개선할 지점은 그 조건을 충족하는 과정의 재작업·복구 비용과, 조건을 못 충족했을 때조차 handoff를 저장하지 못한 실행 구조다.

**추가 추적: 최초 계획에서 상세 계획으로 넘어간 경계**

- 최초 승인 build plan `9d2df84`를 직접 확인했다. 12단계 순서 외에 모듈 배치, 기술 선택, 위험, 검증, 의존성도 있었지만 Stage 11 자체는 “수치는 DB 집계, 문장만 Gemini, Markdown + PDF, 컨펌·송부 상태” 한 줄이다. 모든 단계의 상세 설계를 처음부터 작성한 구조는 아니다.
- 최초 spec에는 `monthly_report(tenant_id, month, md_path, pdf_path, status)`가 있다. 따라서 파일 저장 방향 자체는 처음부터 있었으며 전적으로 실행자가 만들어낸 것은 아니다. 그러나 content-addressed manifest, Windows native handle, POSIX exact-object withdrawal은 그 초기 요구에 없다.
- Stage 11 계획 세션 `01a0926e-31be-77e9-bb49-af55b07a6952`의 첫 user message(JSONL 10행)는 이미 더 상세한 인수인계형 요청이다. “Markdown 파일 경로와 DB 레코드를 원자적으로”, “기존 monthly_report 스키마 우선”, “DB 변경은 사용자 승인 없이 하지 말라”가 명시돼 있다. 원자성 요구 자체가 모델의 자의적 추가였다고 단정하면 틀린다. 이 메시지가 누구에 의해 초안 작성됐는지는 이번 추적에서 확인하지 않았다.
- 그 요청은 스키마 변경을 승인받을 수 있는 여지를 남겼다. Stage 11 상세 계획은 이를 “No table, column, index, enum, relationship, or Alembic change”라는 절대 제외로 구체화했다. DB 본문/바이너리 저장을 대안으로 비교한 기록은 확인한 planning transcript에서 찾지 못했다.
- planning draft에는 전용 report root를 owner가 선택했다고 기록돼 있다. 저장 위치 선택은 로컬 악성 프로세스의 동시 바꿔치기 방어까지 요청했다는 근거가 아니다.
- 따라서 확인된 문제 지점은 초기 로드맵 자체보다 상세 설계에서의 복잡도·대안 비교 부족, 그리고 실행 중 위협 모델 확대를 제품 요구에 다시 대조하지 않은 점이다. 기존 파일 저장 설계를 유지할 때의 비용이 커졌다면 DB 저장을 포함한 단순한 대안을 구체적으로 제시할 기회가 있었다.
- 나머지 stage가 잘못됐다고 아직 판정할 증거는 없다. 전 단계 점검은 원래 요구 → 추가 설계 → 실제 구현 → 핵심 사용자 시나리오를 연결해 불필요한 복잡도와 실제 정확성을 구분하는 방식이어야 한다. 모든 stage의 기존 대규모 gate를 그대로 반복하는 것은 이번 실패 패턴을 재생산할 수 있다.
