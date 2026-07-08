"use client";

import React, { useState, useMemo } from "react";
import { useBoardStore } from "@/store/boardStore";
import {
  X,
  FileText,
  Link2,
  Code2,
  Paperclip,
  Plus,
  Trash2,
  ExternalLink,
  Settings2,
} from "lucide-react";
import type {
  ArchTier,
  ArchZone,
  ArchEnvironment,
  ArchNodeType,
} from "@system-synthesis/shared";

type TabId = "properties" | "notes" | "links" | "code";

// Dynamic code tab label and placeholder per node type
const CODE_TAB_CONFIG: Record<string, { label: string; placeholder: string }> = {
  service:      { label: "Code",     placeholder: "// Service implementation, API handlers..." },
  function:     { label: "Code",     placeholder: "// Function handler, event processor..." },
  container:    { label: "Config",   placeholder: "# Dockerfile / K8s manifest / docker-compose..." },
  database:     { label: "Schema",   placeholder: "-- CREATE TABLE, indexes, migrations..." },
  cache:        { label: "Config",   placeholder: "# Redis / Memcached configuration..." },
  warehouse:    { label: "Schema",   placeholder: "-- Data warehouse schema, ETL queries..." },
  search:       { label: "Mapping",  placeholder: "// Index mapping, search queries..." },
  gateway:      { label: "Config",   placeholder: "# API Gateway routes, rate limits..." },
  proxy:        { label: "Config",   placeholder: "# Nginx / Envoy / Traefik config..." },
  loadbalancer: { label: "Config",   placeholder: "# Load balancer upstream config..." },
  cdn:          { label: "Config",   placeholder: "# CDN distribution, cache behaviors..." },
  dns:          { label: "Records",  placeholder: "# DNS zone records, A/CNAME/MX..." },
  firewall:     { label: "Rules",    placeholder: "# Firewall / WAF rules, IP allowlists..." },
  queue:        { label: "Config",   placeholder: "# Queue config, DLQ, retention..." },
  broker:       { label: "Config",   placeholder: "# Broker topics, partitions, config..." },
  stream:       { label: "Pipeline", placeholder: "# Stream processing pipeline / DAG..." },
  auth:         { label: "Config",   placeholder: "# Auth provider config, scopes, flows..." },
  vault:        { label: "Policies", placeholder: "# Access policies, secret paths..." },
  monitor:      { label: "Alerts",   placeholder: "# Alert rules, dashboards, queries..." },
  registry:     { label: "Config",   placeholder: "# Service discovery, health checks..." },
  scheduler:    { label: "Schedule", placeholder: "# Cron expressions, DAG tasks..." },
  client:       { label: "Embed",    placeholder: "<!-- Frontend embed, SDK config... -->" },
  storage:      { label: "Policy",   placeholder: "# Storage policies, lifecycle rules..." },
};

function getTabsForNodeType(nodeType: string): { id: TabId; label: string; icon: React.ReactNode }[] {
  const codeConfig = CODE_TAB_CONFIG[nodeType] || { label: "Code", placeholder: "" };
  return [
    { id: "properties", label: "Properties", icon: <Settings2 className="w-4 h-4" /> },
    { id: "notes", label: "Notes", icon: <FileText className="w-4 h-4" /> },
    { id: "code", label: codeConfig.label, icon: <Code2 className="w-4 h-4" /> },
    { id: "links", label: "Links", icon: <Link2 className="w-4 h-4" /> },
  ];
}

const TIER_OPTIONS: { value: ArchTier; label: string }[] = [
  { value: "frontend", label: "Frontend" },
  { value: "backend", label: "Backend" },
  { value: "data", label: "Data" },
  { value: "infrastructure", label: "Infrastructure" },
  { value: "external", label: "External" },
];

const ZONE_OPTIONS: { value: ArchZone; label: string }[] = [
  { value: "public", label: "Public" },
  { value: "dmz", label: "DMZ" },
  { value: "private", label: "Private" },
  { value: "restricted", label: "Restricted" },
];

const ENV_OPTIONS: { value: ArchEnvironment; label: string }[] = [
  { value: "production", label: "Production" },
  { value: "staging", label: "Staging" },
  { value: "development", label: "Development" },
  { value: "shared", label: "Shared" },
];

const NODE_TYPE_OPTIONS: { value: ArchNodeType; label: string }[] = [
  { value: "service", label: "Service" },
  { value: "database", label: "Database" },
  { value: "gateway", label: "API Gateway" },
  { value: "queue", label: "Queue" },
  { value: "cache", label: "Cache" },
  { value: "client", label: "Client" },
  { value: "loadbalancer", label: "Load Balancer" },
  { value: "storage", label: "Object Storage" },
  { value: "cdn", label: "CDN" },
  { value: "firewall", label: "Firewall / WAF" },
  { value: "dns", label: "DNS" },
  { value: "proxy", label: "Reverse Proxy" },
  { value: "container", label: "Container" },
  { value: "function", label: "Serverless Function" },
  { value: "search", label: "Search Engine" },
  { value: "warehouse", label: "Data Warehouse" },
  { value: "stream", label: "Stream Processor" },
  { value: "broker", label: "Message Broker" },
  { value: "auth", label: "Auth Provider" },
  { value: "vault", label: "Secrets Vault" },
  { value: "monitor", label: "Monitoring" },
  { value: "registry", label: "Service Registry" },
  { value: "scheduler", label: "Scheduler" },
];

export default function NodeInspector() {
  const [activeTab, setActiveTab] = useState<TabId>("properties");
  const {
    selectedNodeId,
    nodes,
    edges,
    updateNodeData,
    setSidebarMode,
    deleteNode,
    setSelectedNodeId,
  } = useBoardStore();

  const selectedNode = useMemo(
    () => nodes.find((n) => n.id === selectedNodeId),
    [nodes, selectedNodeId]
  );

  const nodeType = selectedNode?.data?.nodeType;
  const tabs = useMemo(() => getTabsForNodeType(nodeType), [nodeType]);

  if (!selectedNode) return null;

  const { data } = selectedNode;
  const metadata = data.metadata;
  const codeConfig = CODE_TAB_CONFIG[data.nodeType] || { label: "Code", placeholder: "// Paste or write code here..." };

  const handleNotesChange = (notes: string) => {
    updateNodeData(selectedNode.id, {
      metadata: { ...metadata, notes },
    });
  };

  const handleCodeChange = (codeSnippet: string) => {
    updateNodeData(selectedNode.id, {
      metadata: { ...metadata, codeSnippet },
    });
  };

  const handleAddLink = () => {
    const url = prompt("Enter URL:");
    if (url) {
      updateNodeData(selectedNode.id, {
        metadata: { ...metadata, links: [...metadata.links, url] },
      });
    }
  };

  const handleRemoveLink = (index: number) => {
    updateNodeData(selectedNode.id, {
      metadata: {
        ...metadata,
        links: metadata.links.filter((_, i) => i !== index),
      },
    });
  };

  return (
    <div className="sidebar" id="node-inspector">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-sm bg-accent-cyan/15 border border-accent-cyan/30 flex items-center justify-center">
            <Code2 className="w-4 h-4 text-accent-cyan" />
          </div>
          <div>
            <h3 className="font-display font-semibold text-sm text-text-primary">
              {data.label}
            </h3>
            <p className="text-xs text-text-muted font-mono">{data.nodeType}</p>
          </div>
        </div>
        <button
          onClick={() => setSidebarMode("none")}
          className="btn-ghost p-1.5 rounded-sm"
          id="close-inspector"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-border overflow-x-auto">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            id={`inspector-tab-${tab.id}`}
            onClick={() => setActiveTab(tab.id)}
            className={`flex items-center gap-1.5 px-3 py-2.5 text-xs font-display transition-all whitespace-nowrap ${
              activeTab === tab.id
                ? "text-accent-cyan border-b-2 border-accent-cyan"
                : "text-text-muted hover:text-text-secondary"
            }`}
          >
            {tab.icon}
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab Content */}
      <div className="flex-1 overflow-y-auto p-4">
        {/* ========== PROPERTIES TAB ========== */}
        {activeTab === "properties" && (
          <div className="animate-fade-in space-y-4">
            {/* Label */}
            <div>
              <label className="block text-[10px] font-display text-text-muted uppercase tracking-wider mb-1.5">
                Label
              </label>
              <input
                type="text"
                value={data.label}
                onChange={(e) => updateNodeData(selectedNode.id, { label: e.target.value })}
                className="input w-full text-sm"
                id="inspector-label"
              />
            </div>

            {/* Subtitle */}
            <div>
              <label className="block text-[10px] font-display text-text-muted uppercase tracking-wider mb-1.5">
                Subtitle
              </label>
              <input
                type="text"
                value={data.subtitle || ""}
                onChange={(e) => updateNodeData(selectedNode.id, { subtitle: e.target.value })}
                className="input w-full text-sm"
                placeholder="e.g. Kong Enterprise, Redis 7.x"
                id="inspector-subtitle"
              />
            </div>

            {/* Node Type */}
            <div>
              <label className="block text-[10px] font-display text-text-muted uppercase tracking-wider mb-1.5">
                Component Type
              </label>
              <select
                value={data.nodeType}
                onChange={(e) => updateNodeData(selectedNode.id, { nodeType: e.target.value as ArchNodeType })}
                className="input w-full text-sm"
                id="inspector-node-type"
              >
                {NODE_TYPE_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>

            <hr className="border-border" />

            {/* Tier + Zone row */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-[10px] font-display text-text-muted uppercase tracking-wider mb-1.5">
                  Tier
                </label>
                <select
                  value={data.tier || ""}
                  onChange={(e) => updateNodeData(selectedNode.id, { tier: (e.target.value || undefined) as ArchTier | undefined })}
                  className="input w-full text-xs"
                  id="inspector-tier"
                >
                  <option value="">— None —</option>
                  {TIER_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-[10px] font-display text-text-muted uppercase tracking-wider mb-1.5">
                  Zone
                </label>
                <select
                  value={data.zone || ""}
                  onChange={(e) => updateNodeData(selectedNode.id, { zone: (e.target.value || undefined) as ArchZone | undefined })}
                  className="input w-full text-xs"
                  id="inspector-zone"
                >
                  <option value="">— None —</option>
                  {ZONE_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
              </div>
            </div>

            {/* Tech */}
            <div>
              <label className="block text-[10px] font-display text-text-muted uppercase tracking-wider mb-1.5">
                Technology
              </label>
              <input
                type="text"
                value={(data.tech as string) || ""}
                onChange={(e) => updateNodeData(selectedNode.id, { tech: e.target.value || undefined })}
                className="input w-full text-sm"
                placeholder="e.g. PostgreSQL 15, Node.js 20, Go 1.22"
                id="inspector-tech"
              />
            </div>

            {/* Environment + Region row */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-[10px] font-display text-text-muted uppercase tracking-wider mb-1.5">
                  Environment
                </label>
                <select
                  value={(data.environment as string) || ""}
                  onChange={(e) => updateNodeData(selectedNode.id, { environment: (e.target.value || undefined) as ArchEnvironment | undefined })}
                  className="input w-full text-xs"
                  id="inspector-environment"
                >
                  <option value="">— None —</option>
                  {ENV_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-[10px] font-display text-text-muted uppercase tracking-wider mb-1.5">
                  Region
                </label>
                <input
                  type="text"
                  value={(data.region as string) || ""}
                  onChange={(e) => updateNodeData(selectedNode.id, { region: e.target.value || undefined })}
                  className="input w-full text-xs"
                  placeholder="us-east-1"
                  id="inspector-region"
                />
              </div>
            </div>

            {/* Instances + SLA row */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-[10px] font-display text-text-muted uppercase tracking-wider mb-1.5">
                  Instances
                </label>
                <input
                  type="number"
                  min={1}
                  value={data.instances !== undefined ? data.instances : ""}
                  onChange={(e) => {
                    const val = e.target.value ? parseInt(e.target.value, 10) : undefined;
                    updateNodeData(selectedNode.id, { instances: val });
                  }}
                  className="input w-full text-xs"
                  placeholder="1"
                  id="inspector-instances"
                />
              </div>
              <div>
                <label className="block text-[10px] font-display text-text-muted uppercase tracking-wider mb-1.5">
                  SLA
                </label>
                <input
                  type="text"
                  value={(data.sla as string) || ""}
                  onChange={(e) => updateNodeData(selectedNode.id, { sla: e.target.value || undefined })}
                  className="input w-full text-xs"
                  placeholder="99.99%"
                  id="inspector-sla"
                />
              </div>
            </div>
          </div>
        )}

        {/* ========== NOTES TAB ========== */}
        {activeTab === "notes" && (
          <div className="animate-fade-in">
            <label className="block text-xs font-display text-text-muted mb-2 uppercase tracking-wider">
              Notes
            </label>
            <textarea
              id="inspector-notes"
              value={metadata.notes}
              onChange={(e) => handleNotesChange(e.target.value)}
              placeholder="Add notes about this component..."
              className="input w-full min-h-[200px] resize-y text-sm font-body leading-relaxed"
            />
          </div>
        )}

        {/* ========== LINKS TAB ========== */}
        {activeTab === "links" && (
          <div className="animate-fade-in space-y-3">
            <div className="flex items-center justify-between">
              <label className="text-xs font-display text-text-muted uppercase tracking-wider">
                Links ({metadata.links.length})
              </label>
              <button
                onClick={handleAddLink}
                className="btn-ghost p-1 rounded-sm text-accent-cyan"
                id="add-link-btn"
              >
                <Plus className="w-4 h-4" />
              </button>
            </div>
            {metadata.links.length === 0 ? (
              <p className="text-xs text-text-muted italic py-4 text-center">
                No links attached. Click + to add one.
              </p>
            ) : (
              <ul className="space-y-2">
                {metadata.links.map((link, i) => (
                  <li
                    key={i}
                    className="flex items-center gap-2 p-2 bg-canvas-50 rounded-sm border border-border group"
                  >
                    <ExternalLink className="w-3.5 h-3.5 text-accent-cyan shrink-0" />
                    <a
                      href={link}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-text-secondary hover:text-accent-cyan truncate flex-1 font-mono"
                    >
                      {link}
                    </a>
                    <button
                      onClick={() => handleRemoveLink(i)}
                      className="opacity-0 group-hover:opacity-100 text-text-muted hover:text-status-error transition-opacity p-0.5"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {/* ========== CODE / CONFIG / SCHEMA TAB ========== */}
        {activeTab === "code" && (
          <div className="animate-fade-in">
            <label className="block text-xs font-display text-text-muted mb-2 uppercase tracking-wider">
              {codeConfig.label}
            </label>
            <textarea
              id="inspector-code"
              value={metadata.codeSnippet}
              onChange={(e) => handleCodeChange(e.target.value)}
              placeholder={codeConfig.placeholder}
              className="input w-full min-h-[250px] resize-y font-mono text-xs leading-relaxed"
              spellCheck="false"
            />
          </div>
        )}

      </div>

      {/* Footer */}
      <div className="p-4 border-t border-border space-y-2">
        <div className="flex items-center gap-2 text-[10px] text-text-muted font-mono">
          <span className="status-dot-active" />
          <span>Node ID: {selectedNode.id}</span>
        </div>
        <button
          id="delete-node-btn"
          onClick={() => {
            if (confirm(`Delete "${data.label}"?`)) {
              deleteNode(selectedNode.id);
              setSelectedNodeId(null);
              setSidebarMode("none");
            }
          }}
          className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-sm text-xs font-display text-status-error border border-status-error/30 bg-status-error/5 hover:bg-status-error/15 transition-all"
        >
          <Trash2 className="w-3.5 h-3.5" />
          Delete Node
        </button>
      </div>
    </div>
  );
}
