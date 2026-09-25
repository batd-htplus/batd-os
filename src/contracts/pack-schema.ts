import type { CheckSpec } from "./check.ts";

/** Reusable Flow content (packs/<id>/pack.json). Data, not a runtime. */
export type PackDef = {
    id: string;
    instructions?: string;
    checks?: Record<string, CheckSpec>;
};
