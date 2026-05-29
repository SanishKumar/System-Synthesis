/**
 * Terraform Export — Unit Tests
 *
 * Validates that the Terraform generator produces valid HCL bundles
 * with correct resource types for each node type.
 */

import { describe, it, expect } from "vitest";
import { generateTerraform } from "../../services/export/terraform.js";
import type { SerializedNode, SerializedEdge } from "@system-synthesis/shared";

// ── Helpers ──────────────────────────────────────────────────────────

function makeNode(
  id: string,
  nodeType: string,
  overrides: Record<string, unknown> = {}
): SerializedNode {
  return {
    id,
    type: "architectureNode",
    position: { x: 0, y: 0 },
    data: {
      label: id,
      nodeType,
      status: "active",
      metadata: { notes: "", links: [], codeSnippet: "", attachedFiles: [] },
      ...overrides,
    },
  } as SerializedNode;
}

// ── Tests ────────────────────────────────────────────────────────────

describe("generateTerraform", () => {
  it("returns a bundle with main.tf, variables.tf, outputs.tf", () => {
    const bundle = generateTerraform(
      [makeNode("api", "service", { label: "API" })],
      []
    );
    expect(bundle).toHaveProperty("main.tf");
    expect(bundle).toHaveProperty("variables.tf");
    expect(bundle).toHaveProperty("outputs.tf");
  });

  it("main.tf contains VPC foundation", () => {
    const bundle = generateTerraform(
      [makeNode("api", "service", { label: "API" })],
      []
    );
    expect(bundle["main.tf"]).toContain("aws_vpc");
    expect(bundle["main.tf"]).toContain("aws_subnet");
    expect(bundle["main.tf"]).toContain("aws_internet_gateway");
    expect(bundle["main.tf"]).toContain("aws_ecs_cluster");
  });

  it("maps database node to aws_db_instance", () => {
    const bundle = generateTerraform(
      [makeNode("db", "database", { label: "Main DB" })],
      []
    );
    expect(bundle["main.tf"]).toContain("aws_db_instance");
    expect(bundle["main.tf"]).toContain("postgres");
  });

  it("maps cache node to aws_elasticache_cluster", () => {
    const bundle = generateTerraform(
      [makeNode("cache", "cache", { label: "Redis Cache" })],
      []
    );
    expect(bundle["main.tf"]).toContain("aws_elasticache_cluster");
    expect(bundle["main.tf"]).toContain("redis");
  });

  it("maps queue node to aws_sqs_queue", () => {
    const bundle = generateTerraform(
      [makeNode("q", "queue", { label: "Job Queue" })],
      []
    );
    expect(bundle["main.tf"]).toContain("aws_sqs_queue");
  });

  it("maps Kafka queue to aws_msk_cluster", () => {
    const bundle = generateTerraform(
      [makeNode("q", "queue", { label: "Event Bus", tech: "Kafka" })],
      []
    );
    expect(bundle["main.tf"]).toContain("aws_msk_cluster");
  });

  it("maps gateway to aws_apigatewayv2_api", () => {
    const bundle = generateTerraform(
      [makeNode("gw", "gateway", { label: "API Gateway" })],
      []
    );
    expect(bundle["main.tf"]).toContain("aws_apigatewayv2_api");
  });

  it("maps loadbalancer to aws_lb", () => {
    const bundle = generateTerraform(
      [makeNode("lb", "loadbalancer", { label: "ALB" })],
      []
    );
    expect(bundle["main.tf"]).toContain("aws_lb");
    expect(bundle["main.tf"]).toContain("application");
  });

  it("maps storage to aws_s3_bucket with versioning", () => {
    const bundle = generateTerraform(
      [makeNode("s", "storage", { label: "Assets" })],
      []
    );
    expect(bundle["main.tf"]).toContain("aws_s3_bucket");
    expect(bundle["main.tf"]).toContain("aws_s3_bucket_versioning");
  });

  it("maps service to ECS Fargate (task def + service)", () => {
    const bundle = generateTerraform(
      [makeNode("api", "service", { label: "API", instances: 2 })],
      []
    );
    expect(bundle["main.tf"]).toContain("aws_ecs_task_definition");
    expect(bundle["main.tf"]).toContain("aws_ecs_service");
    expect(bundle["main.tf"]).toContain("desired_count   = 2");
  });

  it("variables.tf contains expected variables", () => {
    const bundle = generateTerraform([], []);
    expect(bundle["variables.tf"]).toContain("project_name");
    expect(bundle["variables.tf"]).toContain("aws_region");
    expect(bundle["variables.tf"]).toContain("db_password");
  });

  it("outputs.tf contains outputs for nodes with outputs", () => {
    const bundle = generateTerraform(
      [
        makeNode("db", "database", { label: "Main DB" }),
        makeNode("lb", "loadbalancer", { label: "ALB" }),
      ],
      []
    );
    expect(bundle["outputs.tf"]).toContain("endpoint");
    expect(bundle["outputs.tf"]).toContain("dns_name");
  });

  it("handles empty board gracefully", () => {
    const bundle = generateTerraform([], []);
    expect(bundle["main.tf"]).toContain("terraform");
    expect(bundle["variables.tf"]).toBeTruthy();
    expect(bundle["outputs.tf"]).toBeTruthy();
  });
});
