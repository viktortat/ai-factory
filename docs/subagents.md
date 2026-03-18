[← Reflex Loop](loop.md) · [Back to README](../README.md) · [Core Skills →](skills.md)

# Subagents

> **Claude Code only.** AI Factory ships bundled Claude subagents from the package `subagents/` directory and installs them into `.claude/agents/` during `ai-factory init` whenever Claude Code is selected. `ai-factory update` refreshes those managed files and preserves this behavior as Claude-only rather than pretending it is portable across other agents.

## Why This Exists

AI Factory supports many coding agents, but Claude Code has a native subagent system with isolated context, per-agent tool restrictions, model selection, and project-local agent files.

This repository uses that feature for four narrow purposes:
- splitting `/aif-loop` into small, single-responsibility roles so the Reflex Loop stays predictable, cheaper to run, and easier to reason about
- adding one planning specialist that can run `/aif-plan` and `/aif-improve` as a local critique/refinement loop before implementation
- adding one implementation specialist that can run `/aif-implement`, loop on `/aif-verify`, and apply read-only quality sidecars before declaring the work done
- exposing background execution sidecars for top-level Claude agent orchestration

The intended benefit is:
- keep noisy phase work out of the main conversation
- separate writer roles from judge roles
- use cheaper models for prep work and stronger models for evaluation/refinement
- make each phase return a strict contract instead of free-form reasoning

## Scope

Current scope is intentionally small:
- one planning subagent, two implementation subagents, five execution sidecars, and the loop-related subagents are defined
- source files live in the package `subagents/` directory
- managed copies are installed into `.claude/agents/`
- all of them are project-local, not user-global
- all of them stay specialized for AI Factory internal workflows

If you edit these files manually, reload them in Claude Code with `/agents` or by restarting the session.

## Current Bundled Agents

| Agent | Purpose | Model | Tools |
|---|---|---|---|
| `implementer` | execute `/aif-implement`, loop with `/aif-verify`, and coordinate review/security/docs/commit/best-practice sidecars before stopping | `sonnet` | `Agent(best-practices-sidecar, commit-preparer, docs-auditor, review-sidecar, security-sidecar), Read, Write, Edit, Glob, Grep, Bash` |
| `implementer-isolation` | isolated worktree variant of `implementer` for risky or collision-prone execution loops | `sonnet` | `Agent(best-practices-sidecar, commit-preparer, docs-auditor, review-sidecar, security-sidecar), Read, Write, Edit, Glob, Grep, Bash` |
| `best-practices-sidecar` | background read-only best-practices sidecar for current implementation scope | `sonnet` | `Read, Glob, Grep, Bash` |
| `plan-polisher` | create or refresh an `/aif-plan` artifact, critique it, and iterate with `/aif-improve` until the plan is stable | `sonnet` | `Read, Write, Edit, Glob, Grep, Bash` |
| `commit-preparer` | background read-only commit preparation sidecar for current implementation scope | `sonnet` | `Read, Glob, Grep, Bash` |
| `docs-auditor` | background read-only documentation drift sidecar for current implementation scope | `sonnet` | `Read, Glob, Grep, Bash` |
| `review-sidecar` | background read-only code review sidecar for current implementation scope | `sonnet` | `Read, Glob, Grep, Bash` |
| `security-sidecar` | background read-only security audit sidecar for current implementation scope | `sonnet` | `Read, Glob, Grep, Bash` |
| `loop-orchestrator` | decide the next loop phase from `run.json` state | `sonnet` | `Read, Glob, Grep` |
| `loop-planner` | build a short 3-5 step iteration plan | `haiku` | `Read, Glob, Grep` |
| `loop-producer` | generate the current markdown artifact | `sonnet` | `Read, Write, Edit` |
| `loop-evaluator` | return strict pass/fail JSON against active rules | `sonnet` | `Read, Glob, Grep` |
| `loop-critic` | translate failed rules into minimal fix instructions | `sonnet` | `Read` |
| `loop-refiner` | apply minimal fixes to the artifact | `sonnet` | `Read, Write, Edit` |
| `loop-test-prep` | prepare lightweight test-oriented checks | `haiku` | `Read, Glob, Grep` |
| `loop-perf-prep` | prepare latency/RPS/perf checks | `haiku` | `Read, Glob, Grep` |
| `loop-invariant-prep` | prepare invariant and consistency checks | `haiku` | `Read, Glob, Grep` |

## How `plan-polisher` Fits

`plan-polisher` is not part of `/aif-loop`. It is a self-contained planning worker for Claude Code that:
- runs an `/aif-plan`-compatible pass directly inside the subagent
- critiques the generated plan against implementation-readiness criteria
- applies an `/aif-improve`-compatible refinement pass
- repeats until critique is materially clean or the refinement cap is reached

To stay compatible with Claude Code subagent constraints, it does **not** try to spawn nested workers. When the injected skill instructions mention delegated exploration, the agent replaces that with direct `Read`/`Glob`/`Grep`/`Bash` work inside the same context.

## How `implementer` Fits

`implementer` is also outside `/aif-loop`. It is the execution-side companion to `plan-polisher` and:
- runs an `/aif-implement`-compatible pass directly inside the subagent
- verifies the result with an `/aif-verify`-compatible pass
- runs read-only sidecars aligned to `/aif-review`, `/aif-security-checklist`, `/aif-docs`, `/aif-commit`, and `/aif-best-practices`
- feeds material findings back into the next refinement round until the implementation is clean enough to stop

When `implementer` runs as a top-level custom agent session, it can launch sidecars as background workers. When `implementer` is invoked as an ordinary subagent, nested delegation is unavailable, so it falls back to equivalent local sidecar passes in the same context.

It also establishes a one-time run policy for optional follow-ups:
- `docs_policy` controls whether docs are skipped, asked once, or safely automated
- `commit_policy` controls whether commit prompts happen at checkpoints, only once at the end, or are skipped
- push remains manual by default

`implementer-isolation` is the same execution contract, but with `isolation: worktree`. Prefer it when the implementation is risky, broad, or likely to conflict with other ongoing edits.

### Which One To Use

| Situation | Preferred agent | Why |
|---|---|---|
| Small or routine implementation on a quiet branch | `implementer` | Lower overhead, faster turnaround |
| Risky refactor or broad cross-cutting change | `implementer-isolation` | Worktree isolation lowers blast radius |
| Parallel work is already happening in the same repo | `implementer-isolation` | Reduces edit collision risk |
| You expect aggressive experimentation before convergence | `implementer-isolation` | Safer place for repeated refinement rounds |
| Straightforward finish-up after a mostly completed plan | `implementer` | Simpler and cheaper than isolated execution |

## Quality Sidecars

`best-practices-sidecar`, `commit-preparer`, `docs-auditor`, `review-sidecar`, and `security-sidecar` exist for the Claude-native case where a custom top-level orchestrator can legally delegate:
- all are `background: true`
- all are read-only
- all of them are intended to report concise blocker-focused findings back to `implementer`

This lets the execution loop keep noisy review, security, docs-drift, commit-analysis, and maintainability analysis work out of the main implementer context when Claude is running in full custom-agent mode.

The loop prep workers are also good background candidates and are configured that way:
- `loop-test-prep`
- `loop-perf-prep`
- `loop-invariant-prep`

They are read-only, parallel by design, and produce short structured outputs that do not need user interaction.

## How They Fit Into `/aif-loop`

The loop has six logical phases:

1. `PLAN`
2. `PRODUCE`
3. `PREPARE`
4. `EVALUATE`
5. `CRITIQUE`
6. `REFINE`

The subagents map onto those phases like this:

| Loop phase | Subagent |
|---|---|
| `PLAN` | `loop-planner` |
| `PRODUCE` | `loop-producer` |
| `PREPARE` | `loop-test-prep`, `loop-perf-prep`, `loop-invariant-prep` |
| `EVALUATE` | `loop-evaluator` |
| `CRITIQUE` | `loop-critic` |
| `REFINE` | `loop-refiner` |
| routing between phases | `loop-orchestrator` |

This keeps responsibilities narrow:
- planner decides what to do next
- producer writes
- evaluator judges
- critic explains what failed
- refiner changes only what is needed
- `plan-polisher` stays outside the Reflex Loop and focuses only on plan quality
- `implementer` stays outside the Reflex Loop and focuses on implementation quality closure
- `best-practices-sidecar`, `commit-preparer`, `docs-auditor`, `review-sidecar`, and `security-sidecar` stay outside the Reflex Loop and support only the execution worker

## Design Principles

### Read-only roles stay read-only where possible

The loop's planning, evaluation, critique, and prep roles do not need write access, so they are intentionally constrained. Most of them also use `permissionMode: plan`, which matches Claude Code's read-only exploration mode. `plan-polisher` and `implementer` are the exceptions because they own end-to-end refinement of their artifacts.

### Writer roles are limited

Only `loop-producer`, `loop-refiner`, `plan-polisher`, `implementer`, and `implementer-isolation` can modify content. `best-practices-sidecar`, `commit-preparer`, `docs-auditor`, `review-sidecar`, and `security-sidecar` are intentionally read-only. This reduces the chance of accidental state drift across phases and keeps write access tied to explicit artifact ownership.

### Cheap where possible, stronger where necessary

`haiku` is used for prep/planning roles where the output is short and structured. `sonnet` is used for generation, evaluation, critique, and refinement where quality matters more. The two non-loop workers also use `sonnet` because they have to integrate multiple workflow skills and make stop/go judgments.

### Output contracts are strict

Most loop agents return either:
- JSON only, for machine-consumed phases
- raw markdown only, for artifact-producing phases

That makes the overall loop easier to orchestrate and validate.

## Important Claude Code Constraints

These repo-local agents follow current Claude Code subagent behavior:

- ordinary subagents cannot spawn other subagents
- nested delegation must stay in the main flow
- subagents are selected partly from the `description` field, so descriptions should be explicit
- manual edits to `.claude/agents/*.md` are not always picked up until reload

Because of that, the loop design favors phase-specialized workers instead of deep agent trees, `plan-polisher` runs its critique/refine cycle locally instead of trying to delegate the improve pass again, and `implementer` can delegate only when it is the top-level custom agent. Otherwise it falls back to local review/security/best-practice passes.

## Why Only Claude For Now

Other supported agents in AI Factory have their own skill formats and extension points, but they do not share Claude Code's `.claude/agents/` subagent mechanism. So this specific setup is intentionally documented as Claude-only instead of pretending it is portable.

If we later build an agent-agnostic abstraction for role-based loop workers, this page should be updated to separate:
- Claude-native subagents
- generic AI Factory workflow roles
- any cross-agent equivalent implementation

## See Also

- [Reflex Loop](loop.md) - the workflow these agents support
- [Core Skills](skills.md) - slash command reference including `/aif-loop`
- [Configuration](configuration.md) - project directories and agent config files
