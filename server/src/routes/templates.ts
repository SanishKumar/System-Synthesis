import { Router } from "express";
import type { ArchTemplate } from "@system-synthesis/shared";

const router = Router();

const meta = { notes: "", links: [], codeSnippet: "", attachedFiles: [] };

// ============================================================
// Template Definitions
// ============================================================

const TEMPLATES: ArchTemplate[] = [
  // --- REST Microservices ---
  {
    id: "rest-microservices",
    name: "REST Microservices",
    description: "API gateway with multiple domain services, each with its own database. Follows the Database-per-Service pattern.",
    category: "Microservices",
    nodes: [
      { id: "t1-client", type: "architectureNode", position: { x: 400, y: 50 }, data: { label: "Web & Mobile Clients", nodeType: "client", status: "active", tier: "frontend", zone: "public", tech: "React", metadata: meta } },
      { id: "t1-lb", type: "architectureNode", position: { x: 400, y: 180 }, data: { label: "Load Balancer", nodeType: "loadbalancer", status: "active", tier: "infrastructure", zone: "dmz", tech: "Nginx", metadata: meta } },
      { id: "t1-gw", type: "architectureNode", position: { x: 400, y: 310 }, data: { label: "API Gateway", subtitle: "Rate Limiting, Auth", nodeType: "gateway", status: "active", tier: "infrastructure", zone: "dmz", tech: "Kong", metadata: meta } },
      { id: "t1-user-svc", type: "architectureNode", position: { x: 200, y: 460 }, data: { label: "User Service", subtitle: "CRUD, Auth", nodeType: "service", status: "active", tier: "backend", zone: "private", tech: "Node.js", metadata: meta } },
      { id: "t1-order-svc", type: "architectureNode", position: { x: 400, y: 460 }, data: { label: "Order Service", subtitle: "Order Management", nodeType: "service", status: "active", tier: "backend", zone: "private", tech: "Go", metadata: meta } },
      { id: "t1-product-svc", type: "architectureNode", position: { x: 600, y: 460 }, data: { label: "Product Service", subtitle: "Catalog", nodeType: "service", status: "active", tier: "backend", zone: "private", tech: "Java", metadata: meta } },
      { id: "t1-user-db", type: "architectureNode", position: { x: 200, y: 620 }, data: { label: "User DB", subtitle: "PostgreSQL", nodeType: "database", status: "active", tier: "data", zone: "restricted", tech: "PostgreSQL", metadata: meta } },
      { id: "t1-order-db", type: "architectureNode", position: { x: 400, y: 620 }, data: { label: "Order DB", subtitle: "PostgreSQL", nodeType: "database", status: "active", tier: "data", zone: "restricted", tech: "PostgreSQL", metadata: meta } },
      { id: "t1-product-db", type: "architectureNode", position: { x: 600, y: 620 }, data: { label: "Product DB", subtitle: "MongoDB", nodeType: "database", status: "active", tier: "data", zone: "restricted", tech: "MongoDB", metadata: meta } },
    ],
    edges: [
      { id: "t1-e1", source: "t1-client", target: "t1-lb", data: { label: "HTTPS" } },
      { id: "t1-e2", source: "t1-lb", target: "t1-gw", data: { label: "HTTP" } },
      { id: "t1-e3", source: "t1-gw", target: "t1-user-svc", data: { label: "REST", protocol: "HTTP" } },
      { id: "t1-e4", source: "t1-gw", target: "t1-order-svc", data: { label: "REST", protocol: "HTTP" } },
      { id: "t1-e5", source: "t1-gw", target: "t1-product-svc", data: { label: "REST", protocol: "HTTP" } },
      { id: "t1-e6", source: "t1-user-svc", target: "t1-user-db", data: { protocol: "TCP" } },
      { id: "t1-e7", source: "t1-order-svc", target: "t1-order-db", data: { protocol: "TCP" } },
      { id: "t1-e8", source: "t1-product-svc", target: "t1-product-db", data: { protocol: "TCP" } },
    ],
  },

  // --- Event-Driven Pipeline ---
  {
    id: "event-driven",
    name: "Event-Driven Pipeline",
    description: "Asynchronous event-driven architecture with Kafka, producers, consumers, and CQRS-ready read/write separation.",
    category: "Event-Driven",
    nodes: [
      { id: "t2-producer", type: "architectureNode", position: { x: 200, y: 50 }, data: { label: "Event Producer", subtitle: "API / Webhook", nodeType: "service", status: "active", tier: "backend", zone: "private", tech: "Node.js", metadata: meta } },
      { id: "t2-ingest", type: "architectureNode", position: { x: 500, y: 50 }, data: { label: "Data Ingestion", subtitle: "Stream Processing", nodeType: "service", status: "active", tier: "backend", zone: "private", tech: "Python", metadata: meta } },
      { id: "t2-kafka", type: "architectureNode", position: { x: 350, y: 200 }, data: { label: "Kafka Cluster", subtitle: "Event Bus", nodeType: "queue", status: "active", tier: "infrastructure", zone: "private", tech: "Apache Kafka", metadata: meta } },
      { id: "t2-consumer-1", type: "architectureNode", position: { x: 150, y: 370 }, data: { label: "Analytics Consumer", subtitle: "Real-time Analytics", nodeType: "service", status: "active", tier: "backend", zone: "private", tech: "Spark", metadata: meta } },
      { id: "t2-consumer-2", type: "architectureNode", position: { x: 400, y: 370 }, data: { label: "Notification Consumer", subtitle: "Email / Push", nodeType: "service", status: "active", tier: "backend", zone: "private", tech: "Go", metadata: meta } },
      { id: "t2-consumer-3", type: "architectureNode", position: { x: 650, y: 370 }, data: { label: "Persistence Consumer", subtitle: "Write Model", nodeType: "service", status: "active", tier: "backend", zone: "private", tech: "Java", metadata: meta } },
      { id: "t2-timeseries", type: "architectureNode", position: { x: 150, y: 530 }, data: { label: "TimescaleDB", subtitle: "Analytics Store", nodeType: "database", status: "active", tier: "data", zone: "restricted", tech: "TimescaleDB", metadata: meta } },
      { id: "t2-main-db", type: "architectureNode", position: { x: 650, y: 530 }, data: { label: "PostgreSQL", subtitle: "Primary Store", nodeType: "database", status: "active", tier: "data", zone: "restricted", tech: "PostgreSQL", metadata: meta } },
    ],
    edges: [
      { id: "t2-e1", source: "t2-producer", target: "t2-kafka", data: { label: "Publish", protocol: "TCP" } },
      { id: "t2-e2", source: "t2-ingest", target: "t2-kafka", data: { label: "Publish", protocol: "TCP" } },
      { id: "t2-e3", source: "t2-kafka", target: "t2-consumer-1", data: { label: "Subscribe", protocol: "TCP" } },
      { id: "t2-e4", source: "t2-kafka", target: "t2-consumer-2", data: { label: "Subscribe", protocol: "TCP" } },
      { id: "t2-e5", source: "t2-kafka", target: "t2-consumer-3", data: { label: "Subscribe", protocol: "TCP" } },
      { id: "t2-e6", source: "t2-consumer-1", target: "t2-timeseries", data: { protocol: "TCP" } },
      { id: "t2-e7", source: "t2-consumer-3", target: "t2-main-db", data: { protocol: "TCP" } },
    ],
  },

  // --- Serverless API ---
  {
    id: "serverless-api",
    name: "Serverless API",
    description: "AWS Lambda-based serverless architecture with API Gateway, DynamoDB, and S3.",
    category: "Serverless",
    nodes: [
      { id: "t3-client", type: "architectureNode", position: { x: 350, y: 50 }, data: { label: "SPA Client", subtitle: "React + CloudFront CDN", nodeType: "client", status: "active", tier: "frontend", zone: "public", tech: "React", metadata: meta } },
      { id: "t3-apigw", type: "architectureNode", position: { x: 350, y: 200 }, data: { label: "AWS API Gateway", subtitle: "REST + WebSocket", nodeType: "gateway", status: "active", tier: "infrastructure", zone: "dmz", tech: "AWS API GW", metadata: meta } },
      { id: "t3-auth-fn", type: "architectureNode", position: { x: 150, y: 370 }, data: { label: "Auth Lambda", subtitle: "Cognito Authorizer", nodeType: "service", status: "active", tier: "backend", zone: "private", tech: "Lambda (Node.js)", metadata: meta } },
      { id: "t3-api-fn", type: "architectureNode", position: { x: 350, y: 370 }, data: { label: "API Lambda", subtitle: "Business Logic", nodeType: "service", status: "active", tier: "backend", zone: "private", tech: "Lambda (Python)", metadata: meta } },
      { id: "t3-worker-fn", type: "architectureNode", position: { x: 550, y: 370 }, data: { label: "Worker Lambda", subtitle: "Async Processing", nodeType: "service", status: "active", tier: "backend", zone: "private", tech: "Lambda (Go)", metadata: meta } },
      { id: "t3-sqs", type: "architectureNode", position: { x: 550, y: 200 }, data: { label: "SQS Queue", subtitle: "Async Tasks", nodeType: "queue", status: "active", tier: "infrastructure", zone: "private", tech: "AWS SQS", metadata: meta } },
      { id: "t3-dynamo", type: "architectureNode", position: { x: 250, y: 540 }, data: { label: "DynamoDB", subtitle: "NoSQL Store", nodeType: "database", status: "active", tier: "data", zone: "restricted", tech: "DynamoDB", metadata: meta } },
      { id: "t3-s3", type: "architectureNode", position: { x: 500, y: 540 }, data: { label: "S3 Bucket", subtitle: "File Storage", nodeType: "storage", status: "active", tier: "data", zone: "private", tech: "AWS S3", metadata: meta } },
    ],
    edges: [
      { id: "t3-e1", source: "t3-client", target: "t3-apigw", data: { label: "HTTPS" } },
      { id: "t3-e2", source: "t3-apigw", target: "t3-auth-fn", data: { label: "Auth" } },
      { id: "t3-e3", source: "t3-apigw", target: "t3-api-fn", data: { label: "Invoke" } },
      { id: "t3-e4", source: "t3-api-fn", target: "t3-sqs", data: { label: "Enqueue" } },
      { id: "t3-e5", source: "t3-sqs", target: "t3-worker-fn", data: { label: "Trigger" } },
      { id: "t3-e6", source: "t3-api-fn", target: "t3-dynamo", data: { protocol: "HTTP" } },
      { id: "t3-e7", source: "t3-worker-fn", target: "t3-s3", data: { protocol: "HTTP" } },
    ],
  },

  // --- 3-Tier Web App ---
  {
    id: "three-tier",
    name: "3-Tier Web App",
    description: "Classic presentation-logic-data architecture with load balancer, web servers, app servers, and database cluster.",
    category: "Traditional",
    nodes: [
      { id: "t4-client", type: "architectureNode", position: { x: 350, y: 50 }, data: { label: "Browser", nodeType: "client", status: "active", tier: "frontend", zone: "public", tech: "Browser", metadata: meta } },
      { id: "t4-cdn", type: "architectureNode", position: { x: 350, y: 180 }, data: { label: "CDN", subtitle: "Cloudflare", nodeType: "cache", status: "active", tier: "infrastructure", zone: "public", tech: "Cloudflare", metadata: meta } },
      { id: "t4-lb", type: "architectureNode", position: { x: 350, y: 310 }, data: { label: "Load Balancer", subtitle: "HAProxy", nodeType: "loadbalancer", status: "active", tier: "infrastructure", zone: "dmz", tech: "HAProxy", metadata: meta } },
      { id: "t4-web-1", type: "architectureNode", position: { x: 200, y: 450 }, data: { label: "Web Server 1", subtitle: "Nginx", nodeType: "service", status: "active", tier: "backend", zone: "private", tech: "Nginx", instances: 2, metadata: meta } },
      { id: "t4-web-2", type: "architectureNode", position: { x: 500, y: 450 }, data: { label: "Web Server 2", subtitle: "Nginx", nodeType: "service", status: "active", tier: "backend", zone: "private", tech: "Nginx", instances: 2, metadata: meta } },
      { id: "t4-app", type: "architectureNode", position: { x: 350, y: 580 }, data: { label: "App Server", subtitle: "Django / Rails", nodeType: "service", status: "active", tier: "backend", zone: "private", tech: "Django", metadata: meta } },
      { id: "t4-db", type: "architectureNode", position: { x: 350, y: 720 }, data: { label: "PostgreSQL", subtitle: "Primary + Replica", nodeType: "database", status: "active", tier: "data", zone: "restricted", tech: "PostgreSQL", sla: "99.99%", instances: 2, metadata: meta } },
    ],
    edges: [
      { id: "t4-e1", source: "t4-client", target: "t4-cdn", data: { label: "HTTPS" } },
      { id: "t4-e2", source: "t4-cdn", target: "t4-lb", data: { label: "HTTP" } },
      { id: "t4-e3", source: "t4-lb", target: "t4-web-1", data: { label: "Round Robin" } },
      { id: "t4-e4", source: "t4-lb", target: "t4-web-2", data: { label: "Round Robin" } },
      { id: "t4-e5", source: "t4-web-1", target: "t4-app", data: { protocol: "HTTP" } },
      { id: "t4-e6", source: "t4-web-2", target: "t4-app", data: { protocol: "HTTP" } },
      { id: "t4-e7", source: "t4-app", target: "t4-db", data: { protocol: "TCP" } },
    ],
  },

  // --- Real-Time Analytics ---
  {
    id: "analytics-platform",
    name: "Analytics Platform",
    description: "Real-time data pipeline with ingestion, stream processing, data warehouse, and dashboards.",
    category: "Data",
    nodes: [
      { id: "t5-sdk", type: "architectureNode", position: { x: 150, y: 50 }, data: { label: "Client SDKs", subtitle: "JS / iOS / Android", nodeType: "client", status: "active", tier: "frontend", zone: "public", tech: "SDK", metadata: meta } },
      { id: "t5-webhook", type: "architectureNode", position: { x: 450, y: 50 }, data: { label: "Webhook Ingress", subtitle: "3rd-party events", nodeType: "gateway", status: "active", tier: "infrastructure", zone: "dmz", tech: "Node.js", metadata: meta } },
      { id: "t5-collector", type: "architectureNode", position: { x: 300, y: 200 }, data: { label: "Event Collector", subtitle: "High-throughput ingestion", nodeType: "service", status: "active", tier: "backend", zone: "private", tech: "Go", metadata: meta } },
      { id: "t5-kafka", type: "architectureNode", position: { x: 300, y: 350 }, data: { label: "Kafka", subtitle: "Event Stream", nodeType: "queue", status: "active", tier: "infrastructure", zone: "private", tech: "Apache Kafka", metadata: meta } },
      { id: "t5-flink", type: "architectureNode", position: { x: 150, y: 500 }, data: { label: "Flink Processor", subtitle: "Real-time aggregation", nodeType: "service", status: "active", tier: "backend", zone: "private", tech: "Apache Flink", metadata: meta } },
      { id: "t5-batch", type: "architectureNode", position: { x: 450, y: 500 }, data: { label: "Spark ETL", subtitle: "Batch transforms", nodeType: "service", status: "active", tier: "backend", zone: "private", tech: "Apache Spark", metadata: meta } },
      { id: "t5-clickhouse", type: "architectureNode", position: { x: 150, y: 650 }, data: { label: "ClickHouse", subtitle: "Analytics DB", nodeType: "database", status: "active", tier: "data", zone: "restricted", tech: "ClickHouse", metadata: meta } },
      { id: "t5-s3", type: "architectureNode", position: { x: 450, y: 650 }, data: { label: "Data Lake (S3)", subtitle: "Raw event archive", nodeType: "storage", status: "active", tier: "data", zone: "restricted", tech: "AWS S3", metadata: meta } },
      { id: "t5-dashboard", type: "architectureNode", position: { x: 300, y: 800 }, data: { label: "Grafana Dashboards", subtitle: "Visualization", nodeType: "client", status: "active", tier: "frontend", zone: "private", tech: "Grafana", metadata: meta } },
    ],
    edges: [
      { id: "t5-e1", source: "t5-sdk", target: "t5-collector", data: { label: "Events", protocol: "HTTP" } },
      { id: "t5-e2", source: "t5-webhook", target: "t5-collector", data: { label: "Webhooks", protocol: "HTTP" } },
      { id: "t5-e3", source: "t5-collector", target: "t5-kafka", data: { label: "Publish", protocol: "TCP" } },
      { id: "t5-e4", source: "t5-kafka", target: "t5-flink", data: { label: "Stream", protocol: "TCP" } },
      { id: "t5-e5", source: "t5-kafka", target: "t5-batch", data: { label: "Batch", protocol: "TCP" } },
      { id: "t5-e6", source: "t5-flink", target: "t5-clickhouse", data: { protocol: "TCP" } },
      { id: "t5-e7", source: "t5-batch", target: "t5-s3", data: { protocol: "HTTP" } },
      { id: "t5-e8", source: "t5-clickhouse", target: "t5-dashboard", data: { label: "Queries", protocol: "HTTP" } },
    ],
  },
];

// ============================================================
// Routes
// ============================================================

/**
 * GET /api/templates — List all available templates
 */
router.get("/", (_req, res) => {
  res.json({
    templates: TEMPLATES.map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description,
      category: t.category,
      nodeCount: t.nodes.length,
      edgeCount: t.edges.length,
    })),
  });
});

/**
 * GET /api/templates/:id — Get a specific template with full graph data
 */
router.get("/:id", (req, res) => {
  const template = TEMPLATES.find((t) => t.id === req.params.id);
  if (!template) {
    return res.status(404).json({ error: "Template not found" });
  }
  res.json(template);
});

export default router;
