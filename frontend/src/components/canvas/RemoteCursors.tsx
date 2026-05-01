"use client";

import React from "react";

interface RemoteCursor {
  userId: string;
  userName: string;
  x: number;
  y: number;
  color: string;
}

interface RemoteCursorsProps {
  cursors: RemoteCursor[];
}

export default function RemoteCursors({ cursors }: RemoteCursorsProps) {
  return (
    <div className="pointer-events-none absolute inset-0 z-50 overflow-hidden">
      {cursors.map((cursor) => (
        <div
          key={cursor.userId}
          className="absolute transition-all duration-100 ease-out"
          style={{
            left: cursor.x,
            top: cursor.y,
            transform: "translate(-2px, -2px)",
          }}
        >
          {/* Cursor arrow */}
          <svg
            width="16"
            height="20"
            viewBox="0 0 16 20"
            fill="none"
            className="drop-shadow-lg"
          >
            <path
              d="M0 0L16 12L8 12L4 20L0 0Z"
              fill={cursor.color}
              stroke="rgba(0,0,0,0.3)"
              strokeWidth="0.5"
            />
          </svg>
          {/* Name tag */}
          <div
            className="absolute left-4 top-3 px-2 py-0.5 rounded-sm text-[10px] font-display font-semibold whitespace-nowrap shadow-lg"
            style={{
              backgroundColor: cursor.color,
              color: "#050505",
            }}
          >
            {cursor.userName}
          </div>
        </div>
      ))}
    </div>
  );
}
