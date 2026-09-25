import { strict as assert } from "node:assert";
import { test } from "node:test";
import { auditChanges, decide, type Grants } from "../../src/kernel/policy/policy.ts";
import { tempDir } from "../helpers.ts";

const grants = (extra: Partial<Grants> = {}): Grants =>
    ({ worktree: tempDir(), exec: ["npm test"], network: false, approved: [], ...extra });

test("writes stay inside the worktree", () => {
    let g = grants();
    assert.equal(decide({ effect: "write", path: "src/a.ts" }, g).decision, "allow");
    assert.equal(decide({ effect: "write", path: "../escape.ts" }, g).decision, "deny");
    assert.equal(decide({ effect: "write", path: "/etc/passwd" }, g).decision, "deny");
});

test("protected configuration asks, and an approval allows it", () => {
    let decision = decide({ effect: "write", path: "eslint.config.js" }, grants());
    assert.deepEqual(decision.decision, "ask");
    assert.equal(decision.decision === "ask" && decision.subject, "policy:write:eslint.config.js");
    let approved = grants({ approved: ["policy:write:eslint.config.js"] });
    assert.equal(decide({ effect: "write", path: "eslint.config.js" }, approved).decision, "allow");
    assert.equal(auditChanges(["src/a.ts", ".github/workflows/ci.yml"], grants()).decision, "ask");
});

test("exec follows the declared allowlist and never bypasses git hooks", () => {
    let g = grants({ exec: ["npm test", "git commit"] });
    assert.equal(decide({ effect: "exec", command: "npm test -- --watch=false" }, g).decision, "allow");
    assert.equal(decide({ effect: "exec", command: "npm testing" }, g).decision, "ask");
    assert.equal(decide({ effect: "exec", command: "git commit --no-verify -m x" }, g).decision, "deny");
    assert.equal(decide({ effect: "exec", command: "git -c core.hooksPath=/dev/null commit" }, g).decision, "deny");
});

test("network is denied unless granted; git push asks", () => {
    assert.equal(decide({ effect: "net", target: "x" }, grants()).decision, "deny");
    assert.equal(decide({ effect: "net", target: "x" }, grants({ network: true })).decision, "allow");
    assert.equal(decide({ effect: "git", op: "push" }, grants()).decision, "ask");
});
