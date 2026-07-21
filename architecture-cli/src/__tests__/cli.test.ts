import { describe, expect, it } from "vitest";
import { runCli, type CliIO } from "../cli.js";

const baseCompose = `services:
  api:
    image: acme/api:1.0.0
    ports: ["8080:3000"]
  database:
    image: postgres:16
    healthcheck:
      test: ["CMD-SHELL", "pg_isready"]
`;

const riskyHead = `services:
  api:
    image: acme/api:1.0.0
    ports: ["8080:3000"]
    depends_on:
      database:
        condition: service_healthy
  database:
    image: postgres:16
    healthcheck:
      test: ["CMD-SHELL", "pg_isready"]
`;

function harness(files: Record<string, string>) {
  let stdout = "";
  let stderr = "";
  const writes = new Map<string, string>();
  const io: CliIO = {
    readFile(path) {
      if (!(path in files)) throw new Error(`Missing fixture: ${path}`);
      return files[path];
    },
    writeFile(path, content) {
      writes.set(path, content);
    },
    stdout(message) {
      stdout += message;
    },
    stderr(message) {
      stderr += message;
    },
    now: () => new Date("2026-07-19T10:00:00.000Z"),
  };
  return {
    io,
    writes,
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

describe("architecture CLI", () => {
  it("returns exit 1 and deterministic JSON for a blocking change", () => {
    const test = harness({
      "base/compose.yaml": baseCompose,
      "head/compose.yaml": riskyHead,
    });
    const exitCode = runCli([
      "review",
      "--base", "base/compose.yaml",
      "--head", "head/compose.yaml",
      "--source-path", "compose.yaml",
      "--base-revision", "abc123",
      "--head-revision", "def456",
      "--repository", "acme/shop",
      "--format", "json",
    ], test.io);

    expect(exitCode).toBe(1);
    expect(test.stderr()).toBe("");
    const report = JSON.parse(test.stdout());
    expect(report).toMatchObject({
      status: "fail",
      reviewedAt: "2026-07-19T10:00:00.000Z",
      base: { revision: "abc123", repository: "acme/shop" },
      head: { revision: "def456", repository: "acme/shop" },
    });
    expect(report.blockingFindings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        ruleId: "compose-public-service-to-persistence",
      }),
    ]));
  });

  it("returns exit 0 and a concise Markdown report for a safe change", () => {
    const test = harness({
      "base/compose.yaml": baseCompose,
      "head/compose.yaml": baseCompose,
    });
    const exitCode = runCli([
      "review",
      "--base", "base/compose.yaml",
      "--head", "head/compose.yaml",
      "--source-path", "compose.yaml",
      "--format", "markdown",
    ], test.io);

    expect(exitCode).toBe(0);
    expect(test.stdout()).toContain("Architecture change review: passed");
    expect(test.stdout()).toContain("No architecture impact detected");
    expect(test.stdout()).toContain("An LLM is not used to create findings");
  });

  it("emits SARIF containing repository-relative source evidence", () => {
    const test = harness({
      "base/compose.yaml": baseCompose,
      "head/compose.yaml": riskyHead,
    });
    const exitCode = runCli([
      "review",
      "--base", "base/compose.yaml",
      "--head", "head/compose.yaml",
      "--source-path", "deploy/compose.yaml",
      "--format", "sarif",
    ], test.io);

    expect(exitCode).toBe(1);
    const sarif = JSON.parse(test.stdout());
    expect(sarif.version).toBe("2.1.0");
    expect(sarif.runs[0].results).toEqual(expect.arrayContaining([
      expect.objectContaining({
        ruleId: "compose-public-service-to-persistence",
        locations: expect.arrayContaining([
          expect.objectContaining({
            physicalLocation: expect.objectContaining({
              artifactLocation: { uri: "deploy/compose.yaml" },
            }),
          }),
        ]),
      }),
    ]));
  });

  it("writes a report and preserves the policy exit code", () => {
    const test = harness({
      "base/compose.yaml": baseCompose,
      "head/compose.yaml": riskyHead,
    });
    const exitCode = runCli([
      "review",
      "--base", "base/compose.yaml",
      "--head", "head/compose.yaml",
      "--source-path", "compose.yaml",
      "--format", "markdown",
      "--output", "artifacts/review.md",
    ], test.io);

    expect(exitCode).toBe(1);
    expect(test.stdout()).toBe("");
    expect(test.writes.get("artifacts/review.md")).toContain(
      "Architecture change review: changes requested"
    );
  });

  it("loads validated policy JSON and applies an accepted exception", () => {
    const test = harness({
      "base/compose.yaml": baseCompose,
      "head/compose.yaml": riskyHead,
      "architecture-policy.json": JSON.stringify({
        suppressions: [{
          ruleId: "compose-public-service-to-persistence",
          justification: "Service owns the data store; see ADR-014.",
          ticket: "ADR-014",
          expiresAt: "2026-08-19T00:00:00.000Z",
        }],
      }),
    });
    const exitCode = runCli([
      "review",
      "--base", "base/compose.yaml",
      "--head", "head/compose.yaml",
      "--source-path", "compose.yaml",
      "--policy", "architecture-policy.json",
      "--format", "markdown",
    ], test.io);

    expect(exitCode).toBe(0);
    expect(test.stdout()).toContain("Accepted exceptions");
    expect(test.stdout()).toContain("ADR-014");
  });

  it("returns exit 2 for invalid policies and malformed Compose input", () => {
    const invalidPolicy = harness({
      "base/compose.yaml": baseCompose,
      "head/compose.yaml": riskyHead,
      "architecture-policy.json": JSON.stringify({
        suppressions: [{
          ruleId: "rule",
          justification: " ",
        }],
      }),
    });
    expect(runCli([
      "review",
      "--base", "base/compose.yaml",
      "--head", "head/compose.yaml",
      "--policy", "architecture-policy.json",
    ], invalidPolicy.io)).toBe(2);
    expect(invalidPolicy.stderr()).toContain("non-empty justification");

    const invalidCompose = harness({ "compose.yaml": "services:\n  api: [" });
    expect(runCli([
      "import",
      "--file", "compose.yaml",
    ], invalidCompose.io)).toBe(2);
    expect(invalidCompose.stderr()).toContain("compose.yaml.invalid");
  });

  it("imports a Compose file into canonical graph JSON", () => {
    const test = harness({ "compose.yaml": baseCompose });
    const exitCode = runCli([
      "import",
      "--file", "compose.yaml",
      "--repository", "acme/shop",
      "--revision", "abc123",
    ], test.io);

    expect(exitCode).toBe(0);
    const imported = JSON.parse(test.stdout());
    expect(imported.graph.source).toMatchObject({
      adapter: "docker-compose",
      repository: "acme/shop",
      revision: "abc123",
    });
    expect(imported.graph.nodes).toHaveLength(2);
  });
});
