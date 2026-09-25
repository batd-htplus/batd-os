export type Effect = "read" | "write" | "exec" | "net" | "git";

export type PolicyRequest =
    | { effect: "read"; path: string }
    | { effect: "write"; path: string }
    | { effect: "exec"; command: string }
    | { effect: "net"; target: string }
    | { effect: "git"; op: "push" | "merge" | "reset" };

export type PolicyDecision =
    | { decision: "allow" }
    | { decision: "ask"; subject: string; reason: string }
    | { decision: "deny"; reason: string };
