"use client";

import React, { useState, useRef, useEffect, useCallback } from "react";
import { useBoardStore } from "@/store/boardStore";
import { getSocket } from "@/lib/socket";
import { useReactFlow } from "@xyflow/react";
import {
  X,
  Sparkles,
  Layers,
  Grid3X3,
  Terminal as TerminalIcon,
  AlertTriangle,
  Database,
  Globe,
  CheckSquare,
  Square,
  Bot,
  Loader2,
  Zap,
  Server,
  HardDrive,
  Monitor,
  Shield,
  Container,
  Eye,
  GripVertical,
  Copy,
} from "lucide-react";
import type { AIAnalysisResult } from "@system-synthesis/shared";

type TabId = "ai-assist" | "layers" | "components" | "terminal";

const sidebarTabs: { id: TabId; label: string; icon: React.ReactNode }[] = [
  { id: "ai-assist", label: "AI Assist", icon: <Sparkles className="w-4 h-4" /> },
  { id: "layers", label: "Layers", icon: <Layers className="w-4 h-4" /> },
  { id: "components", label: "Components", icon: <Grid3X3 className="w-4 h-4" /> },
  { id: "terminal", label: "Terminal", icon: <TerminalIcon className="w-4 h-4" /> },
];

const mockAnalysis: AIAnalysisResult = {
  missingComponents: [
    { title: "Missing Dependency", description: "Auth Service lacks direct connection to an Identity Provider node.", severity: "critical" },
    { title: "No Monitoring", description: "Architecture is missing observability stack (Prometheus, Grafana, or Datadog).", severity: "warning" },
  ],
  suggestedStorage: [
    { name: "PostgreSQL", type: "primary" },
    { name: "Redis Cache", type: "cache" },
    { name: "ElasticSearch", type: "search" },
  ],
  apiRecommendations: [
    { name: "RESTful API", description: "Best for broad client compatibility and standard CRUD operations.", badge: "Standard" },
    { name: "gRPC", description: "Recommended for internal microservice-to-microservice communication.", badge: "High-Perf" },
  ],
  scalabilityChecklist: [
    { label: "Horizontal Pod Autoscaling", checked: true },
    { label: "Rate Limiting Middleware", checked: false },
    { label: "Database Connection Pooling", checked: false },
    { label: "CDN for Static Assets", checked: false },
    { label: "Circuit Breaker Pattern", checked: true },
  ],
};

const COMPONENT_TYPES = [
  { type: "service", label: "Service", icon: <Server className="w-3.5 h-3.5 text-accent-cyan" /> },
  { type: "database", label: "Database", icon: <Database className="w-3.5 h-3.5 text-accent-cyan" /> },
  { type: "gateway", label: "Gateway", icon: <Globe className="w-3.5 h-3.5 text-accent-cyan" /> },
  { type: "queue", label: "Queue", icon: <Layers className="w-3.5 h-3.5 text-accent-cyan" /> },
  { type: "cache", label: "Cache", icon: <HardDrive className="w-3.5 h-3.5 text-accent-cyan" /> },
  { type: "client", label: "Client", icon: <Monitor className="w-3.5 h-3.5 text-accent-cyan" /> },
  { type: "loadbalancer", label: "Load Balancer", icon: <Shield className="w-3.5 h-3.5 text-accent-cyan" /> },
  { type: "storage", label: "Storage", icon: <Container className="w-3.5 h-3.5 text-accent-cyan" /> },
];

// Terminal command output line
interface TerminalLine {
  type: "input" | "output" | "error" | "success";
  text: string;
}

export default function ArchitectureAssist() {
  const [activeTab, setActiveTab] = useState<TabId>("ai-assist");
  const {
    aiAnalysis,
    isAnalyzing,
    setAiAnalysis,
    setIsAnalyzing,
    setSidebarMode,
    nodes,
    edges,
    setSelectedNodeId,
    getSerializedNodes,
    getSerializedEdges,
    boardId,
  } = useBoardStore();

  const analysis = aiAnalysis || mockAnalysis;

  const reactFlowInstance = useReactFlow();

  const handleAnalyze = async () => {
    setIsAnalyzing(true);
    const serializedNodes = getSerializedNodes();
    const serializedEdges = getSerializedEdges();

    const socket = getSocket();
    if (socket.connected) {
      socket.emit("request_ai_analysis", {
        boardId,
        nodes: serializedNodes,
        edges: serializedEdges,
      });
      return;
    }

    try {
      const apiUrl = process.env.NEXT_PUBLIC_SOCKET_URL || "http://localhost:4000";
      const response = await fetch(`${apiUrl}/api/ai/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nodes: serializedNodes, edges: serializedEdges }),
      });
      if (response.ok) {
        const result = await response.json();
        setAiAnalysis(result);
        setIsAnalyzing(false);
        return;
      }
    } catch {}

    await new Promise((r) => setTimeout(r, 1500));
    setAiAnalysis(mockAnalysis);
    setIsAnalyzing(false);
  };

  const [checklist, setChecklist] = useState(analysis.scalabilityChecklist);

  const toggleCheckItem = (index: number) => {
    setChecklist((prev) =>
      prev.map((item, i) =>
        i === index ? { ...item, checked: !item.checked } : item
      )
    );
  };

  // --- Layers: click to select + center ---
  const handleLayerClick = (nodeId: string) => {
    setSelectedNodeId(nodeId);
    setSidebarMode("inspector");
    if (reactFlowInstance) {
      const node = nodes.find((n) => n.id === nodeId);
      if (node) {
        reactFlowInstance.setCenter(
          node.position.x + 100,
          node.position.y + 50,
          { zoom: 1.2, duration: 400 }
        );
      }
    }
  };

  // --- Components: drag to add ---
  const handleDragStart = (event: React.DragEvent, nodeType: string) => {
    event.dataTransfer.setData("application/reactflow", nodeType);
    event.dataTransfer.effectAllowed = "move";
  };

  // --- Terminal: interactive command line ---
  const [terminalLines, setTerminalLines] = useState<TerminalLine[]>([
    { type: "output", text: "System Synthesis Terminal v1.0" },
    { type: "output", text: 'Type "help" for available commands.' },
  ]);
  const [terminalInput, setTerminalInput] = useState("");
  const [cmdHistory, setCmdHistory] = useState<string[]>([]);
  const [historyIdx, setHistoryIdx] = useState(-1);
  const terminalEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    terminalEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [terminalLines]);

  const executeCommand = useCallback(
    (cmd: string) => {
      const trimmed = cmd.trim().toLowerCase();
      const newLines: TerminalLine[] = [
        ...terminalLines,
        { type: "input", text: `$ ${cmd}` },
      ];

      const storeState = useBoardStore.getState();

      switch (trimmed) {
        case "help":
          newLines.push(
            { type: "output", text: "Available commands:" },
            { type: "success", text: "  status        — Board connection status" },
            { type: "success", text: "  list nodes    — List all nodes" },
            { type: "success", text: "  list edges    — List all edges" },
            { type: "success", text: "  analyze       — Trigger AI analysis" },
            { type: "success", text: "  export json   — Copy board JSON to clipboard" },
            { type: "success", text: "  clear         — Clear terminal" },
            { type: "success", text: "  help          — Show this message" }
          );
          break;

        case "status":
          const socket = getSocket();
          newLines.push(
            { type: "output", text: `Board: ${window.location.pathname.split("/").pop() || "unknown"}` },
            { type: "output", text: `Nodes: ${storeState.nodes.length} | Edges: ${storeState.edges.length}` },
            {
              type: socket.connected ? "success" : "error",
              text: socket.connected ? "Connected ✓" : "Disconnected ✗",
            }
          );
          break;

        case "list nodes":
          if (storeState.nodes.length === 0) {
            newLines.push({ type: "output", text: "No nodes on canvas." });
          } else {
            storeState.nodes.forEach((n) => {
              newLines.push({
                type: "output",
                text: `  [${n.data.nodeType}] ${n.data.label} (${n.id})`,
              });
            });
          }
          break;

        case "list edges":
          if (storeState.edges.length === 0) {
            newLines.push({ type: "output", text: "No edges on canvas." });
          } else {
            storeState.edges.forEach((e) => {
              newLines.push({
                type: "output",
                text: `  ${e.source} → ${e.target} (${e.id})`,
              });
            });
          }
          break;

        case "analyze":
          newLines.push({ type: "output", text: "Triggering AI analysis..." });
          handleAnalyze();
          break;

        case "export json":
          const boardData = {
            nodes: storeState.getSerializedNodes(),
            edges: storeState.getSerializedEdges(),
          };
          navigator.clipboard.writeText(JSON.stringify(boardData, null, 2));
          newLines.push({ type: "success", text: "Board JSON copied to clipboard ✓" });
          break;

        case "clear":
          setTerminalLines([]);
          setTerminalInput("");
          return;

        default:
          newLines.push({
            type: "error",
            text: `Unknown command: "${cmd}". Type "help" for available commands.`,
          });
      }

      setTerminalLines(newLines);
      setTerminalInput("");
      setCmdHistory((prev) => [...prev, cmd]);
      setHistoryIdx(-1);
    },
    [terminalLines, handleAnalyze]
  );

  const handleTerminalKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && terminalInput.trim()) {
      executeCommand(terminalInput);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (cmdHistory.length > 0) {
        const newIdx = historyIdx < cmdHistory.length - 1 ? historyIdx + 1 : historyIdx;
        setHistoryIdx(newIdx);
        setTerminalInput(cmdHistory[cmdHistory.length - 1 - newIdx]);
      }
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      if (historyIdx > 0) {
        const newIdx = historyIdx - 1;
        setHistoryIdx(newIdx);
        setTerminalInput(cmdHistory[cmdHistory.length - 1 - newIdx]);
      } else {
        setHistoryIdx(-1);
        setTerminalInput("");
      }
    }
  };

  return (
    <div className="sidebar" id="architecture-assist">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-sm bg-accent-cyan/15 border border-accent-cyan/30 flex items-center justify-center">
            <Bot className="w-5 h-5 text-accent-cyan" />
          </div>
          <div>
            <h3 className="font-display font-bold text-sm text-accent-cyan">
              Architecture Assist
            </h3>
            <p className="text-xs text-text-muted">AI-Powered Design</p>
          </div>
        </div>
        <button
          onClick={() => setSidebarMode("none")}
          className="btn-ghost p-1.5 rounded-sm"
          id="close-ai-assist"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-border">
        {sidebarTabs.map((tab) => (
          <button
            key={tab.id}
            id={`assist-tab-${tab.id}`}
            onClick={() => setActiveTab(tab.id)}
            className={`flex flex-col items-center gap-1 px-3 py-2.5 text-[10px] font-display uppercase tracking-wider transition-all flex-1 ${
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

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4 space-y-5">
        {/* =========== AI ASSIST TAB =========== */}
        {activeTab === "ai-assist" && (
          <div className="animate-fade-in space-y-5">
            <section>
              <h4 className="text-xs font-display text-text-muted uppercase tracking-wider mb-3 flex items-center gap-1.5">
                <AlertTriangle className="w-3.5 h-3.5" />
                Missing Components
              </h4>
              <div className="space-y-2">
                {analysis.missingComponents.map((comp, i) => (
                  <div
                    key={i}
                    className={`p-3 rounded-sm border-l-2 ${
                      comp.severity === "critical"
                        ? "border-l-status-error bg-status-error/5"
                        : "border-l-status-warning bg-status-warning/5"
                    }`}
                  >
                    <div className="flex items-start gap-2">
                      <AlertTriangle
                        className={`w-3.5 h-3.5 shrink-0 mt-0.5 ${
                          comp.severity === "critical" ? "text-status-error" : "text-status-warning"
                        }`}
                      />
                      <div>
                        <p className="text-xs font-display font-semibold text-text-primary">{comp.title}</p>
                        <p className="text-xs text-text-muted mt-1 leading-relaxed">{comp.description}</p>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </section>

            <section>
              <h4 className="text-xs font-display text-text-muted uppercase tracking-wider mb-3 flex items-center gap-1.5">
                <Database className="w-3.5 h-3.5" />
                Suggested Storage
              </h4>
              <div className="flex flex-wrap gap-2">
                {analysis.suggestedStorage.map((s, i) => (
                  <span
                    key={i}
                    className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-sm text-xs font-mono border ${
                      s.type === "primary"
                        ? "border-status-active/30 text-status-active bg-status-active/10"
                        : s.type === "cache"
                        ? "border-status-error/30 text-status-error bg-status-error/10"
                        : "border-accent-cyan/30 text-accent-cyan bg-accent-cyan/10"
                    }`}
                  >
                    <span
                      className={`w-1.5 h-1.5 rounded-full ${
                        s.type === "primary" ? "bg-status-active" : s.type === "cache" ? "bg-status-error" : "bg-accent-cyan"
                      }`}
                    />
                    {s.name}
                  </span>
                ))}
              </div>
            </section>

            <section>
              <h4 className="text-xs font-display text-text-muted uppercase tracking-wider mb-3 flex items-center gap-1.5">
                <Globe className="w-3.5 h-3.5" />
                API Recommendations
              </h4>
              <div className="space-y-2">
                {analysis.apiRecommendations.map((rec, i) => (
                  <div key={i} className="p-3 bg-canvas-50 rounded-sm border border-border">
                    <div className="flex items-center justify-between mb-1.5">
                      <span className="text-xs font-display font-bold text-text-primary">{rec.name}</span>
                      <span className="badge-cyan text-[10px]">{rec.badge}</span>
                    </div>
                    <p className="text-[11px] text-text-muted leading-relaxed">{rec.description}</p>
                  </div>
                ))}
              </div>
            </section>

            <section>
              <h4 className="text-xs font-display text-text-muted uppercase tracking-wider mb-3 flex items-center gap-1.5">
                <Zap className="w-3.5 h-3.5" />
                Scalability Checklist
              </h4>
              <ul className="space-y-2">
                {checklist.map((item, i) => (
                  <li
                    key={i}
                    className="flex items-center gap-2.5 p-2 bg-canvas-50 rounded-sm border border-border cursor-pointer hover:border-border-light transition-colors"
                    onClick={() => toggleCheckItem(i)}
                  >
                    {item.checked ? (
                      <CheckSquare className="w-4 h-4 text-accent-cyan shrink-0" />
                    ) : (
                      <Square className="w-4 h-4 text-text-muted shrink-0" />
                    )}
                    <span className={`text-xs ${item.checked ? "text-text-primary" : "text-text-muted"}`}>
                      {item.label}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          </div>
        )}

        {/* =========== LAYERS TAB =========== */}
        {activeTab === "layers" && (
          <div className="animate-fade-in">
            <p className="text-xs text-text-muted mb-3">
              {nodes.length} node{nodes.length !== 1 ? "s" : ""} · Click to select and focus
            </p>
            {nodes.length === 0 ? (
              <div className="text-center py-8">
                <Layers className="w-8 h-8 text-text-muted/30 mx-auto mb-2" />
                <p className="text-xs text-text-muted">No nodes yet. Add components from the toolbar.</p>
              </div>
            ) : (
              <ul className="space-y-1.5">
                {nodes.map((node) => (
                  <li
                    key={node.id}
                    onClick={() => handleLayerClick(node.id)}
                    className="flex items-center gap-2 p-2.5 bg-canvas-50 rounded-sm border border-border hover:border-accent-cyan/40 hover:shadow-glow-cyan transition-all cursor-pointer group"
                  >
                    <span
                      className={`w-2 h-2 rounded-full shrink-0 ${
                        node.data.status === "active" ? "bg-status-active" : "bg-text-muted"
                      }`}
                    />
                    <span className="text-xs font-display text-text-primary group-hover:text-accent-cyan transition-colors flex-1 truncate">
                      {node.data.label}
                    </span>
                    <span className="text-[10px] text-text-muted font-mono shrink-0">
                      {node.data.nodeType}
                    </span>
                    <Eye className="w-3 h-3 text-text-muted opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {/* =========== COMPONENTS TAB =========== */}
        {activeTab === "components" && (
          <div className="animate-fade-in">
            <p className="text-xs text-text-muted mb-3">
              Drag components onto the canvas to add them.
            </p>
            {COMPONENT_TYPES.map((comp) => (
              <div
                key={comp.type}
                draggable
                onDragStart={(e) => handleDragStart(e, comp.type)}
                className="flex items-center gap-2.5 p-2.5 mb-1.5 bg-canvas-50 rounded-sm border border-border hover:border-accent-cyan/40 hover:shadow-glow-cyan transition-all cursor-grab active:cursor-grabbing"
              >
                <GripVertical className="w-3 h-3 text-text-muted/40 shrink-0" />
                {comp.icon}
                <span className="text-xs font-display text-text-primary">
                  {comp.label}
                </span>
              </div>
            ))}
          </div>
        )}

        {/* =========== TERMINAL TAB =========== */}
        {activeTab === "terminal" && (
          <div className="animate-fade-in">
            <div
              className="bg-canvas rounded-sm border border-border p-3 font-mono text-xs text-text-muted min-h-[300px] max-h-[500px] overflow-y-auto flex flex-col"
              onClick={() => inputRef.current?.focus()}
            >
              {terminalLines.map((line, i) => (
                <p
                  key={i}
                  className={`whitespace-pre-wrap ${
                    line.type === "input"
                      ? "text-accent-cyan"
                      : line.type === "error"
                      ? "text-status-error"
                      : line.type === "success"
                      ? "text-status-active"
                      : "text-text-muted"
                  }`}
                >
                  {line.text}
                </p>
              ))}
              <div className="flex items-center mt-1">
                <span className="text-accent-cyan mr-1">$</span>
                <input
                  ref={inputRef}
                  type="text"
                  value={terminalInput}
                  onChange={(e) => setTerminalInput(e.target.value)}
                  onKeyDown={handleTerminalKeyDown}
                  className="flex-1 bg-transparent outline-none text-text-primary caret-accent-cyan"
                  placeholder="Type a command..."
                  autoFocus={activeTab === "terminal"}
                />
              </div>
              <div ref={terminalEndRef} />
            </div>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="p-4 border-t border-border">
        <button
          id="optimize-flow-btn"
          onClick={handleAnalyze}
          disabled={isAnalyzing}
          className="btn-primary w-full flex items-center justify-center gap-2 py-2.5 text-sm"
        >
          {isAnalyzing ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              Analyzing...
            </>
          ) : (
            <>
              <Sparkles className="w-4 h-4" />
              Optimize Flow
            </>
          )}
        </button>
      </div>
    </div>
  );
}
