import type { ProjectConfig, StepDef } from "../../contracts/flow-schema.ts";
import type { StepState, TaskState } from "../task/state.ts";

/** Remaining task spend, or undefined when the project sets no task budget. */
export function remainingTaskUsd(state: TaskState, config: ProjectConfig): number | undefined {
    let budget = config.budget?.taskUsd;
    return budget === undefined ? undefined : budget * (1 + state.budgetGrants) - state.costUsd;
}

/** The cap handed to the engine for one run: the smaller of the step cap and the task remainder. */
export function engineCapUsd(step: StepDef, state: TaskState, config: ProjectConfig): number | undefined {
    let caps = [step.budget?.usd, remainingTaskUsd(state, config)].filter((v): v is number => v !== undefined);
    return caps.length === 0 ? undefined : Math.max(0, Math.min(...caps));
}

/** Attempts a step may make: 1 + retries, and one more round per approved "retries". */
export function maxAttempts(step: StepDef, state: StepState): number {
    let retry = step.retry ?? 0;
    return 1 + retry + state.extraAttempts * Math.max(retry, 1);
}
