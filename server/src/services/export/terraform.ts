/**
 * Terraform Exporter
 *
 * Converts an architecture graph into a Terraform HCL bundle:
 *   main.tf       — Resource definitions
 *   variables.tf  — Input variables
 *   outputs.tf    — Output values
 *
 * Maps node types to AWS resources by default.
 */

import type { SerializedNode, SerializedEdge } from "@system-synthesis/shared";

// ── Resource Mappings ──────────────────────────────────────────────

interface TerraformResource {
  resourceType: string;
  source: string;          // e.g. "aws_rds_instance"
  snippet: (name: string, node: SerializedNode) => string;
  output?: (name: string) => string;
}

function sanitizeName(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    || "resource";
}

function resolveTerraformResource(node: SerializedNode): TerraformResource {
  const tech = (node.data.tech || "").toLowerCase();
  const nodeType = node.data.nodeType;

  // --- Database ---
  if (nodeType === "database") {
    if (tech.includes("dynamo")) {
      return {
        resourceType: "aws_dynamodb_table",
        source: "hashicorp/aws",
        snippet: (name) => `resource "aws_dynamodb_table" "${name}" {
  name           = "${name}"
  billing_mode   = "PAY_PER_REQUEST"
  hash_key       = "id"

  attribute {
    name = "id"
    type = "S"
  }

  tags = local.common_tags
}`,
        output: (name) => `output "${name}_table_name" {\n  value = aws_dynamodb_table.${name}.name\n}`,
      };
    }
    // Default RDS
    const engine = tech.includes("mysql") ? "mysql" : "postgres";
    return {
      resourceType: "aws_db_instance",
      source: "hashicorp/aws",
      snippet: (name, n) => `resource "aws_db_instance" "${name}" {
  identifier        = "${name}"
  engine            = "${engine}"
  engine_version    = "${engine === "postgres" ? "16" : "8.0"}"
  instance_class    = "db.t3.micro"
  allocated_storage = 20
  db_name           = "appdb"
  username          = var.db_username
  password          = var.db_password
  multi_az          = ${(n.data.instances || 1) > 1 ? "true" : "false"}
  skip_final_snapshot = true

  vpc_security_group_ids = [aws_security_group.${name}_sg.id]
  db_subnet_group_name   = aws_db_subnet_group.main.name

  tags = local.common_tags
}

resource "aws_security_group" "${name}_sg" {
  name_prefix = "${name}-"
  vpc_id      = aws_vpc.main.id

  ingress {
    from_port   = ${engine === "postgres" ? "5432" : "3306"}
    to_port     = ${engine === "postgres" ? "5432" : "3306"}
    protocol    = "tcp"
    cidr_blocks = [aws_vpc.main.cidr_block]
  }

  tags = local.common_tags
}`,
      output: (name) => `output "${name}_endpoint" {\n  value = aws_db_instance.${name}.endpoint\n}`,
    };
  }

  // --- Cache (ElastiCache) ---
  if (nodeType === "cache") {
    return {
      resourceType: "aws_elasticache_cluster",
      source: "hashicorp/aws",
      snippet: (name, n) => `resource "aws_elasticache_cluster" "${name}" {
  cluster_id           = "${name}"
  engine               = "redis"
  engine_version       = "7.0"
  node_type            = "cache.t3.micro"
  num_cache_nodes      = ${n.data.instances || 1}
  port                 = 6379
  security_group_ids   = [aws_security_group.${name}_sg.id]
  subnet_group_name    = aws_elasticache_subnet_group.main.name

  tags = local.common_tags
}

resource "aws_security_group" "${name}_sg" {
  name_prefix = "${name}-"
  vpc_id      = aws_vpc.main.id

  ingress {
    from_port   = 6379
    to_port     = 6379
    protocol    = "tcp"
    cidr_blocks = [aws_vpc.main.cidr_block]
  }

  tags = local.common_tags
}`,
      output: (name) => `output "${name}_endpoint" {\n  value = aws_elasticache_cluster.${name}.cache_nodes[0].address\n}`,
    };
  }

  // --- Queue (SQS / MSK) ---
  if (nodeType === "queue") {
    if (tech.includes("kafka")) {
      return {
        resourceType: "aws_msk_cluster",
        source: "hashicorp/aws",
        snippet: (name) => `resource "aws_msk_cluster" "${name}" {
  cluster_name           = "${name}"
  kafka_version          = "3.6.0"
  number_of_broker_nodes = 3

  broker_node_group_info {
    instance_type  = "kafka.m5.large"
    client_subnets = aws_subnet.private[*].id
    storage_info {
      ebs_storage_info {
        volume_size = 100
      }
    }
    security_groups = [aws_security_group.${name}_sg.id]
  }

  tags = local.common_tags
}`,
        output: (name) => `output "${name}_bootstrap_brokers" {\n  value = aws_msk_cluster.${name}.bootstrap_brokers_tls\n}`,
      };
    }
    return {
      resourceType: "aws_sqs_queue",
      source: "hashicorp/aws",
      snippet: (name) => `resource "aws_sqs_queue" "${name}" {
  name                       = "${name}"
  visibility_timeout_seconds = 30
  message_retention_seconds  = 1209600  # 14 days

  tags = local.common_tags
}`,
      output: (name) => `output "${name}_queue_url" {\n  value = aws_sqs_queue.${name}.url\n}`,
    };
  }

  // --- Gateway (API Gateway) ---
  if (nodeType === "gateway") {
    return {
      resourceType: "aws_apigatewayv2_api",
      source: "hashicorp/aws",
      snippet: (name) => `resource "aws_apigatewayv2_api" "${name}" {
  name          = "${name}"
  protocol_type = "HTTP"

  cors_configuration {
    allow_origins = ["*"]
    allow_methods = ["GET", "POST", "PUT", "DELETE", "OPTIONS"]
    allow_headers = ["*"]
    max_age       = 3600
  }

  tags = local.common_tags
}

resource "aws_apigatewayv2_stage" "${name}_default" {
  api_id      = aws_apigatewayv2_api.${name}.id
  name        = "$default"
  auto_deploy = true
}`,
      output: (name) => `output "${name}_api_url" {\n  value = aws_apigatewayv2_api.${name}.api_endpoint\n}`,
    };
  }

  // --- Load Balancer (ALB) ---
  if (nodeType === "loadbalancer") {
    return {
      resourceType: "aws_lb",
      source: "hashicorp/aws",
      snippet: (name) => `resource "aws_lb" "${name}" {
  name               = "${name}"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.${name}_sg.id]
  subnets            = aws_subnet.public[*].id

  tags = local.common_tags
}

resource "aws_security_group" "${name}_sg" {
  name_prefix = "${name}-"
  vpc_id      = aws_vpc.main.id

  ingress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = local.common_tags
}`,
      output: (name) => `output "${name}_dns_name" {\n  value = aws_lb.${name}.dns_name\n}`,
    };
  }

  // --- Storage (S3) ---
  if (nodeType === "storage") {
    return {
      resourceType: "aws_s3_bucket",
      source: "hashicorp/aws",
      snippet: (name) => `resource "aws_s3_bucket" "${name}" {
  bucket = "\${var.project_name}-${name}"

  tags = local.common_tags
}

resource "aws_s3_bucket_versioning" "${name}_versioning" {
  bucket = aws_s3_bucket.${name}.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "${name}_encryption" {
  bucket = aws_s3_bucket.${name}.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}`,
      output: (name) => `output "${name}_bucket_arn" {\n  value = aws_s3_bucket.${name}.arn\n}`,
    };
  }

  // --- Service (ECS Fargate) ---
  if (nodeType === "service") {
    return {
      resourceType: "aws_ecs_service",
      source: "hashicorp/aws",
      snippet: (name, n) => `resource "aws_ecs_task_definition" "${name}" {
  family                   = "${name}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "256"
  memory                   = "512"
  execution_role_arn       = aws_iam_role.ecs_execution.arn

  container_definitions = jsonencode([{
    name      = "${name}"
    image     = "\${var.ecr_registry}/${name}:latest"
    essential = true
    portMappings = [{
      containerPort = 3000
      hostPort      = 3000
      protocol      = "tcp"
    }]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = "/ecs/${name}"
        "awslogs-region"        = var.aws_region
        "awslogs-stream-prefix" = "ecs"
      }
    }
  }])

  tags = local.common_tags
}

resource "aws_ecs_service" "${name}" {
  name            = "${name}"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.${name}.arn
  launch_type     = "FARGATE"
  desired_count   = ${n.data.instances || 1}

  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.ecs_tasks.id]
    assign_public_ip = false
  }

  tags = local.common_tags
}`,
    };
  }

  // --- Client (CloudFront) ---
  if (nodeType === "client") {
    return {
      resourceType: "aws_cloudfront_distribution",
      source: "hashicorp/aws",
      snippet: (name) => `# Client "${name}" — typically served via CloudFront + S3
# Configure origin and behaviors based on your SPA framework`,
    };
  }

  return {
    resourceType: "null_resource",
    source: "hashicorp/null",
    snippet: (name) => `# Unmapped resource: ${name}`,
  };
}

// ── Terraform Generator ────────────────────────────────────────────

export interface TerraformBundle {
  "main.tf": string;
  "variables.tf": string;
  "outputs.tf": string;
}

export function generateTerraform(
  nodes: SerializedNode[],
  edges: SerializedEdge[]
): TerraformBundle {
  const nameMap = new Map<string, string>();
  for (const node of nodes) {
    nameMap.set(node.id, sanitizeName(node.data.label));
  }

  // ── main.tf ──
  const resources: string[] = [];

  resources.push(`# ============================================================
# Terraform Configuration — Generated by System Synthesis
# Generated: ${new Date().toISOString()}
# ============================================================

terraform {
  required_version = ">= 1.5"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
}

locals {
  common_tags = {
    Project     = var.project_name
    Environment = var.environment
    ManagedBy   = "terraform"
    Generator   = "system-synthesis"
  }
}

# ── VPC Foundation ──

resource "aws_vpc" "main" {
  cidr_block           = "10.0.0.0/16"
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = merge(local.common_tags, { Name = "\${var.project_name}-vpc" })
}

resource "aws_subnet" "public" {
  count                   = 2
  vpc_id                  = aws_vpc.main.id
  cidr_block              = cidrsubnet(aws_vpc.main.cidr_block, 8, count.index)
  availability_zone       = data.aws_availability_zones.available.names[count.index]
  map_public_ip_on_launch = true

  tags = merge(local.common_tags, { Name = "\${var.project_name}-public-\${count.index}" })
}

resource "aws_subnet" "private" {
  count             = 2
  vpc_id            = aws_vpc.main.id
  cidr_block        = cidrsubnet(aws_vpc.main.cidr_block, 8, count.index + 10)
  availability_zone = data.aws_availability_zones.available.names[count.index]

  tags = merge(local.common_tags, { Name = "\${var.project_name}-private-\${count.index}" })
}

data "aws_availability_zones" "available" {
  state = "available"
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
  tags   = local.common_tags
}

# ── DB Subnet Group ──

resource "aws_db_subnet_group" "main" {
  name       = "\${var.project_name}-db"
  subnet_ids = aws_subnet.private[*].id
  tags       = local.common_tags
}

# ── ElastiCache Subnet Group ──

resource "aws_elasticache_subnet_group" "main" {
  name       = "\${var.project_name}-cache"
  subnet_ids = aws_subnet.private[*].id
}

# ── ECS Cluster ──

resource "aws_ecs_cluster" "main" {
  name = "\${var.project_name}-cluster"
  tags = local.common_tags
}

resource "aws_iam_role" "ecs_execution" {
  name = "\${var.project_name}-ecs-execution"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action = "sts:AssumeRole"
      Effect = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
    }]
  })

  tags = local.common_tags
}

resource "aws_iam_role_policy_attachment" "ecs_execution" {
  role       = aws_iam_role.ecs_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_security_group" "ecs_tasks" {
  name_prefix = "ecs-tasks-"
  vpc_id      = aws_vpc.main.id

  ingress {
    from_port   = 0
    to_port     = 65535
    protocol    = "tcp"
    cidr_blocks = [aws_vpc.main.cidr_block]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = local.common_tags
}
`);

  // Add resources for each node
  resources.push(`\n# ── Architecture Resources ──\n`);

  for (const node of nodes) {
    const name = nameMap.get(node.id)!;
    const mapping = resolveTerraformResource(node);
    resources.push(mapping.snippet(name, node));
    resources.push("");
  }

  // ── variables.tf ──
  const variables = `# ============================================================
# Variables — Generated by System Synthesis
# ============================================================

variable "project_name" {
  description = "Project name used for resource naming"
  type        = string
  default     = "system-synthesis"
}

variable "environment" {
  description = "Deployment environment"
  type        = string
  default     = "production"
}

variable "aws_region" {
  description = "AWS region"
  type        = string
  default     = "us-east-1"
}

variable "db_username" {
  description = "Database master username"
  type        = string
  default     = "appuser"
  sensitive   = true
}

variable "db_password" {
  description = "Database master password"
  type        = string
  sensitive   = true
}

variable "ecr_registry" {
  description = "ECR registry URL for container images"
  type        = string
  default     = ""
}
`;

  // ── outputs.tf ──
  const outputBlocks: string[] = [
    `# ============================================================`,
    `# Outputs — Generated by System Synthesis`,
    `# ============================================================`,
    ``,
  ];

  for (const node of nodes) {
    const name = nameMap.get(node.id)!;
    const mapping = resolveTerraformResource(node);
    if (mapping.output) {
      outputBlocks.push(mapping.output(name));
      outputBlocks.push("");
    }
  }

  return {
    "main.tf": resources.join("\n"),
    "variables.tf": variables,
    "outputs.tf": outputBlocks.join("\n"),
  };
}
