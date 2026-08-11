import { describe, expect, it } from "vitest";
import { COMPOSE_ADAPTER_VERSION, dockerComposeAdapter } from "../index.js";
import { canonicalGraphFingerprint } from "../provenance.js";

/**
 * Exercises every relationship source and classification path the adapter
 * claims to model, so a change in extraction shows up here. The loopback
 * binding is deliberate: without one the fixture could not detect a change to
 * host-address handling or zone assignment.
 */
const FIXTURE = `name: shop
services:
  gateway:
    image: nginx:1.27
    ports:
      - "443:8443"
    environment:
      UPSTREAM: http://api:3000
  api:
    build:
      context: ./api
    expose:
      - "3000"
    depends_on:
      database:
        condition: service_healthy
    environment:
      - CACHE_URL=redis://cache:6379
      - QUEUE=broker:5672
      - LOG_LEVEL=info
    networks: [private]
    deploy:
      replicas: 3
  database:
    image: postgres:16
    ports:
      - "127.0.0.1:5432:5432"
    volumes:
      - data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready"]
  cache:
    image: redis:7-alpine
  broker:
    image: rabbitmq:3
networks:
  private: {}
volumes:
  data: {}
`;

/**
 * Pinned extraction output. A change here means the same source now produces a
 * different graph, which is exactly when COMPOSE_ADAPTER_VERSION must be
 * reconsidered. Update both together, deliberately.
 */
const PINNED_FINGERPRINT = "ac41dbc8cfa7163b";

describe("Compose import version", () => {
  const { graph } = dockerComposeAdapter.import([
    { path: "compose.yaml", content: FIXTURE },
  ]);

  it("stamps the extraction contract on the graph", () => {
    expect(graph.source.adapterVersion).toBe(COMPOSE_ADAPTER_VERSION);
    expect(graph.source.adapter).toBe("docker-compose");
  });

  it("pins extraction output so a change forces a version decision", () => {
    expect(canonicalGraphFingerprint(graph)).toBe(PINNED_FINGERPRINT);
  });

  it("keeps the version out of the content fingerprint", () => {
    const restamped = {
      ...graph,
      source: { ...graph.source, adapterVersion: 999 },
    };
    expect(canonicalGraphFingerprint(restamped)).toBe(
      canonicalGraphFingerprint(graph)
    );
  });

  it("extracts both declared and inferred relationships in the fixture", () => {
    const labels = graph.edges.map((edge) => edge.data?.label).sort();
    expect(labels).toEqual([
      "depends_on",
      "environment",
      "environment",
      "environment",
    ]);
  });
});
