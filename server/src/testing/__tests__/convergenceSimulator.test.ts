import { describe, expect, it } from "vitest";
import { runConvergenceSimulation } from "../convergenceSimulator.js";

describe("randomized CRDT convergence simulator", () => {
  it.each([11, 29, 97])(
    "converges clients and two backend states with seed %s",
    (seed) => {
      const result = runConvergenceSimulation({
        clients: 8,
        operations: 400,
        seed,
        duplicateRate: 0.2,
        immediateDeliveryRate: 0.35,
      });
      expect(result.generatedUpdates).toBeGreaterThan(250);
      expect(result.duplicateDeliveries).toBeGreaterThan(0);
      expect(result.delayedDeliveries).toBeGreaterThan(0);
      expect(result.converged).toBe(true);
      expect(new Set(result.clientHashes)).toEqual(new Set([result.serverHash]));
    }
  );
});
