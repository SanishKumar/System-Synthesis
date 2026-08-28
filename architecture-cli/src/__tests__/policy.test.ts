import { describe, expect, it } from "vitest";
import { parseArchitecturePolicy } from "../policy.js";

describe("architecture decision policy", () => {
  it.each(["forbidden", "sole_reviewer", "admin_override"] as const)(
    "preserves the %s self-approval policy",
    (selfApproval) => {
      expect(
        parseArchitecturePolicy(JSON.stringify({ decision: { selfApproval } }))
      ).toEqual({ decision: { selfApproval } });
    }
  );

  it("refuses an invalid decision object instead of silently changing its meaning", () => {
    expect(() =>
      parseArchitecturePolicy(JSON.stringify({ decision: "sole_reviewer" }))
    ).toThrow("Policy decision must be an object");
    expect(() =>
      parseArchitecturePolicy(
        JSON.stringify({ decision: { selfApproval: "sometimes" } })
      )
    ).toThrow("Policy decision.selfApproval");
  });
});
