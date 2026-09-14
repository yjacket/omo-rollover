# OMO 모델 라우팅 구성 비교

- 비교 기준: 2026-09-11
- 설치 버전: OMO `5.0.0-beta.53`, senpi `2026.9.10-2`
- 보유 구독: OpenAI Codex Pro x5, Claude Max x5
- 최후 안전망: GitHub Copilot Business

| 항목 | 이전 사용자 구성 | beta.53 내장 구성 | 제안 구성 |
|---|---|---|---|
| 전체 전략 | Codex를 메인으로 사용하고 모든 사용자 정의 자식 카테고리는 Claude를 먼저 사용 | 모델 프로필과 역할별 내장 체인으로 모델을 선택 | Codex Pro는 메인, Claude Max는 자식에 사용하고 GitHub는 최후 안전망으로 제한 |
| 메인 시작 모델 | `openai-codex/gpt-5.6-sol:xhigh`를 `settings.json` 기본값으로 사용 | `model_profile`은 기본 비활성 | 사용자 정의 `model_profile`로 Codex Sol xhigh → Claude Opus high → GitHub Sol high |
| 내장 `capable` 프로필 | 사용하지 않음 | Claude Fable 5.1 → Claude Opus 5 → Kimi K3 → GLM 5.3 | 사용하지 않음. Claude가 메인이 되어 Codex 메인·Claude 자식 분리가 사라짐 |
| 내장 `deep-work` 프로필 | 사용하지 않음 | GPT-6 Astra high → GPT-5.6 Sol medium | 사용하지 않음. 메인 오케스트레이터에는 Sol xhigh를 명시 |
| 모델 프로필 적용 범위 | 프로필이 없어 Senpi 기본 모델을 사용 | 새 세션 시작 때만 적용하며 재개·포크·명시 모델은 유지 | 새 메인 세션에만 적용하고 기존 세션과 재개 세션은 그대로 유지 |
| 프로필의 한도 인식 | 해당 없음 | 공급자와 모델의 등록 여부만 확인하며 남은 구독 한도는 확인하지 않음 | 시작 모델 선택에만 사용하고 실행 중 한도 초과는 별도 폴백으로 처리 |
| 메인 실행 중 폴백 | 실제 메인 Sol에는 폴백이 없고 사용하지 않는 Astra → Claude 체인만 존재 | `model_profile`은 실행 중 폴백을 제공하지 않으며 `retry.fallbackChains`가 별도로 필요 | Codex Sol → Claude Opus 한 단계만 자동 전환 |
| 메인 GitHub 실행 중 폴백 | 없음 | 사용자 `retry.fallbackChains` 설정에 따름 | 자동 체인에서 제외하고 두 구독이 모두 막히면 수동 전환 |
| `deep` 자식 | Claude Opus high → Codex Luna max | 내장 `deep` 체인은 GPT-6 Astra high → GPT-5.6 Sol medium | 검증된 기존 Claude Opus high → Codex Luna max 유지 |
| `ultrabrain` 자식 | Claude Opus xhigh → Codex Terra xhigh | GPT 계열 고추론 모델을 우선하는 내장 체인 | 기존 Claude Opus xhigh → Codex Terra xhigh 유지 |
| `architect` 자식 | Claude Opus high → Codex Sol medium | 역할별 내장 모델 체인 사용 | 기존 Claude Opus high → Codex Sol medium 유지 |
| `artistry` 자식 | Claude Opus high → Codex Terra xhigh | 역할별 내장 모델 체인 사용 | 기존 Claude Opus high → Codex Terra xhigh 유지 |
| `visual-engineering` 자식 | Claude Opus high → Codex Luna max | 역할별 내장 모델 체인 사용 | 기존 Claude Opus high → Codex Luna max 유지 |
| `unspecified-high` 자식 | Claude Opus high → Codex Luna max | 역할별 내장 모델 체인 사용 | 기존 Claude Opus high → Codex Luna max 유지 |
| `writing` 자식 | Claude Sonnet 5 → Codex Luna medium | 역할별 내장 모델 체인 사용 | 기존 Claude Sonnet 5 → Codex Luna medium 유지 |
| `quick` 자식 | Claude Haiku 4.5 → Codex Luna low | 역할별 내장 모델 체인 사용 | 기존 Claude Haiku 4.5 → Codex Luna low 유지 |
| `unspecified-low` 자식 | Claude Haiku 4.5 → Codex Luna max | 역할별 내장 모델 체인 사용 | 기존 Claude Haiku 4.5 → Codex Luna max 유지 |
| Claude 공급자 우선순위 | 모든 사용자 정의 카테고리가 `claude-sdk-oauth`를 직접 첫 번째로 지정 | Claude 모델을 사용하는 14개 내장 rung에서 Pro/Max 구독 레인을 미터제 공급자보다 우선 | 사용자 정의 체인을 유지해 Claude Max 우선을 고정 |
| 사용자 정의 카테고리 효과 | 사용자 배열이 내장 카테고리 배열을 대체 | 설정하지 않은 카테고리와 내장 에이전트만 beta.53 체인을 그대로 사용 | 사용자 카테고리를 유지해 향후 내장 체인 변경의 영향을 차단 |
| GitHub Copilot 위치 | 사용자 카테고리에는 없지만 설정하지 않은 내장 에이전트가 사용할 수 있음 | 일부 Claude 모델의 공급자 후보에 포함되며 전체 작업 체인의 마지막을 보장하지 않음 | 메인 시작 프로필의 세 번째 후보로만 두고 자식 사용자 체인에서는 제외 |
| 기본 자식 동시성 | 3 | 기본값 5 | 3 유지 |
| 전체 자식 동시성 | 4 | 기본값은 CPU 기준으로 결정되며 현재 사용자 제한보다 큼 | 4 유지 |
| Claude 자식 동시성 | 별도 설정이 없어 기본값 3 적용 | 별도 제한이 없으면 기본 lane 제한 적용 | `claude-sdk-oauth: 3`을 명시 |
| Codex 자식 동시성 | `openai-codex: 2` | 별도 제한이 없으면 기본 lane 제한 적용 | `openai-codex: 2` 유지 |
| GitHub 자식 동시성 | 별도 제한 없음 | 체인에 진입하면 기본 lane 제한까지 병렬 실행 가능 | `github-copilot: 1`을 명시 |
| 동시성 포화 시 동작 | 선호 lane이 차면 다음 사용자 모델로 넘어갈 수 있음 | 선호 모델이 실패하지 않아도 lane이 차면 다음 체인 항목으로 넘어갈 수 있음 | 전체 4, Claude 3, Codex 2를 유지해 GitHub로 병렬 확산되는 상황을 줄임 |
| Codex Pro x5 활용 | 메인 위주이며 자식에서는 Claude 실패 시에만 사용 | 선택한 내장 프로필과 카테고리에 따라 달라짐 | 메인 오케스트레이션과 Claude 자식의 두 번째 폴백으로 사용 |
| Claude Max x5 활용 | 모든 자식 카테고리의 첫 번째 모델 | Claude 모델이 필요한 내장 체인에서 구독 레인을 먼저 사용 | 구현·분석·설계·글쓰기·간단 작업 자식의 첫 번째 모델로 사용 |
| 두 구독이 모두 막힌 경우 | 메인은 정지하고 자식도 체인 소진 후 실패 | 설정된 내장 공급자와 모델을 계속 탐색할 수 있음 | 자동 GitHub 대량 사용 없이 정지하고 필요할 때 수동으로 GitHub 선택 |
| 일반 `goal-continuation` | 실패 뒤에도 긴 메인 문맥 재호출 위험이 있음 | beta.53 수정 대상이 아니므로 동일한 위험이 남음 | 동일한 위험이 남으므로 GitHub를 메인 실행 중 자동 폴백에서 제외 |
| `ulw-loop`·`ulw-execute` 연속 실행 | 이전 버전에서는 실패 턴도 다시 제출될 수 있었음 | beta.53부터 성공한 턴만 계속 실행 | beta.53 동작을 그대로 사용 |
| 메모리 자식 | reflection 60단계, 압축 시 실행 안 함, dream 비활성 | 외부 패키지 루트 상속 오류와 과거 실패 경고가 수정됨 | 현재 보수적 실행 주기를 유지하고 라우팅 안정화 뒤 별도 재평가 |
| 필요한 변경 파일 | 현재 `omo.jsonc`, `settings.json` | 기능만 제공하며 자동으로 사용자 정책을 작성하지 않음 | `~/.omo/omo.jsonc`에 프로필·공급자 동시성 추가, `~/.omo/agent/settings.json`에 Sol → Claude 폴백 추가 |

## 근거

- <https://github.com/code-yeongyu/oh-my-openagent/releases/tag/v5.0.0-beta.53>
- <https://raw.githubusercontent.com/code-yeongyu/oh-my-openagent/v5.0.0-beta.53/docs/reference/omo-json.md>
- `C:\Users\yjack\.omo\omo.jsonc`
- `C:\Users\yjack\.omo\agent\settings.json`
