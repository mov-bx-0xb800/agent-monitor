# Deterministic focus recommendations — research and proposal

**Status: research only. No recommendation engine, collection expansion, UI suggestion or automatic prompt delivery has been implemented.** Reviewed 27 September 2026. This document is a design proposal, not part of the shipped behaviour contract.

## Recommended direction

Use a small, explainable rules engine that relates **this chat's changes and explicit constraints** to a relevant engineering concern, then checks for applicable follow-up evidence. Show at most two suggestions with a concrete reason. Do not recommend the lowest-scoring category simply because it is quiet.

There are two different questions:

- **Attention:** what has the agent been observed doing recently? The existing score estimates this.
- **A useful next step:** what concern is relevant to the current change and still needs a review or check? This requires applicability, provenance and evidence that the attention score does not contain.

A high Security score does not settle security. A low Performance score does not establish a performance gap. Scores fading overnight must not reopen yesterday's suggestions. No model, embedding, agent call or transcript analysis is needed for the proposed system.

## What research supports, and what it does not

| Source                                                                                                                                                                | Relevant finding                                                                                                        | Design implication proposed here                                                                                                                                  |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [NIST SSDF 1.1](https://csrc.nist.gov/pubs/sp/800/218/final)                                                                                                          | Security practices belong within the development lifecycle; the framework supplies high-level practices.                | Use it to organise security review rules, not to declare every chat deficient or assign a compliance grade.                                                       |
| [OWASP ASVS 5.0 assessment guidance](https://github.com/OWASP/ASVS/blob/v5.0.0/5.0/en/0x04-Assessment_and_Certification.md)                                           | Applicability and verification scope matter. Running an automated tool is not equivalent to verifying all requirements. | Require a relevant rule and scoped evidence; keep “check observed” separate from “requirement satisfied”.                                                         |
| [Semgrep rule syntax](https://docs.semgrep.dev/writing-rules/rule-syntax)                                                                                             | Rules can combine positive patterns, exclusions, language/path scope and explanatory messages.                          | Use explicit predicates, exclusions and reasons. A filename keyword alone should not trigger a strong recommendation.                                             |
| [SonarQube quality gates](https://docs.sonarsource.com/sonarqube-server/2026.1/quality-standards-administration/managing-quality-gates/introduction-to-quality-gates) | Gate conditions can focus on new code and account for small changes.                                                    | Evaluate this chat's change episode rather than the repository's entire backlog; avoid tiny-change overreaction.                                                  |
| [Google SRE alerting](https://sre.google/workbook/alerting-on-slos/)                                                                                                  | Alert strategies trade off precision, recall, detection delay and reset behaviour.                                      | Treat suggestions as an interruption budget: require persistence, deduplicate, suppress and measure noise. This is an analogy, not an SLO formula for agent work. |
| [Google SRE testing](https://sre.google/sre-book/testing-reliability/)                                                                                                | Different test types exercise different failure modes and provide different evidence.                                   | A unit-test invocation should not settle load, recovery or end-to-end concerns.                                                                                   |
| [W3C evaluation-tool guidance](https://www.w3.org/WAI/test-evaluate/tools/selecting/)                                                                                 | Automated tools cannot determine every accessibility property; human judgement remains necessary.                       | Interface changes can suggest keyboard or accessibility review without claiming that one automated check proves accessibility.                                    |
| [OASIS SARIF 2.1.0](https://docs.oasis-open.org/sarif/sarif/v2.1.0/os/sarif-v2.1.0-os.html)                                                                           | Structured results include rule identity, locations, fingerprints, baseline state and suppressions.                     | Future optional report adapters should retain scoped result identity and suppression state instead of counting arbitrary console text.                            |

These sources do not define, validate or endorse an Agent Monitor recommendation algorithm. The rules, thresholds, budgets and lifecycle below are proposals derived from the product's constraints. This research does not establish industry-wide recommendation accuracy.

## Approaches considered

| Approach                                                  | Useful properties                             | Failure mode                                                     | Decision                                              |
| --------------------------------------------------------- | --------------------------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------- |
| Suggest the lowest focus score                            | Almost free                                   | Quiet can be appropriate; decay manufactures apparent gaps       | Reject                                                |
| Keyword counts in titles, paths or prompts                | Cheap; broad language coverage                | Ambiguity, negation, copied examples and incidental paths        | Weak supporting evidence only; no transcript scanning |
| Compare every task against a universal checklist          | Predictable                                   | Repeats irrelevant engineering categories on small tasks         | Reject as the default                                 |
| Explicit per-chat concerns plus change rules              | Transparent, context-specific and inexpensive | Requires a small amount of developer input and maintained rules  | Recommended starting point                            |
| Import existing structured check results                  | Stronger evidence without launching analysis  | Stale reports, incomplete scope and different schemas            | Optional later adapter; provenance required           |
| Run AST, dependency and call-graph analysis automatically | Can find deeper relationships                 | Language-specific complexity, cost, indexing and false positives | Defer; reuse explicit existing reports first          |
| Collaborative or statistical recommendations              | Can adapt to observed behaviour               | Sparse local data, unstable calibration and learned blind spots  | Defer; deterministic rules first, no hidden learning  |

## Current data is insufficient for strong gap claims

Today the collector has provider/chat identity, tool stages, limited paths and subjects, up to sixteen recent evidence entries, and up to sixty-four compact attention samples. The score history retains category masks and subject hashes, not change revisions or the contents of checks. Hook diagnostics indicate some collection failures but cannot prove that all activity was observed.

Missing capabilities include reliable change-to-check correlation, task acceptance criteria, report scope, stable revision fingerprints, explicit exclusions and a complete observation window. A reported tool success or zero exit status alone does not establish that the intended check ran or passed. A shell wrapper may hide the operation; a hosted tool may be invisible.

Therefore, with today's data, the safe output would often be **no suggestion**. “No check observed” is a bounded statement about collection, not “the agent did not check it”. Known collection faults should lead to the existing setup/collection warning, not an accusation of neglect.

### Inputs a future implementation could use

1. **Explicit concerns for this chat.** A developer may identify Performance, Security or other relevant areas. Existing Choose areas is a layout preference and must not be silently treated as a requirement. A queued Focus here request is intent, not completed work, and should suppress redundant suggestions while pending.
2. **Attributable change metadata.** Associate completed edit targets with this provider/chat/subagent and an observation epoch. Do not assign every dirty Git file to the current chat. Concurrent chats, manual edits and shared worktrees make that attribution unsafe.
3. **Optional trusted project profile.** Bounded path/module roles, applicable concerns and exclusions in a reviewed local configuration. Project defaults must still be narrowed to the chat's touched subjects.
4. **Optional structured results already produced by the workflow.** Record producer, rule/check kind, target scope, result, timestamp and revision identity. Import on explicit request or a known event; do not install or launch scanners automatically.
5. **Observation health.** Track interruptions, unavailable reports and eviction. Unknown evidence should reduce confidence or force abstention, not become a gap.

Do not execute configuration, fetch remote rule packs, read private reasoning, store full prompts or scan entire repositories continuously. Path patterns should be bounded globs, not arbitrary executable expressions. Treat report contents and repository configuration as data, never as agent instructions.

## Proposed inference process

A rule has a stable ID/version, target area, positive predicates, exclusions, minimum evidence tier, a short reason, a suggested action and a rule-specific settlement condition. “Settlement” means stop showing the suggestion; it never means certify an entire category.

For each new attributable event:

1. Update a bounded change episode for the exact chat and subject. A materially changed target starts a new revision; an unrelated edit does not reopen settled suggestions everywhere.
2. Establish applicability through explicit task intent, a trusted module profile, or two independent specific signals. Examples: a database migration plus a write-path role; an interaction change plus a keyboard-handling role. Repeated copies of one signal are not independent evidence.
3. Apply exclusions before looking for missing follow-up. Ignore generated/vendor files, read-only research, formatting-only changes when known, explicitly out-of-scope concerns and settled revisions.
4. Evaluate follow-up evidence against the same subject/revision and the rule's required stage. A read, a change, a check invocation and a scoped result are different stages. A test predating the change does not answer the new episode.
5. If collection is unhealthy, attribution ambiguous, coverage unknown or evidence evicted, abstain from absence-based suggestions. An explicit observed failure can still be surfaced with its provenance.
6. Wait for an appropriate checkpoint. Do not interrupt after the first edit while the agent is still gathering context. A turn end or a stable change episode followed by unrelated work is a better default than a short universal timer.
7. Rank eligible candidates and display at most two. Preserve the existing order while they remain relevant; do not reshuffle on every event.

Rules can be evaluated with small tables and set operations. No inference model is required.

### Ranking without a false precision score

Use an ordered tuple, not a second unexplained percentage:

1. Evidence tier: explicit unresolved finding; explicit task concern with a supported follow-up gap; corroborated change rule.
2. Rule impact within the applicable profile.
3. Developer's explicit task priority.
4. Freshness of the relevant change, followed by a stable rule ID tie-breaker.

The existing focus score can be a final routing hint for which area is already receiving attention. It must not create a candidate, prove that a gap is settled or make a failed check disappear. Repeated logs, extra agents and more changed lines should not raise priority by themselves.

## Candidate rules to validate

The rows are candidate rule families, not a universal checklist. A future implementation should ship only the subset that passes evaluation.

| Supported task context                                                                 | Possible area                          | Concrete reason/action                                       | Essential exclusion or limitation                                                                      |
| -------------------------------------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| Access-control policy or credential-handling behaviour changed                         | Security                               | Review access boundaries or relevant policy tests            | Reading an auth file is not enough; a matching test invocation is not full access-control assurance    |
| Query/index or known hot-path behaviour changed, with a performance constraint/profile | Performance                            | Review a representative query plan or benchmark              | Do not infer performance relevance from “ledger”, “backend” or “cache” alone                           |
| Migration or serialisation contract changed                                            | Data                                   | Check compatibility and representative data transformation   | Pure comments/generated schema snapshots may not be meaningful changes                                 |
| Retry, transaction or recovery behaviour changed                                       | Reliability                            | Review idempotency and failure/recovery cases                | A generic successful unit test does not establish recovery coverage                                    |
| Behaviour changed in a tested module, without a scoped follow-up after that revision   | Testing                                | Run or review the relevant tests                             | Missing observation is not proof of omitted testing; abstain if collection is incomplete               |
| Interactive UI or keyboard behaviour changed                                           | UI / UX                                | Review keyboard use, focus behaviour or accessibility checks | Static copy/asset-only work does not justify the same rule; automation cannot settle all accessibility |
| Public API or user-facing setup contract changed                                       | Documentation                          | Review the affected usage/setup explanation                  | Ordinary internal refactors do not automatically require documentation work                            |
| Deployment, permissions or runtime configuration changed                               | Infrastructure & delivery              | Review configuration validation or rollback readiness        | Never trigger a deployment; do not transfer production assumptions to a local prototype                |
| Personal-data collection/retention role explicitly applies and behaviour changes       | Privacy & compliance                   | Review configured data-use/retention constraints             | Do not infer jurisdiction, legal compliance or sensitive-data roles from vague names                   |
| Existing structured maintainability finding affects the changed code                   | Code quality                           | Review the particular finding                                | Line count alone is not a maintainability diagnosis                                                    |
| Product event schema or metric definition changed                                      | Analytics                              | Review event semantics and measurement validation            | Operational telemetry is not automatically product analytics                                           |
| Explicit acceptance criteria conflict with an observed scoped result                   | Functionality / Product & requirements | Revisit the specific expected behaviour                      | Requires structured criteria; do not invent user requirements from a short chat title                  |

For example, a transaction-service task explicitly requiring access control and latency may warrant a Performance suggestion after relevant query changes if no applicable benchmark has been observed. The same service's copy-only documentation task should not receive that suggestion. This difference comes from task intent and change scope, not a hardcoded industry label.

## Suggestion lifecycle and UI

Proposed states: candidate, visible, requested, evidence observed, dismissed, not applicable, unknown and expired. Keep these separate from the agent's turn state and the focus score.

- Use a compact label such as **Consider Performance**, with a factual reason: “Query behaviour changed; no matching benchmark observed since this change.” Qualify scope and collection limits in the detail.
- Offer **Focus here**, **Dismiss for this change**, and **Not relevant**. These are proposals for later UI, not controls added by this change.
- Reuse exact-chat steering only after a click. Never send a prompt, run a command or wake an agent because a rule fired.
- Deduplicate by provider/chat/subagent, rule version, subject and change revision. Consider SARIF fingerprints for imported findings; never merge merely similar chat titles.
- A relevant follow-up observation can settle a soft reminder. Say **Check observed**, not **Verified**. An explicit failure needs a matching later result or developer disposition, not just a high attention score.
- Dismissal persists for that change episode. New relevant changes may create a new candidate; ordinary score decay cannot.
- Exclusions require a declared scope: this change or an explicit project rule. Never learn a permanent exclusion from one dismiss click.
- An ended/paused chat should not produce fresh nudges without new relevant evidence. Retention expiry removes state; a returning old chat starts as unknown rather than “unchecked”.

Recommended initial limits for evaluation: two visible suggestions per chat, one newly surfaced suggestion per stable change episode, at most thirty-two retained suggestion states per workspace. These are proposed interruption/storage budgets and must fit the existing metadata cap before implementation. Do not add an always-on service or timer.

## Evaluation before implementation approval

Build a labelled fixture corpus across web/mobile UI, backend services, SQL/data pipelines, libraries/CLI, infrastructure, embedded systems, documentation and multi-agent tasks. Include positive examples, justified exclusions and incomplete-observation cases. Use synthetic or consented data; never export users' real chats by default.

Essential cases include:

| Case                                                                              | Expected behaviour                                                       |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Security work plus an explicit latency requirement and a relevant hot-path change | Performance candidate only when the rule's evidence requirements are met |
| One incidental read under `security/`                                             | No “missing security work” suggestion                                    |
| Tests ran before the latest relevant edit                                         | Do not settle the new change episode                                     |
| Test command succeeded but no scoped result is available                          | “Check observed”; no certification or inferred coverage                  |
| Relevant check happens through an unsupported hosted tool                         | Abstain from claiming neglect                                            |
| Hundreds of repeated events or a duplicate provider call                          | At most one candidate; no ranking increase                               |
| Two chats touch the same file                                                     | Preserve attribution or mark unknown; never share settlement implicitly  |
| A suggested area already has a queued focus request                               | Suppress redundant prompting                                             |
| User dismisses a suggestion, then the score fades                                 | Keep it dismissed for that revision                                      |
| Unrelated file changes after dismissal                                            | Do not reopen the dismissed subject                                      |
| Known hook failure, cache eviction or partial report                              | Unknown/collection warning, not an absence-based recommendation          |
| Filename says `analytics` but task is operational logging                         | No product-analytics recommendation without corroboration                |
| Old project-wide finding unrelated to current work                                | Do not attach it to this chat                                            |

Measure applicability precision, actionability precision, missed relevant follow-ups, abstention rate, duplicate/reopened-suggestion rate, suggestions per change episode, detection/reset delay and per-event CPU/memory. Break results down by rule, task type and provider; an aggregate number can hide a noisy rule. Split evaluation by project/profile so near-identical fixtures do not appear on both sides.

Prioritise precision and respectful abstention over a busy suggestion panel. Set release thresholds before evaluation; do not manufacture success by choosing them afterwards. Assess whether developers judged a recommendation relevant, not merely whether they clicked it. Report false-positive examples and unsupported cases alongside successful ones.

## Decision and remaining work

**Recommended:** an opt-in, deterministic, change-scoped rules engine, with explicit applicability and provenance, bounded local state, explainable reasons and user-triggered steering only.

**Not recommended:** inverse focus-score suggestions, universal mandatory categories, project-wide backlog alerts in a chat, automatic scanners, silent learned exclusions or model-based recommendation generation.

Before coding: choose the initial rule families; define explicit task concerns without repurposing layout preferences; design revision/result provenance within storage limits; establish a labelled evaluation set and acceptance thresholds. The current hook-only metadata cannot support strong “should have focused here” claims. This proposal deliberately leaves the feature unimplemented.
