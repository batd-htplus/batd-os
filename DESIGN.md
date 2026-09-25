# Flow

AI coding orchestration harness.

Flow does not implement its own coding-agent loop.

Flow orchestrates external coding engines such as:

* Claude Code CLI
* Codex CLI
* OpenCode CLI

Flow owns workflow, task state, approval, context selection, verification, evidence, resume, and parallel orchestration.

---

## 1. Core Idea

```text
                         FLOW
              Orchestration / Control Plane
┌─────────────────────────────────────────────────┐
│                                                 │
│ Workflow                                        │
│ Task / Step                                     │
│ Ledger / Resume                                 │
│ Context selection                               │
│ Approval / Policy                               │
│ Check / Evidence                                │
│ Worktree                                        │
│ Parallel orchestration                          │
│ Cost / Budget                                   │
│                                                 │
└──────────────┬───────────────┬──────────────────┘
               │               │
               ▼               ▼
       Claude Code CLI      Codex CLI
               │               │
               ▼               ▼
            Claude             GPT

                    +
               OpenCode CLI
```

### Responsibility boundary

Flow:

* decides **what** should happen;
* decides **when** it happens;
* decides **which engine** performs it;
* controls permissions and approval;
* verifies the result;
* records state and evidence;
* resumes failed/interrupted work.

Coding engine:

* owns Agent Loop;
* owns model interaction;
* owns tool calling;
* owns file editing;
* owns shell/tool execution;
* owns its internal context/compaction;
* performs the actual coding work.

Flow must not reimplement capabilities already provided by the coding engines unless there is a concrete orchestration requirement.

---

# 2. Reference Sources

Two local repositories are maintained as reference sources:

```text
ecc/
cloudflare-os/
```

They are not dependencies of Flow.

## ECC

Use ECC to understand and reuse useful coding-agent capabilities:

* skills
* rules
* commands
* agents
* hooks
* verification
* context handling
* coding conventions

Do not blindly copy the whole system.

If a capability is already provided by Claude Code/Codex/OpenCode, Flow should delegate to the engine instead of rebuilding it.

## Cloudflare OS

Use Cloudflare OS to understand and reuse useful control/orchestration patterns:

* Agent orchestration
* Gatekeeper
* approval
* capabilities
* state
* workflow
* verification
* chokepoints
* replay/control

Do not copy Cloudflare-specific infrastructure.

Examples:

```text
Cloudflare OS concept → Flow

Gatekeeper       → Policy
Approval         → Approval
State            → Ledger
Blueprint        → Flow JSON
Agent            → Coding Engine
Verification     → Check
Orchestration    → Workflow
```

### Rule

For every feature taken from either repository:

1. What problem does it solve?
2. Does Flow need to own it?
3. Can an external coding engine already provide it?
4. What is the simplest implementation?
5. What is the token/LLM/LOC/dependency/operational cost?

If there is no clear benefit, do not include it.

---

# 3. Problems Flow Solves

Flow focuses on eight problems.

### 1. Orchestration

Coordinate multiple coding engines and multiple tasks.

### 2. Workflow

Make the coding process deterministic and reproducible.

```text
PLAN
  ↓
APPROVAL
  ↓
IMPLEMENT
  ↓
CHECK
  ↓
DONE
```

### 3. State / Resume

A task must survive:

* process crash;
* machine restart;
* coding-engine failure;
* interrupted approval;
* failed check.

### 4. Context

Flow controls which project information is given to a coding engine.

```text
discover
   ↓
select
   ↓
budget
   ↓
load
```

Flow should not blindly send the entire repository.

### 5. Verification

"Agent says done" is not completion.

Completion requires deterministic checks and evidence.

### 6. Approval / Safety

Every potentially dangerous operation passes through a Flow policy boundary.

### 7. Parallelism

Independent tasks can run concurrently.

### 8. Cost / Resource Control

Flow tracks:

* task budget;
* step budget;
* engine;
* execution time;
* retry count;
* estimated/known model cost where available.

---

# 4. Architecture

```text
src/
├── contracts/
│   ├── engine.ts
│   ├── tool.ts
│   ├── check.ts
│   ├── events.ts
│   ├── flow-schema.ts
│   └── pack-schema.ts
│
├── kernel/
│   ├── task/
│   ├── step/
│   ├── policy/
│   ├── check/
│   ├── barrier/
│   ├── ledger/
│   ├── context/
│   ├── budget/
│   └── workflow/
│
├── engines/
│   ├── claude-code/
│   ├── codex/
│   └── opencode/
│
├── adapters/
│   ├── filesystem/
│   ├── git/
│   ├── shell/
│   └── mcp/
│
└── apps/
    ├── cli/
    └── mcp-server/
```

No:

```text
runtime/loop/
model-anthropic/
model-openai/
```

in MVP.

Flow does not directly implement an LLM Agent Loop.

---

# 5. Dependency Direction

```text
                    contracts
                ┌──────┼──────┐
                ▼      ▼      ▼
             kernel  engines adapters
                ▲      ▲      ▲
                └──────┼──────┘
                       │
                      apps
```

Rules:

* `contracts` contains interfaces/types only.
* `kernel` is deterministic.
* `engines` implement coding-engine adapters.
* `adapters` implement infrastructure interfaces.
* `apps` are composition roots.
* `kernel` must not import a specific engine.
* `kernel` must not import Claude Code/Codex/OpenCode.
* Engine adapters must not contain Flow orchestration logic.

---

# 6. Coding Engine Contract

Flow communicates with every coding engine through one contract.

Conceptually:

```ts
interface CodingEngine {
  id: string;

  run(input: EngineRequest): Promise<EngineResult>;
}
```

Flow provides:

```text
EngineRequest
├── task
├── step
├── workingDirectory
├── prompt
├── context
├── environment
├── timeout
└── policy
```

Engine returns:

```text
EngineResult
├── exitCode
├── status
├── stdout/stderr artifact
├── changed files
├── commit/worktree information
├── duration
└── metadata
```

The adapter translates the generic contract into the specific CLI invocation.

Example:

```text
Flow
  ↓
CodingEngine.run()
  ↓
ClaudeCodeEngine
  ↓
spawn("claude", ...)
```

or:

```text
Flow
  ↓
CodingEngine.run()
  ↓
CodexEngine
  ↓
spawn("codex", ...)
```

or:

```text
Flow
  ↓
CodingEngine.run()
  ↓
OpenCodeEngine
  ↓
spawn("opencode", ...)
```

---

# 7. CLI Is the Boundary

The MVP uses process execution rather than directly calling model APIs.

```text
Flow
 ↓
child_process
 ↓
Coding CLI
 ↓
Model
```

This gives Flow:

* vendor independence;
* no model SDK dependency;
* no API-key handling inside Flow;
* reuse of existing authentication;
* reuse of existing coding-agent capabilities;
* simple adapter boundary.

Flow does not care whether the engine internally uses:

* API;
* OAuth;
* local model;
* another provider.

The engine owns that implementation.

---

# 8. Engine Selection

A Flow step may specify an engine.

Example:

```json
{
  "id": "implement",
  "engine": "claude-code"
}
```

Or:

```json
{
  "id": "review",
  "engine": "codex"
}
```

Or allow profile/default selection:

```json
{
  "engine": "default"
}
```

Engine selection is orchestration policy, not model logic.

---

# 9. Workflow

Workflow is data.

JSON is used because Node provides JSON parsing without an additional dependency.

Example:

```json
{
  "id": "coding",
  "version": 1,
  "steps": [
    {
      "id": "plan",
      "engine": "claude-code",
      "needs": {
        "repo": {
          "budget": 8000
        }
      },
      "check": "plan-has-acceptance",
      "approval": true
    },
    {
      "id": "implement",
      "engine": "claude-code",
      "needs": {
        "plan": {},
        "repo": {
          "budget": 16000
        }
      },
      "checks": [
        "test",
        "lint"
      ],
      "retry": 3
    }
  ]
}
```

Flow executes the workflow.

The coding engine performs the work inside each step.

---

# 10. Step

Step is the atomic orchestration unit.

A Step defines:

```text
Step
├── engine
├── context requirements
├── permissions
├── checks
├── approval
├── retry
├── timeout
└── budget
```

A Step does not define an Agent Loop.

The coding engine may internally perform hundreds of tool/model interactions.

Flow sees that as one engine execution.

---

# 11. Ledger

Ledger is the source of truth.

```text
.flow/
  tasks/
    <task-id>/
      events.jsonl
```

State is reconstructed by replaying events.

Snapshot is only a cache.

Deleting the snapshot must not destroy resumability.

Event envelope:

```json
{
  "v": 1,
  "seq": 42,
  "ts": "2026-09-25T10:00:00Z",
  "taskId": "task-123",
  "stepId": "implement",
  "type": "StepCompleted"
}
```

Minimum events:

```text
TaskCreated
TaskCompleted
TaskFailed

StepStarted
StepCompleted
StepFailed
StepRetry
StepAwaitingApproval

EngineStarted
EngineCompleted
EngineFailed

ContextLoaded
ContextInvalidated

ApprovalRequested
ApprovalResolved

CheckStarted
CheckPassed
CheckFailed

EvidenceCreated

BarrierCommitted
```

Raw engine transcript is not part of the event log by default.

Large outputs are stored as artifacts.

---

# 12. Task

Task owns:

```text
Task
├── id
├── workflow
├── repository
├── worktree
├── ledger
├── artifacts
└── current state
```

Each task gets an isolated worktree.

```text
.flow/
└── worktrees/
    ├── task-a/
    ├── task-b/
    └── task-c/
```

This allows:

```text
Task A → Claude Code
Task B → Codex
Task C → OpenCode
```

to execute concurrently.

---

# 13. Parallelism

Default:

```text
one task = one worktree = one writer
```

Multiple tasks may run in parallel.

Inside one task:

```text
read/review/explore
        ↓
    parallel
        ↓
    artifacts
        ↓
    one implementation step
```

Avoid multiple writers touching the same worktree unless file scopes are explicitly disjoint.

Merge conflicts become:

```text
awaiting_approval
```

not automatic destructive resolution.

---

# 14. Context

Flow owns **orchestration-level context selection**.

It does not replace the coding engine's internal context system.

Flow determines:

```text
What information should this step receive?
```

The coding engine determines:

```text
How does the agent use that information internally?
```

Context pipeline:

```text
discover
   ↓
select
   ↓
budget
   ↓
load
   ↓
EngineRequest
```

Context Item:

```ts
interface Item {
  id: string;
  source: string;
  hash: string;
  tokens: number;
  trust: "user" | "repo" | "mcp" | "generated";
}
```

Nothing enters the engine request before selection.

---

# 15. MCP

Flow supports two directions.

## Flow → external MCP

External MCP resources become context Items.

External MCP tools become Flow capabilities.

```text
MCP server
   ↓
Flow MCP client
   ↓
Context / Tool
```

## External client → Flow

Claude Code, Codex or other clients may connect to Flow's MCP server.

Example:

```text
Claude Code
    ↓ MCP
Flow MCP server
    ├── task.status
    ├── task.note
    ├── context.discover
    ├── context.load
    └── task.check
```

Flow should not expose unrestricted filesystem or shell operations through its MCP server.

---

# 16. Policy

Every Flow-controlled operation goes through Policy.

```text
request
   ↓
Policy
 ┌─┴─────┐
deny   ask   allow
```

`ask` is a state transition.

It does not block a process waiting for a human.

```text
Step
 ↓
ApprovalRequested
 ↓
awaiting_approval
 ↓
ApprovalResolved
 ↓
resume
```

Default principles:

* read: allowed within declared scope;
* write: only task worktree;
* exec: only declared commands;
* network: denied unless explicitly allowed;
* push/merge/config changes: approval;
* destructive operations: approval.

The coding engine may have its own permission system.

Flow's Policy controls the orchestration boundary.

---

# 17. Checks

Flow owns deterministic verification.

Examples:

```text
exit-code
test
lint
file-exists
schema
acceptance-covered
```

Example:

```text
IMPLEMENT
    ↓
npm test
    ↓
PASS
    ↓
EvidenceCreated
    ↓
DONE
```

or:

```text
IMPLEMENT
    ↓
npm test
    ↓
FAIL
    ↓
StepRetry
    ↓
coding engine
```

After retry limit:

```text
awaiting_approval
```

LLM review can be performed by a coding engine, but it is not sufficient as the only completion gate.

---

# 18. Acceptance

Acceptance is represented as JSON.

```json
{
  "items": [
    {
      "id": "AC-001",
      "statement": "User can create an order",
      "source": "requirements",
      "verify_by": ["test"]
    }
  ]
}
```

`acceptance-covered` verifies that every acceptance item has at least one passing verification.

---

# 19. Evidence

Every completed step should produce evidence.

Examples:

```text
test result
lint result
changed files
commit SHA
acceptance result
command result
artifact reference
```

Done means:

```text
workflow condition satisfied
+
deterministic check passed
+
evidence recorded
```

Not:

```text
coding engine says "done"
```

---

# 20. Barrier

A Barrier is a workflow synchronization point.

Example:

```text
PLAN
 ↓
approval
 ↓
IMPLEMENT
 ↓
CHECK
 ↓
Barrier
 ↓
DONE
```

For parallel tasks:

```text
Task A ──┐
Task B ──┼── Barrier ── Integration Check
Task C ──┘
```

A Barrier may require:

* all tasks completed;
* all checks passed;
* approval;
* clean merge.

---

# 21. Failure / Resume

### Engine failure

```text
EngineFailed
 ↓
retry
 ↓
same step
```

### Flow crash

```text
process dies
 ↓
replay Ledger
 ↓
restore state
 ↓
resume
```

### Check failure

```text
CheckFailed
 ↓
StepRetry
 ↓
engine
```

### Approval

```text
ApprovalRequested
 ↓
awaiting_approval
 ↓
resume after approval
```

### Worktree failure

Discard and recreate the task worktree if safe.

Ledger remains authoritative.

---

# 22. Profiles

Profile describes how Flow orchestrates a type of work.

Examples:

```text
quick
greenfield
bugfix
legacy-rewrite
```

Profile controls:

* workflow;
* default engine;
* checks;
* context requirements;
* approval rules;
* budget;
* retry policy.

Profile does not implement coding behavior.

---

# 23. Truth

Truth determines which source is authoritative.

```text
requirements
current-code
legacy
```

Example:

```json
{
  "truth": "current-code"
}
```

This affects:

* context priority;
* conflict resolution;
* required checks;
* workflow steps.

---

# 24. Pack

Pack contains reusable Flow content.

```text
packs/
└── core/
    ├── pack.json
    └── instructions.md
```

Pack may provide:

* instructions;
* context sources;
* grants;
* checks;
* workflow fragments.

Pack is data/content, not another runtime.

---

# 25. Disk Layout

```text
.flow/
├── tasks/
│   └── <id>/
│       ├── events.jsonl
│       ├── artifacts/
│       └── evidence/
│
├── worktrees/
│   └── <id>/
│
├── cache/
└── snapshot/
```

Everything except the Ledger is disposable/rebuildable where possible.

---

# 26. MVP

MVP implements only:

```text
1. CLI
2. JSON Flow loader
3. Task
4. Step
5. Ledger
6. Worktree
7. CodingEngine contract
8. Claude Code adapter
9. Check runner
10. Approval
11. Resume
12. Basic context selection
13. Basic MCP server
```

Initial engine:

```text
Claude Code CLI
```

Then:

```text
Codex CLI
OpenCode CLI
```

are added through the same contract.

---

# 27. MVP Coding Flow

```text
flow run coding

       │
       ▼
    TaskCreated
       │
       ▼
      PLAN
       │
       ▼
 Claude Code CLI
       │
       ▼
 Plan Check
       │
       ▼
   Approval
       │
       ▼
   IMPLEMENT
       │
       ▼
 Claude Code CLI
       │
       ▼
 Test / Lint
       │
   ┌───┴────┐
   │        │
 PASS      FAIL
   │        │
   ▼        ▼
 DONE     RETRY
            │
            └──→ IMPLEMENT
```

---

# 28. What Flow Does NOT Build

MVP does not build:

* its own Agent Loop;
* its own LLM tool-calling loop;
* Anthropic SDK;
* OpenAI SDK;
* model-specific prompt protocol;
* model-specific compaction;
* model-specific permission system;
* model-specific file editor;
* model-specific shell agent;
* database;
* Redis;
* server-side job queue;
* distributed runtime.

These belong either to the coding engine or are unnecessary for MVP.

---

# 29. Dependency Strategy

Runtime:

* Node >= 24 LTS
* TypeScript
* native type stripping
* JSON

TypeScript:

```text
erasableSyntaxOnly
verbatimModuleSyntax
allowImportingTsExtensions
noEmit
```

Rules:

* no `enum`;
* no `namespace`;
* no parameter properties;
* explicit `.ts` imports;
* `import type`.

Keep dependencies minimal.

Do not introduce a dependency when Node/platform primitives are sufficient.

---

# 30. Project Structure

```text
flow/
├── src/
│   ├── contracts/
│   │   ├── engine.ts
│   │   ├── tool.ts
│   │   ├── check.ts
│   │   ├── events.ts
│   │   ├── flow-schema.ts
│   │   └── pack-schema.ts
│   │
│   ├── kernel/
│   │   ├── task/
│   │   ├── step/
│   │   ├── workflow/
│   │   ├── policy/
│   │   ├── check/
│   │   ├── barrier/
│   │   ├── ledger/
│   │   ├── context/
│   │   └── budget/
│   │
│   ├── engines/
│   │   ├── claude-code/
│   │   ├── codex/
│   │   └── opencode/
│   │
│   ├── adapters/
│   │   ├── filesystem/
│   │   ├── git/
│   │   ├── shell/
│   │   └── mcp/
│   │
│   └── apps/
│       ├── cli/
│       └── mcp-server/
│
├── flows/
│   ├── coding.json
│   └── bugfix.json
│
├── packs/
│   └── core/
│       ├── pack.json
│       └── instructions.md
│
├── tests/
│   ├── unit/
│   ├── integration/
│   └── evals/
│
└── DESIGN.md
```

---

# 31. Design Principles

1. **Flow orchestrates; coding engines code.**
2. **Do not rebuild an Agent Loop that already exists.**
3. **Workflow is data, not prompt.**
4. **Ledger is the source of truth.**
5. **Checks, not agent claims, determine completion.**
6. **Every task gets isolated state/worktree.**
7. **Every dangerous operation crosses a policy boundary.**
8. **Approval is a state transition, not a blocking call.**
9. **Context is selected before it is loaded.**
