import { runConvergenceSimulation } from "../testing/convergenceSimulator.js";

const clients = Number.parseInt(process.env.CONVERGENCE_CLIENTS || "10", 10);
const operations = Number.parseInt(process.env.CONVERGENCE_OPERATIONS || "1000", 10);
const seed = Number.parseInt(process.env.CONVERGENCE_SEED || "1592594996", 10);

const startedAt = performance.now();
const result = runConvergenceSimulation({ clients, operations, seed });
const durationMs = Math.round(performance.now() - startedAt);

console.log(JSON.stringify({ clients, operations, seed, durationMs, ...result }, null, 2));
if (!result.converged) process.exitCode = 1;
