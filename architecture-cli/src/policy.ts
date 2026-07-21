import type {
  ArchitecturePolicy,
  RuleSuppression,
} from "@system-synthesis/architecture-core";
import type { ValidationSeverity } from "@system-synthesis/shared";

const SEVERITIES = new Set<ValidationSeverity>([
  "critical",
  "warning",
  "info",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function optionalString(
  object: Record<string, unknown>,
  key: string
): string | undefined {
  const value = object[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new Error(`Policy field "${key}" must be a string.`);
  }
  return value;
}

function parseSuppression(value: unknown, index: number): RuleSuppression {
  if (!isRecord(value)) {
    throw new Error(`Policy suppression ${index} must be an object.`);
  }
  if (typeof value.ruleId !== "string" || !value.ruleId.trim()) {
    throw new Error(`Policy suppression ${index} requires ruleId.`);
  }
  if (typeof value.justification !== "string" || !value.justification.trim()) {
    throw new Error(`Policy suppression ${index} requires a non-empty justification.`);
  }
  return {
    ruleId: value.ruleId,
    justification: value.justification,
    id: optionalString(value, "id"),
    findingId: optionalString(value, "findingId"),
    nodeId: optionalString(value, "nodeId"),
    edgeId: optionalString(value, "edgeId"),
    sourceAddress: optionalString(value, "sourceAddress"),
    createdBy: optionalString(value, "createdBy"),
    createdAt: optionalString(value, "createdAt"),
    expiresAt: optionalString(value, "expiresAt"),
    ticket: optionalString(value, "ticket"),
  };
}

export function parseArchitecturePolicy(content: string): ArchitecturePolicy {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw new Error("Policy file must contain valid JSON.");
  }
  if (!isRecord(value)) throw new Error("Policy root must be an object.");

  const policy: ArchitecturePolicy = {};
  if (value.failOn !== undefined) {
    if (
      !Array.isArray(value.failOn) ||
      !value.failOn.every(
        (severity): severity is ValidationSeverity =>
          typeof severity === "string" &&
          SEVERITIES.has(severity as ValidationSeverity)
      )
    ) {
      throw new Error("Policy failOn must contain only critical, warning, or info.");
    }
    policy.failOn = value.failOn;
  }
  if (value.includeExistingFindings !== undefined) {
    if (typeof value.includeExistingFindings !== "boolean") {
      throw new Error("Policy includeExistingFindings must be a boolean.");
    }
    policy.includeExistingFindings = value.includeExistingFindings;
  }
  if (value.rules !== undefined) {
    if (!isRecord(value.rules)) throw new Error("Policy rules must be an object.");
    policy.rules = Object.fromEntries(
      Object.entries(value.rules).map(([ruleId, configuration]) => {
        if (!isRecord(configuration)) {
          throw new Error(`Policy rule "${ruleId}" must be an object.`);
        }
        if (
          configuration.enabled !== undefined &&
          typeof configuration.enabled !== "boolean"
        ) {
          throw new Error(`Policy rule "${ruleId}".enabled must be a boolean.`);
        }
        if (
          configuration.blockMerge !== undefined &&
          typeof configuration.blockMerge !== "boolean"
        ) {
          throw new Error(`Policy rule "${ruleId}".blockMerge must be a boolean.`);
        }
        if (
          configuration.severity !== undefined &&
          (
            typeof configuration.severity !== "string" ||
            !SEVERITIES.has(configuration.severity as ValidationSeverity)
          )
        ) {
          throw new Error(
            `Policy rule "${ruleId}".severity must be critical, warning, or info.`
          );
        }
        return [ruleId, {
          enabled: configuration.enabled as boolean | undefined,
          blockMerge: configuration.blockMerge as boolean | undefined,
          severity: configuration.severity as ValidationSeverity | undefined,
        }];
      })
    );
  }
  if (value.suppressions !== undefined) {
    if (!Array.isArray(value.suppressions)) {
      throw new Error("Policy suppressions must be an array.");
    }
    policy.suppressions = value.suppressions.map(parseSuppression);
  }
  return policy;
}
