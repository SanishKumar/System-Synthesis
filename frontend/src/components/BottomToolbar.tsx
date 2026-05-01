"use client";

import React, { useState, useRef, useEffect } from "react";
import {
  MousePointer2,
  Pencil,
  Type,
  Undo2,
  Server,
  Database,
  Globe,
  Layers,
  HardDrive,
  Monitor,
  Shield,
  Container,
  ChevronUp,
} from "lucide-react";

type Tool = "select" | "draw" | "shapes" | "text" | "undo";

interface BottomToolbarProps {
  activeTool?: Tool;
  onToolChange?: (tool: Tool) => void;
  onShapeSelected?: (nodeType: string) => void;
  onUndo?: () => void;
}

const nodeTypes = [
  { type: "service", label: "Service", icon: <Server className="w-4 h-4" /> },
  { type: "database", label: "Database", icon: <Database className="w-4 h-4" /> },
  { type: "gateway", label: "Gateway", icon: <Globe className="w-4 h-4" /> },
  { type: "queue", label: "Queue", icon: <Layers className="w-4 h-4" /> },
  { type: "cache", label: "Cache", icon: <HardDrive className="w-4 h-4" /> },
  { type: "client", label: "Client", icon: <Monitor className="w-4 h-4" /> },
  { type: "loadbalancer", label: "Load Balancer", icon: <Shield className="w-4 h-4" /> },
  { type: "storage", label: "Storage", icon: <Container className="w-4 h-4" /> },
];

const tools: { id: Tool; label: string; icon: React.ReactNode }[] = [
  { id: "select", label: "SELECT", icon: <MousePointer2 className="w-5 h-5" /> },
  { id: "draw", label: "CONNECT", icon: <Pencil className="w-5 h-5" /> },
  { id: "shapes", label: "ADD NODE", icon: <ChevronUp className="w-5 h-5" /> },
  { id: "text", label: "TEXT", icon: <Type className="w-5 h-5" /> },
  { id: "undo", label: "UNDO", icon: <Undo2 className="w-5 h-5" /> },
];

export default function BottomToolbar({
  activeTool = "select",
  onToolChange,
  onShapeSelected,
  onUndo,
}: BottomToolbarProps) {
  const [showShapes, setShowShapes] = useState(false);
  const shapesRef = useRef<HTMLDivElement>(null);

  // Close shapes dropdown on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (shapesRef.current && !shapesRef.current.contains(e.target as Node)) {
        setShowShapes(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const handleToolClick = (tool: Tool) => {
    if (tool === "shapes") {
      setShowShapes(!showShapes);
      return;
    }
    if (tool === "undo") {
      onUndo?.();
      return;
    }
    setShowShapes(false);
    onToolChange?.(tool);
  };

  const handleShapeClick = (nodeType: string) => {
    onShapeSelected?.(nodeType);
    setShowShapes(false);
  };

  return (
    <div
      id="bottom-toolbar"
      className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40
                 flex items-center gap-1 px-2 py-2
                 bg-surface/90 backdrop-blur-md border border-border rounded-md
                 shadow-card"
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
              className={`flex flex-col items-center gap-1 px-4 py-2 rounded-sm transition-all duration-150 ${
                isActive
                  ? "bg-accent-cyan/15 text-accent-cyan shadow-glow-cyan"
                  : "text-text-muted hover:text-text-primary hover:bg-surface-light"
              }`}
            >
              {tool.icon}
              <span className="text-[10px] font-display font-medium tracking-wider">
                {tool.label}
              </span>
            </button>

            {/* Shapes Dropdown */}
            {tool.id === "shapes" && showShapes && (
              <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-56 bg-surface border border-border rounded-md shadow-card overflow-hidden z-50">
                <div className="px-3 py-2 border-b border-border">
                  <span className="text-[10px] font-display text-text-muted uppercase tracking-wider">
                    Add Component
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-0.5 p-1.5">
                  {nodeTypes.map((nt) => (
                    <button
                      key={nt.type}
                      onClick={() => handleShapeClick(nt.type)}
                      className="flex items-center gap-2 px-2.5 py-2 rounded-sm text-xs font-display text-text-secondary hover:bg-accent-cyan/10 hover:text-accent-cyan transition-all"
                    >
                      <span className="text-accent-cyan/60">{nt.icon}</span>
                      {nt.label}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
