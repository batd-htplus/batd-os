import { strict as assert } from "node:assert";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { NodeProcessRunner } from "../../src/adapters/shell/process-runner.ts";
import { parseAcceptance, runCheck, type CheckContext } from "../../src/kernel/check/checks.ts";
import { tempDir } from "../helpers.ts";

function context(passed: string[] = []): CheckContext {
    let taskDir = tempDir();
    let artifactsDir = join(taskDir, "artifacts");
    mkdirSync(artifactsDir);
    return { runner: new NodeProcessRunner(), worktree: tempDir(), artifactsDir, passed, logName: "t", taskDir };
}

test("command checks record evidence and return the output tail as feedback", async () => {
    let ctx = context();
    let pass = await runCheck("ok", { kind: "command", run: "echo fine" }, ctx);
    assert.equal(pass.pass, true);
    assert.equal(pass.evidence.exitCode, 0);
    assert.match(readFileSync(join(ctx.taskDir, pass.evidence.outputArtifact!), "utf8"), /fine/);
    let fail = await runCheck("bad", { kind: "command", run: "echo boom >&2; exit 3" }, ctx);
    assert.equal(fail.pass, false);
    assert.match(fail.reasons[0].rule, /exit 0 \(got 3\)/);
    assert.match(fail.reasons[0].fix, /boom/);
});

test("command checks time out", async () => {
    let result = await runCheck("slow", { kind: "command", run: "sleep 5", timeoutMs: 200 }, context());
    assert.equal(result.pass, false);
    assert.match(result.reasons[0].rule, /within 200ms/);
});

test("parseAcceptance takes the last json block with items", () => {
    let plan = 'text\n```json\n{"items":[{"id":"AC-1","statement":"s","source":"task","verify_by":["test"]}]}\n```\n';
    let items = parseAcceptance(plan);
    assert.ok(Array.isArray(items) && items[0].id === "AC-1");
    assert.match(String(parseAcceptance("no block")), /no ```json/);
    assert.match(String(parseAcceptance('```json\n{"items":[{"id":"x"}]}\n```')), /needs id, statement, verify_by/);
});

test("plan-has-acceptance writes acceptance.json; acceptance-covered needs its checks passed", async () => {
    let ctx = context();
    writeFileSync(join(ctx.artifactsDir, "plan.md"),
        '```json\n{"items":[{"id":"AC-1","statement":"s","source":"task","verify_by":["test"]}]}\n```');
    assert.equal((await runCheck("p", { kind: "plan-has-acceptance" }, ctx)).pass, true);
    let uncovered = await runCheck("a", { kind: "acceptance-covered" }, ctx);
    assert.equal(uncovered.pass, false);
    assert.match(uncovered.reasons[0].fix, /AC-1/);
    assert.equal((await runCheck("a", { kind: "acceptance-covered" }, { ...ctx, passed: ["test"] })).pass, true);
});
