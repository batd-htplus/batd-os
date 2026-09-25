import type { CheckEvidence, CheckReason } from "./events.ts";

/** A named deterministic check, declared in a pack or the project config. */
export type CheckSpec =
    | { kind: "command"; run: string; timeoutMs?: number }
    | { kind: "file-exists"; path: string }
    | { kind: "plan-has-acceptance" }
    | { kind: "acceptance-covered" };

export type CheckResult = {
    check: string;
    pass: boolean;
    reasons: CheckReason[];
    evidence: CheckEvidence;
};

/** One acceptance criterion (artifacts/acceptance.json). */
export type AcceptanceItem = {
    id: string;
    statement: string;
    source: string;
    verify_by: string[];
};
