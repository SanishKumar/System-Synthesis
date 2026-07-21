import { describe, expect, it } from "vitest";
import {
  dockerComposeAdapter,
  reviewArchitectureChange,
  validationToSarif,
} from "../index.js";

const baseCompose = `services:
  api:
    image: ghcr.io/acme/api:1.0.0
    ports:
      - "8080:3000"
  database:
    image: postgres:16
    healthcheck:
      test: ["CMD-SHELL", "pg_isready"]
`;

const headCompose = `services:
  api:
    image: ghcr.io/acme/api:1.0.0
    ports:
      - "8080:3000"
    depends_on:
      database:
        condition: service_healthy
  database:
    image: postgres:16
    healthcheck:
      test: ["CMD-SHELL", "pg_isready"]
`;

function imported(content: string, revision: string) {
  return dockerComposeAdapter.import(
    [{ path: "compose.yaml", content }],
    { repository: "acme/shop", revision }
  ).graph;
}

describe("architecture change reviews", () => {
  it("fails a newly introduced public-to-persistence dependency with evidence", () => {
    const review = reviewArchitectureChange(
      imported(baseCompose, "base-sha"),
      imported(headCompose, "head-sha"),
      {},
      "2026-07-19T00:00:00.000Z"
    );

    expect(review.status).toBe("fail");
    expect(review.diff.stats).toMatchObject({ added: 1, total: 1 });
    expect(review.impacts.map((impact) => impact.kind)).toEqual(
      expect.arrayContaining([
        "dependency-added",
        "trust-boundary-crossing-added",
        "blast-radius-increased",
      ])
    );
    expect(review.newFindings.map((finding) => finding.ruleId)).toEqual(
      expect.arrayContaining([
        "compose-public-service-to-persistence",
        "unmediated-trust-boundary",
      ])
    );
    expect(review.blockingFindings).toHaveLength(1);
    expect(review.blockingFindings[0]).toMatchObject({
      ruleId: "compose-public-service-to-persistence",
      severity: "warning",
      locations: expect.arrayContaining([
        expect.objectContaining({
          file: "compose.yaml",
          sourceAddress: "services.api.depends_on.database",
        }),
      ]),
    });
  });

  it("does not report formatting-only source movement as architecture change", () => {
    const reformatted = `services:

  database:
    healthcheck: { test: ["CMD-SHELL", "pg_isready"] }
    image: postgres:16

  api:
    ports: ["8080:3000"]
    image: ghcr.io/acme/api:1.0.0
`;
    const review = reviewArchitectureChange(
      imported(baseCompose, "base"),
      imported(reformatted, "head"),
      {},
      "2026-07-19T00:00:00.000Z"
    );

    expect(review.diff.changes).toEqual([]);
    expect(review.impacts).toEqual([]);
    expect(review.newFindings).toEqual([]);
    expect(review.status).toBe("pass");
  });

  it("blocks a newly published database port as critical", () => {
    const head = baseCompose.replace(
      "    image: postgres:16",
      "    image: postgres:16\n    ports: [\"5432:5432\"]"
    );
    const review = reviewArchitectureChange(
      imported(baseCompose, "base"),
      imported(head, "head"),
      {},
      "2026-07-19T00:00:00.000Z"
    );

    expect(review.status).toBe("fail");
    expect(review.impacts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "public-exposure-added",
        severity: "critical",
        after: ["5432:5432"],
      }),
    ]));
    expect(review.blockingFindings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        ruleId: "compose-published-persistence-port",
        severity: "critical",
      }),
    ]));
  });

  it("accepts a scoped, justified, unexpired suppression", () => {
    const preliminary = reviewArchitectureChange(
      imported(baseCompose, "base"),
      imported(headCompose, "head"),
      {},
      "2026-07-19T00:00:00.000Z"
    );
    const finding = preliminary.blockingFindings[0];
    const review = reviewArchitectureChange(
      imported(baseCompose, "base"),
      imported(headCompose, "head"),
      {
        suppressions: [{
          id: "accepted-boundary-1",
          ruleId: finding.ruleId,
          findingId: finding.id,
          justification: "API owns this database; tracked in ADR-014.",
          ticket: "ADR-014",
          createdBy: "platform-team",
          createdAt: "2026-07-18T00:00:00.000Z",
          expiresAt: "2026-08-19T00:00:00.000Z",
        }],
      },
      "2026-07-19T00:00:00.000Z"
    );

    expect(review.status).toBe("pass");
    expect(review.blockingFindings).toEqual([]);
    expect(review.suppressedFindings).toHaveLength(1);
    expect(review.suppressedFindings[0].suppression.ticket).toBe("ADR-014");
  });

  it("does not apply expired or blank-justification suppressions", () => {
    const review = reviewArchitectureChange(
      imported(baseCompose, "base"),
      imported(headCompose, "head"),
      {
        suppressions: [{
          ruleId: "compose-public-service-to-persistence",
          justification: "Temporary exception",
          expiresAt: "2026-07-18T00:00:00.000Z",
        }, {
          ruleId: "unmediated-trust-boundary",
          justification: " ",
          expiresAt: "2026-08-18T00:00:00.000Z",
        }],
      },
      "2026-07-19T00:00:00.000Z"
    );

    expect(review.status).toBe("fail");
    expect(review.suppressedFindings).toEqual([]);
  });

  it("supports explicit rule disabling and severity policy overrides", () => {
    const review = reviewArchitectureChange(
      imported(baseCompose, "base"),
      imported(headCompose, "head"),
      {
        failOn: ["warning"],
        rules: {
          "compose-public-service-to-persistence": { enabled: false },
          "unmediated-trust-boundary": { severity: "info" },
        },
      },
      "2026-07-19T00:00:00.000Z"
    );

    expect(review.newFindings.some(
      (finding) => finding.ruleId === "compose-public-service-to-persistence"
    )).toBe(false);
    expect(review.newFindings.find(
      (finding) => finding.ruleId === "unmediated-trust-boundary"
    )?.severity).toBe("info");
    expect(review.status).toBe("pass");
  });

  it("emits SARIF locations from deterministic source provenance", () => {
    const review = reviewArchitectureChange(
      imported(baseCompose, "base"),
      imported(headCompose, "head"),
      {},
      "2026-07-19T00:00:00.000Z"
    );
    const sarif = validationToSarif({
      ...review.headValidation,
      issues: review.newFindings,
    });

    expect(sarif.runs[0].results).toEqual(expect.arrayContaining([
      expect.objectContaining({
        ruleId: "compose-public-service-to-persistence",
        locations: expect.arrayContaining([
          expect.objectContaining({
            physicalLocation: expect.objectContaining({
              artifactLocation: { uri: "compose.yaml" },
              region: expect.objectContaining({ startLine: 8 }),
            }),
          }),
        ]),
      }),
    ]));
  });
});
