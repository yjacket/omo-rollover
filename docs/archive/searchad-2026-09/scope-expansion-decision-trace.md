**보고서 저장 요구가 확대된 최초 판단 추적 — 2026-09-14**

**결론**

이번에 확인한 명시적 전환 지점은 2026-09-12 Todo 7의 구현·검증 지시 작성이다. 메인 `gpt-5.6-sol`이 계획의 경로 이탈·변조 검증을 동작 중 root/parent/attempt를 교체하는 공격에 대한 보장으로 확대했고, 검증 배정에서 hardlink까지 새 필수 조건으로 추가했다. 첫 구현자는 `gpt-5.6-sol:high`, 첫 gate reviewer는 `gpt-6-astra:high`였다. Opus 구현자와 Astra 리뷰어의 불일치가 최초 원인이라는 가설은 이 구간에 해당하지 않는다.

이는 특정 시점의 Sol 메인 응답에 대한 요구 해석·범위 판단 오류라는 근거다. Sol 일반의 성능 특성이나 모든 후속 결함의 원인을 증명하는 것은 아니다. 하네스 지시가 이러한 확장을 얼마나 유도했는지는 통제 실험 없이 분리할 수 없다.

**당시 요구와 정당한 검증 범위**

최초 spec은 단일 운영자·단일 호스트와 잡/웹 요청 동시성을 명시한다. Stage 11 요청은 파일·DB 상태 일치, 멱등성, 기존 결과 보존, 업체 격리를 요구한다. 초기 실행 세션에서 실제 읽은 Todo 7에는 manifest/hash, root-relative paths, root-local staging 후 atomic rename, traversal/symlink/tampering 거부, 실패 정리와 final 보존이 있었다.

이로부터 경로 조작, 손상된 파일, 정상 생성 요청 간 충돌, write/rename 실패를 검사하는 것은 충분히 정당하다. 반면 같은 호스트에서 보고서 디렉터리를 자유롭게 rename/mkdir/link할 수 있는 다른 프로세스가 정확한 I/O 경계에 개입한다는 위협의 존재·권한·운영 시나리오는 확인한 원래 요구에 없다.

근거: [단일 호스트 요구](C:/dev/searchad/spec.md:60), [실행 초기에 읽은 계획](C:/Users/yjack/.omo/agent/sessions/--C--dev-searchad--/2026-09-11T23-33-27-559Z_01a092d1-a386-7081-b4b9-871c57f81082.jsonl:22).

**1. 9월 12일 19:28 KST — Sol 메인이 구현 지시를 확대**

메인 로그 1398행, 모델 `gpt-5.6-sol`, Todo 7 최초 implementer 요청의 항목 9:

> No TOCTOU-oblivious `resolve` followed by unsafe reopen: use the strongest pattern supported by current Python/Windows contracts and document residual platform assumptions; tests must exercise replacement/symlink adversarial seams deterministically where privileges permit.

이 문장은 단순 입력·경로 검증을 넘어 검사와 사용 사이의 교체까지 다루도록 했다. 다만 이때는 아직 “residual platform assumptions를 문서화”하라는 여지가 있었다. 이 최초 Opus 요청은 인증 차단으로 tool 실행 전에 실패했다.

19:30의 대체 요청(1421행)은 Sol high 구현자에게 전달됐다. 여기에도 `symlink/replacement escape`와 `symlink/TOCTOU seams`가 들어갔다. 20:00에 완료한 task `st_01a0952b`의 모델은 Sol high다.

근거: [최초 구현 지시](C:/Users/yjack/.omo/agent/sessions/--C--dev-searchad--/2026-09-11T23-33-27-559Z_01a092d1-a386-7081-b4b9-871c57f81082.jsonl:1398), [Sol 대체 구현 지시](C:/Users/yjack/.omo/agent/sessions/--C--dev-searchad--/2026-09-11T23-33-27-559Z_01a092d1-a386-7081-b4b9-871c57f81082.jsonl:1421), [실제 구현자 모델](C:/Users/yjack/.omo/agent/sessions/--C--dev-searchad--/2026-09-11T23-33-27-559Z_01a092d1-a386-7081-b4b9-871c57f81082.jsonl:1507).

**2. 20:02 KST — Sol 메인이 플랫폼 한계를 blocker로 지정**

1513행의 gate assignment 항목 5:

> Audit safe I/O against TOCTOU: realpath containment, root/parent/file replacement and symlink swaps between validation and open, stable handles/identity, link/reparse behavior on Windows, attempt/destination replacement. Reproduce deterministic replacement attacks without sleeps. If a platform primitive cannot guarantee a claimed invariant, report exact residual blocker.

항목 7에는 계획에 없던 `symlink/hardlink escape`가 추가됐다. 마지막 STOP CONDITION도 모든 `TOCTOU/failure/race invariant`를 입증해야 confirmed라고 했다.

바로 이 지시가 “검증에서 추가로 관찰할 수 있는 위험”을 “제품 완료를 막는 필수 조건”으로 승격시킨 가장 명확한 문서 증거다. root/parent/attempt를 임의 교체할 수 있는 행위자가 실제 배포 환경에서 누구인지, 기존 잡·웹 요청이 그런 동작을 하는지 판단한 기록은 이 지시 전에 확인되지 않았다.

근거: [Sol이 작성한 전체 gate assignment](C:/Users/yjack/.omo/agent/sessions/--C--dev-searchad--/2026-09-11T23-33-27-559Z_01a092d1-a386-7081-b4b9-871c57f81082.jsonl:1513).

**3. 20:14 KST — Astra는 늘어난 배정 조건에 따라 반려**

리뷰어 `st_01a09548`, `gpt-6-astra:high`는 다음을 실제 파일시스템 조작으로 재현했다.

- B1: 소유 attempt를 옮기고 그 자리에 다른 디렉터리를 만든 뒤 write 실패를 발생시키면 cleanup이 새 디렉터리를 삭제한다.
- B2: 검증 이후 `.work` 또는 month를 junction으로 바꾸면 root 밖으로 쓴다.
- B3: rename 직전에 attempt를 옮기고 foreign.txt만 가진 대체 디렉터리를 만들면 그것을 성공으로 publish한다.
- B4: 정상 publish 이후 보고서 파일의 hardlink를 root 밖에 직접 만들고 read가 성공하면 hardlink escape로 반려한다.
- B5: Windows에서 사용할 수 없는 일부 root 이름을 parsing이 받아들인다.

B1–B3은 지정된 공격자가 개입할 수 있다면 실제로 발생하는 결함이다. hook을 이용한 결정적 재현 자체도 잘못된 테스트 기법은 아니다. 그러나 재현은 그 공격자가 존재하고 해당 디렉터리를 교체할 권한이 있다는 전제하에서 성립한다. 그 전제가 이 제품의 필수 위협인지와는 별개의 문제다.

B4는 범위 확대가 특히 선명하다. 테스트 코드가 `os.link(root / reference.markdown_path, outside / 'external-hardlink.md')`를 실행한다. 애플리케이션이 사용자 입력 때문에 외부 경로를 열거나 쓴 것이 아니라, QA가 정상 파일의 외부 alias를 직접 만든 뒤 이를 거부하지 않는다고 판정했다. 단순 root-relative 경로 제한과 다른 보장이다.

리뷰어는 B4에서 다음과 같이 명시했다.

> The assignment explicitly names hardlink escape; this is not hypothetical hardening.

이는 Astra가 원래 제품 요구에서 그 조건을 독자적으로 도출했다기보다 Sol의 새 assignment를 필수 계약으로 사용했다는 직접 증거다. 리뷰어의 `userOutcomeReview`가 이를 “requested user outcome”이라고 부른 점은 원래 요구와 새 배정 조건의 구분을 흐렸다.

근거: [첫 gate 결과 및 재현 코드](C:/dev/searchad-evidence/stage11/wave3a/task-7-adversarial-verify.md:21), [실제 리뷰어 모델](C:/Users/yjack/.omo/agent/sessions/--C--dev-searchad--/2026-09-11T23-33-27-559Z_01a092d1-a386-7081-b4b9-871c57f81082.jsonl:1564).

**4. 20:16 이후 — 메인이 공격 가정을 재검토하지 않고 인수인계 요구로 고정**

1569행에서 메인은 B1–B3을 ledger의 완료 실패로 기록했다. 1574행 handoff prompt에는 세 공격을 failing-first로 고치고 새 독립 gate를 통과한 뒤 다음 Todo로 진행하라는 지시를 넣었다. 이 prompt는 다음 세션의 user message로 실제 전달됐다.

이후 에이전트에게는 이 세 공격이 명시적 사용자 입력에 포함된 요구가 됐다. 후속 Opus가 이 조건을 임의로 무시하기는 어려웠다. 최초 해석의 출처가 인수인계 과정에서 사라지고 요구만 강해진 것이다.

다만 메인이 모든 지적을 무조건 유지한 것은 아니다. 후속 fix2 리뷰는 B4 hardlink와 B5 root 이름을 명시적으로 범위 밖으로 둔다. 따라서 hardlink 하나 때문에 전체 Fix7까지 갔다고 말하면 틀리다. 장기화의 중심은 남겨진 B1–B3의 교체 공격에 대한 보장이었다.

근거: [handoff 생성](C:/Users/yjack/.omo/agent/sessions/--C--dev-searchad--/2026-09-11T23-33-27-559Z_01a092d1-a386-7081-b4b9-871c57f81082.jsonl:1574), [후속 범위 제한](C:/dev/searchad-evidence/stage11/wave3a/task-7-adversarial-verify-fix2.md:14).

**어떤 판단이 합리적이었고 어디가 잘못됐는가**

- 합리적: 기존 final 보존, 실제 실패 cleanup, tenant 격리, 경로 이탈·손상 방어, 정상 동시 생성의 일관성.
- 조건부로 합리적: 신뢰할 수 없는 프로세스가 저장 root를 변경할 수 있는 제품이라면 B1–B3을 막는 플랫폼별 설계와 QA.
- 근거가 부족한 승격: 단일 운영자·단일 호스트 제품에서 그 로컬 공격자를 별도 설명 없이 가정하고, OS가 완전한 보장을 못 하면 기능 완료를 막도록 한 것.
- 개별 구현 오류: 확대된 계약을 수용한 뒤 identity check만 넣고 직후의 교체를 막지 못한 수정들은 그 계약 기준으로 실제 불완전했다. 이를 전부 리뷰어의 억지로 치부할 수 없다.
- 최초 분기의 주요 책임: Sol 메인의 요구 해석과 gate 설계. Astra는 확대된 계약을 엄격히 수행했고, 원래 제품 요구와의 차이를 지적하지 못했다. Opus는 이 최초 분기에 실행된 구현자가 아니다.

당시 적절한 분기는 “애플리케이션만 저장 폴더를 변경한다는 운영 전제로 충분한가, 다른 로컬 writer가 실제로 존재하는가, 이 보장을 유지하려면 DB 저장 같은 단순한 대안이 더 나은가”를 먼저 판정하는 것이었다. 이번에는 그 판단 없이 플랫폼별 교체 방어를 필수 작업으로 만들었다.

이 문서는 기존 두 세션의 외부에 드러난 지시·도구 결과·산출물을 추적한 것이다. 내부 사고과정이나 모델 일반의 성향은 판정하지 않았다. 제품·설정·기존 ledger/handoff는 변경하지 않았다.
