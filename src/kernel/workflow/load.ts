import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CheckSpec } from "../../contracts/check.ts";
import type { ProjectConfig, StepDef, WorkflowDef } from "../../contracts/flow-schema.ts";
import type { PackDef } from "../../contracts/pack-schema.ts";

export type LoadedPack = { def: PackDef; instructions: string };

const CHECK_KINDS = new Set(["command", "file-exists", "plan-has-acceptance", "acceptance-covered"]);

export function readJson<T>(file: string): T {
    try {
        return JSON.parse(readFileSync(file, "utf8")) as T;
    } catch (err) {
        throw new Error(`${file}: ${(err as Error).message}`);
    }
}

export function loadPack(dir: string): LoadedPack {
    let def = readJson<PackDef>(join(dir, "pack.json"));
    let instructions = def.instructions === undefined ? "" : readFileSync(join(dir, def.instructions), "utf8");
    return { def, instructions };
}

export function loadConfig(flowDir: string): ProjectConfig {
    let file = join(flowDir, "config.json");
    return existsSync(file) ? readJson<ProjectConfig>(file) : {};
}

/** Pack checks overlaid by project checks (the project wins). */
export function checkRegistry(pack: PackDef, config: ProjectConfig): Record<string, CheckSpec> {
    let registry = { ...pack.checks, ...config.checks };
    for (let [name, spec] of Object.entries(registry)) {
        if (!CHECK_KINDS.has(spec.kind)) {
            throw new Error(`check "${name}": unknown kind "${spec.kind}" (use ${[...CHECK_KINDS].join(", ")})`);
        }
        if (spec.kind === "command" && (typeof spec.run !== "string" || spec.run.trim() === "")) {
            throw new Error(`check "${name}": command checks need "run"`);
        }
    }
    return registry;
}

/** Finds a workflow by name: the project's .flow/flows first, then Flow's built-in flows. */
export function findWorkflow(name: string, flowDir: string, builtinFlowsDir: string): string {
    if (name.endsWith(".json") && existsSync(name)) return name;
    for (let dir of [join(flowDir, "flows"), builtinFlowsDir]) {
        let file = join(dir, `${name}.json`);
        if (existsSync(file)) return file;
    }
    throw new Error(`workflow "${name}" not found in ${join(flowDir, "flows")} or ${builtinFlowsDir}`);
}

export function loadWorkflow(file: string, checks: Record<string, CheckSpec>): WorkflowDef {
    let def = readJson<WorkflowDef>(file);
    let errors: string[] = [];
    let at = (path: string, message: string) => errors.push(`${path}: ${message}`);
    if (typeof def.id !== "string") at("id", "must be a string");
    if (def.version !== 1) at("version", "must be 1");
    if (!Array.isArray(def.steps) || def.steps.length === 0) at("steps", "must be a non-empty array");
    let seen = new Set<string>();
    for (let [index, step] of (def.steps ?? []).entries()) {
        let path = `steps[${index}]`;
        if (typeof step.id !== "string" || !/^[a-z][a-z0-9-]*$/.test(step.id)) {
            at(`${path}.id`, "must match ^[a-z][a-z0-9-]*$");
        } else if (seen.has(step.id)) {
            at(`${path}.id`, `duplicate step id "${step.id}"`);
        }
        seen.add(step.id);
        if (typeof step.instructions !== "string" || step.instructions.trim() === "") {
            at(`${path}.instructions`, "must be a non-empty string");
        }
        for (let check of step.checks ?? []) {
            if (!(check in checks)) {
                at(`${path}.checks`, `unknown check "${check}"; define it in .flow/config.json "checks"`);
            }
        }
        if (step.retry !== undefined && !(Number.isInteger(step.retry) && step.retry >= 0)) {
            at(`${path}.retry`, "must be an integer >= 0");
        }
    }
    if (errors.length > 0) throw new Error(`${file} is invalid:\n  ${errors.join("\n  ")}`);
    return def;
}

export const stepById = (def: WorkflowDef, id: string): StepDef => {
    let step = def.steps.find(s => s.id === id);
    if (step === undefined) throw new Error(`workflow ${def.id} has no step "${id}"`);
    return step;
};
