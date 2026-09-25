import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AcceptanceItem, CheckResult, CheckSpec } from "../../contracts/check.ts";
import type { ProcessRunner } from "../../contracts/infra.ts";

export type CheckContext = {
    runner: ProcessRunner;
    worktree: string;
    artifactsDir: string;
    /** Checks already passed earlier in this attempt (for acceptance-covered). */
    passed: string[];
    /** Where command output goes, relative to the task directory. */
    logName: string;
    taskDir: string;
};

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const FEEDBACK_TAIL_CHARS = 4000;

const tail = (text: string, max: number): string => text.length <= max ? text : "…" + text.slice(-max);

/** Extracts the ```json {"items": [...]} block a plan ends with. */
export function parseAcceptance(plan: string): AcceptanceItem[] | string {
    let blocks = [...plan.matchAll(/```json\s*\n([\s\S]*?)```/g)];
    for (let block of blocks.reverse()) {
        try {
            let parsed = JSON.parse(block[1]) as { items?: unknown };
            if (!Array.isArray(parsed.items)) continue;
            let items = parsed.items as AcceptanceItem[];
            for (let item of items) {
                if (typeof item.id !== "string" || typeof item.statement !== "string" ||
                    !Array.isArray(item.verify_by) || item.verify_by.length === 0) {
                    return `acceptance item ${JSON.stringify(item).slice(0, 80)} needs id, statement, verify_by[]`;
                }
            }
            return items.length > 0 ? items : "acceptance items list is empty";
        } catch {
            continue;
        }
    }
    return 'no ```json {"items": [...]} acceptance block found';
}

export async function runCheck(name: string, spec: CheckSpec, ctx: CheckContext): Promise<CheckResult> {
    let started = Date.now();
    let fail = (rule: string, fix: string, extra: Partial<CheckResult["evidence"]> = {}): CheckResult => ({
        check: name, pass: false, reasons: [{ rule, fix }],
        evidence: { durationMs: Date.now() - started, ...extra },
    });
    let pass = (extra: Partial<CheckResult["evidence"]> = {}): CheckResult => ({
        check: name, pass: true, reasons: [], evidence: { durationMs: Date.now() - started, ...extra },
    });

    switch (spec.kind) {
        case "command": {
            let result = await ctx.runner.run(spec.run, [], {
                cwd: ctx.worktree, timeoutMs: spec.timeoutMs ?? DEFAULT_TIMEOUT_MS, shell: true,
            });
            let log = join("evidence", `${ctx.logName}.log`);
            mkdirSync(join(ctx.taskDir, "evidence"), { recursive: true });
            writeFileSync(join(ctx.taskDir, log), `$ ${spec.run}\n${result.stdout}\n${result.stderr}`);
            let evidence = { command: spec.run, exitCode: result.exitCode, outputArtifact: log };
            if (result.exitCode === 0 && !result.timedOut) return pass(evidence);
            return fail(
                result.timedOut ? `\`${spec.run}\` must finish within ${spec.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`
                    : `\`${spec.run}\` must exit 0 (got ${result.exitCode})`,
                `Fix the failure. Output tail:\n${tail(`${result.stdout}\n${result.stderr}`.trim(), FEEDBACK_TAIL_CHARS)}`,
                evidence);
        }
        case "file-exists":
            return existsSync(join(ctx.worktree, spec.path)) ? pass()
                : fail(`${spec.path} must exist`, `Create ${spec.path}.`);
        case "plan-has-acceptance": {
            let planFile = join(ctx.artifactsDir, "plan.md");
            if (!existsSync(planFile)) return fail("the step must produce a plan", "Answer with the plan.");
            let items = parseAcceptance(readFileSync(planFile, "utf8"));
            if (typeof items === "string") {
                return fail("the plan must end with acceptance criteria",
                    `${items}. End the plan with a \`\`\`json block: {"items": [{"id": "AC-001", ` +
                    `"statement": "...", "source": "...", "verify_by": ["test"]}]}`);
            }
            writeFileSync(join(ctx.artifactsDir, "acceptance.json"), JSON.stringify({ items }, null, 2));
            return pass({ outputArtifact: "artifacts/acceptance.json" });
        }
        case "acceptance-covered": {
            let file = join(ctx.artifactsDir, "acceptance.json");
            if (!existsSync(file)) return fail("acceptance.json must exist", "Run a plan step with plan-has-acceptance first.");
            let { items } = JSON.parse(readFileSync(file, "utf8")) as { items: AcceptanceItem[] };
            let uncovered = items.filter(item => !item.verify_by.every(check => ctx.passed.includes(check)));
            if (uncovered.length === 0) return pass({ outputArtifact: "artifacts/acceptance.json" });
            return fail("every acceptance item must be verified by passing checks",
                uncovered.map(item => `${item.id} (${item.statement}) needs: ${item.verify_by.join(", ")}`)
                    .join("\n"));
        }
    }
}
