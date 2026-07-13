"use client";

import React, { useState, useRef, useEffect } from "react";
import {
  MousePointer2,
  Pencil,
  Type,
  Undo2,
  Redo2,
  ChevronUp,
  Search,
  // Compute
  Server,
  Monitor,
  Container,
  CircuitBoard,
  // Data
  Database,
  HardDrive,
  Zap,
  BarChart3,
  // Networking
  Globe,
  Shield,
  Cloud,
  Waypoints,
  Network,
  // Security
  ShieldCheck,
  KeyRound,
  Lock,
  // Messaging
  Layers,
  Radio,
  // Storage
  Archive,
  // Infrastructure
  Activity,
  BookOpen,
  Timer,
  // Grouping
  FolderOpen,
} from "lucide-react";

type Tool = "select" | "draw" | "shapes" | "text" | "undo" | "redo";

interface BottomToolbarProps {
  activeTool?: Tool;
  onToolChange?: (tool: Tool) => void;
  onShapeSelected?: (nodeType: string) => void;
  onUndo?: () => void;
  onRedo?: () => void;
}

// ── Categorized Node Palette ───────────────────────────────────────

interface NodeEntry {
  type: string;
  label: string;
  icon: React.ReactNode;
  description: string;
}

interface NodeCategory {
  name: string;
  color: string;
  nodes: NodeEntry[];
}

const nodeCategories: NodeCategory[] = [
  {
    name: "Compute",
    color: "text-accent-cyan",
    nodes: [
      { type: "service", label: "Service", icon: <Server className="w-4 h-4" />, description: "Microservice / API" },
      { type: "client", label: "Client", icon: <Monitor className="w-4 h-4" />, description: "Browser / Mobile app" },
      { type: "container", label: "Container", icon: <Container className="w-4 h-4" />, description: "Kubernetes / ECS / Docker" },
      { type: "function", label: "Function", icon: <CircuitBoard className="w-4 h-4" />, description: "Lambda / Cloud Functions" },
    ],
  },
  {
    name: "Data",
    color: "text-accent-purple",
    nodes: [
      { type: "database", label: "Database", icon: <Database className="w-4 h-4" />, description: "SQL / NoSQL store" },
      { type: "cache", label: "Cache", icon: <Zap className="w-4 h-4" />, description: "Redis / Memcached" },
      { type: "warehouse", label: "Data Warehouse", icon: <BarChart3 className="w-4 h-4" />, description: "BigQuery / Snowflake / Redshift" },
      { type: "search", label: "Search Engine", icon: <Search className="w-4 h-4" />, description: "Elasticsearch / Algolia" },
    ],
  },
  {
    name: "Networking",
    color: "text-status-active",
    nodes: [
      { type: "gateway", label: "API Gateway", icon: <Globe className="w-4 h-4" />, description: "Kong / AWS API Gateway" },
      { type: "loadbalancer", label: "Load Balancer", icon: <Shield className="w-4 h-4" />, description: "ALB / HAProxy / Nginx" },
      { type: "cdn", label: "CDN", icon: <Cloud className="w-4 h-4" />, description: "CloudFront / Akamai / Fastly" },
      { type: "dns", label: "DNS", icon: <Waypoints className="w-4 h-4" />, description: "Route53 / Cloudflare DNS" },
      { type: "proxy", label: "Reverse Proxy", icon: <Network className="w-4 h-4" />, description: "Nginx / Envoy / Traefik" },
    ],
  },
  {
    name: "Security",
    color: "text-status-error",
    nodes: [
      { type: "firewall", label: "Firewall / WAF", icon: <ShieldCheck className="w-4 h-4" />, description: "AWS WAF / Cloudflare" },
      { type: "auth", label: "Auth Provider", icon: <KeyRound className="w-4 h-4" />, description: "Auth0 / Cognito / Keycloak" },
      { type: "vault", label: "Secrets Vault", icon: <Lock className="w-4 h-4" />, description: "HashiCorp Vault / AWS Secrets" },
    ],
  },
  {
    name: "Messaging",
    color: "text-status-warning",
    nodes: [
      { type: "queue", label: "Queue", icon: <Layers className="w-4 h-4" />, description: "SQS / RabbitMQ" },
      { type: "broker", label: "Message Broker", icon: <Network className="w-4 h-4" />, description: "Kafka / NATS / Pulsar" },
      { type: "stream", label: "Stream Processor", icon: <Radio className="w-4 h-4" />, description: "Flink / Spark / Kinesis" },
    ],
  },
  {
    name: "Storage",
    color: "text-[#fb923c]",
    nodes: [
      { type: "storage", label: "Object Storage", icon: <Archive className="w-4 h-4" />, description: "S3 / Blob / GCS" },
    ],
  },
  {
    name: "Infrastructure",
    color: "text-[#a3e635]",
    nodes: [
      { type: "monitor", label: "Monitoring", icon: <Activity className="w-4 h-4" />, description: "Datadog / Grafana / Prometheus" },
      { type: "registry", label: "Service Registry", icon: <BookOpen className="w-4 h-4" />, description: "Consul / Eureka / Zookeeper" },
      { type: "scheduler", label: "Scheduler", icon: <Timer className="w-4 h-4" />, description: "Airflow / Celery / Temporal" },
    ],
  },
  {
    name: "Grouping",
    color: "text-[#94a3b8]",
    nodes: [
      { type: "group", label: "Group Box", icon: <FolderOpen className="w-4 h-4" />, description: "Visual container / subgraph" },
    ],
  },
];

// Flatten for search
const allNodes = nodeCategories.flatMap((cat) =>
  cat.nodes.map((n) => ({ ...n, category: cat.name, color: cat.color }))
);

const tools: { id: Tool; label: string; icon: React.ReactNode }[] = [
  { id: "select", label: "Select", icon: <MousePointer2 className="h-[18px] w-[18px]" /> },
  { id: "draw", label: "Connect", icon: <Pencil className="h-[18px] w-[18px]" /> },
  { id: "shapes", label: "Component", icon: <ChevronUp className="h-[18px] w-[18px]" /> },
  { id: "text", label: "Note", icon: <Type className="h-[18px] w-[18px]" /> },
  { id: "undo", label: "Undo", icon: <Undo2 className="h-[18px] w-[18px]" /> },
  { id: "redo", label: "Redo", icon: <Redo2 className="h-[18px] w-[18px]" /> },
];

export default function BottomToolbar({
  activeTool = "select",
  onToolChange,
  onShapeSelected,
  onUndo,
  onRedo,
}: BottomToolbarProps) {
  const [showShapes, setShowShapes] = useState(false);
  const [paletteSearch, setPaletteSearch] = useState("");
  const shapesRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // Close shapes dropdown on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (shapesRef.current && !shapesRef.current.contains(e.target as Node)) {
        setShowShapes(false);
        setPaletteSearch("");
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  // Auto-focus search when palette opens
  useEffect(() => {
    if (showShapes && searchRef.current) {
      searchRef.current.focus();
    }
  }, [showShapes]);

  const handleToolClick = (tool: Tool) => {
    if (tool === "shapes") {
      setShowShapes(!showShapes);
      setPaletteSearch("");
      return;
    }
    if (tool === "undo") {
      onUndo?.();
      return;
    }
    if (tool === "redo") {
      onRedo?.();
      return;
    }
    setShowShapes(false);
    onToolChange?.(tool);
  };

  const handleShapeClick = (nodeType: string) => {
    onShapeSelected?.(nodeType);
    setShowShapes(false);
    setPaletteSearch("");
  };

  // Filter nodes by search
  const query = paletteSearch.toLowerCase().trim();
  const filteredCategories = query
    ? [{
        name: "Search Results",
        color: "text-text-muted",
        nodes: allNodes.filter(
          (n) =>
            n.label.toLowerCase().includes(query) ||
            n.description.toLowerCase().includes(query) ||
            n.type.toLowerCase().includes(query) ||
            n.category.toLowerCase().includes(query)
        ),
      }]
    : nodeCategories;

  return (
    <div
      id="bottom-toolbar"
      className="fixed bottom-4 left-1/2 z-40 flex max-w-[calc(100vw-7rem)] -translate-x-1/2 items-center gap-1 overflow-visible rounded-xl border border-border bg-surface/95 p-1.5 shadow-[var(--shadow-float)] backdrop-blur-xl sm:bottom-5"
    >
      {tools.map((tool) => {
        const isActive = activeTool === tool.id && tool.id !== "undo";
        return (
          <div
            key={tool.id}
            ref={tool.id === "shapes" ? shapesRef : undefined}
            className="relative"
          >
            <button
              id={`tool-${tool.id}`}
              onClick={() => handleToolClick(tool.id)}
              title={tool.label}
              className={`flex h-12 min-w-11 items-center justify-center gap-2 rounded-lg px-3 transition-all duration-150 sm:min-w-0 ${
                isActive
                  ? "bg-accent-cyan/10 text-accent-cyan"
                  : "text-text-muted hover:text-text-primary hover:bg-surface-light"
              }`}
            >
              {tool.icon}
              <span className="hidden text-[11px] font-semibold sm:block">
                {tool.label}
              </span>
            </button>

            {/* Enhanced Shapes Palette */}
            {tool.id === "shapes" && showShapes && (
              <div className="absolute bottom-full left-1/2 z-50 mb-2 w-[340px] max-w-[calc(100vw-1.5rem)] -translate-x-1/2 overflow-hidden rounded-xl border border-border bg-surface shadow-[var(--shadow-float)] animate-fade-in">
                {/* Search */}
                <div className="border-b border-border p-3">
                  <div className="relative">
                    <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-muted" />
                    <input
                      ref={searchRef}
                      type="text"
                      placeholder="Search components..."
                      value={paletteSearch}
                      onChange={(e) => setPaletteSearch(e.target.value)}
                      className="input h-9 w-full bg-canvas-50 py-1.5 pl-8 pr-2 text-xs"
                    />
                  </div>
                </div>

                {/* Categories */}
                <div className="max-h-80 overflow-y-auto scrollbar-thin">
                  {filteredCategories.map((cat) => (
                    <div key={cat.name}>
                      {/* Category Header */}
                      <div className="sticky top-0 z-10 border-y border-border/60 bg-surface-light px-3 py-1.5 first:border-t-0">
                        <span className={`text-[9px] font-mono font-semibold uppercase tracking-[0.14em] ${cat.color}`}>
                          {cat.name}
                        </span>
                      </div>
                      {/* Category Items */}
                      <div className="p-1">
                        {cat.nodes.map((nt) => (
                          <button
                            key={nt.type}
                            onClick={() => handleShapeClick(nt.type)}
                            className="group flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-all hover:bg-accent-cyan/[0.06]"
                          >
                            <span className={`shrink-0 ${(nt as any).color || cat.color} opacity-70 group-hover:opacity-100 transition-opacity`}>
                              {nt.icon}
                            </span>
                            <div className="min-w-0 flex-1">
                              <p className="text-xs font-semibold text-text-primary transition-colors group-hover:text-accent-cyan">
                                {nt.label}
                              </p>
                              <p className="text-[10px] text-text-muted truncate">
                                {nt.description}
                              </p>
                            </div>
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                  {filteredCategories.length === 1 && filteredCategories[0].nodes.length === 0 && (
                    <div className="px-3 py-4 text-center">
                      <p className="text-xs text-text-muted">No components match &quot;{paletteSearch}&quot;</p>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
