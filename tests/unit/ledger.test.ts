import { strict as assert } from "node:assert";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { acquireWriter, Ledger, parseLedger, readLedger } from "../../src/kernel/ledger/ledger.ts";
import { reduce } from "../../src/kernel/task/state.ts";
import { tempDir } from "../helpers.ts";

const created = { workflow: "coding", goal: "g", repo: "/r", worktree: "/w", branch: "b", baseCommit: "c" };

test("appends numbered events and replays them", () => {
    let dir = tempDir();
    let ledger = new Ledger(dir, "t1", () => new Date("2026-09-25T00:00:00Z"));
    ledger.append("TaskCreated", created);
    ledger.append("StepStarted", { attempt: 1 }, "plan");
    let events = readLedger(dir);
    assert.deepEqual(events.map(e => [e.seq, e.type, e.stepId]), [[1, "TaskCreated", undefined], [2, "StepStarted", "plan"]]);
    assert.equal(events[0].v, 1);
    assert.equal(reduce(events)!.steps.plan.attempt, 1);
});

test("a crash-truncated last line is skipped and repaired before the next append", () => {
    let dir = tempDir();
    let ledger = new Ledger(dir, "t1");
    ledger.append("TaskCreated", created);
    appendFileSync(ledger.file, '{"v":1,"seq":2,"ty');
    assert.equal(readLedger(dir).length, 1);
    let reopened = new Ledger(dir, "t1");
    reopened.append("StepStarted", { attempt: 1 }, "plan");
    assert.deepEqual(readLedger(dir).map(e => e.seq), [1, 2]);
});

test("a complete event missing its newline is kept and terminated", () => {
    let dir = tempDir();
    let ledger = new Ledger(dir, "t1");
    ledger.append("TaskCreated", created);
    writeFileSync(ledger.file, readFileSync(ledger.file, "utf8").trimEnd());
    new Ledger(dir, "t1").append("StepStarted", { attempt: 1 }, "plan");
    assert.deepEqual(readLedger(dir).map(e => e.seq), [1, 2]);
});

test("corruption before the last line throws", () => {
    assert.throws(() => parseLedger('{"v":1,"seq":1}\nnot json\n{"v":1,"seq":3}\n'), /corrupt at line 2/);
});

test("events from a newer Flow are refused", () => {
    assert.throws(() => parseLedger('{"v":99,"seq":1,"type":"TaskCreated"}\n'), /Upgrade Flow/);
});

test("only one writer per task; a dead writer's lock is reclaimed", () => {
    let dir = tempDir();
    let release = acquireWriter(dir);
    assert.throws(() => acquireWriter(dir), /already being run/);
    release();
    writeFileSync(join(dir, "writer.lock"), "999999999");
    acquireWriter(dir)();
});
