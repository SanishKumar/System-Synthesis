import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        canvas: {
          DEFAULT: "var(--color-canvas)",
          50: "var(--color-canvas-50)",
          100: "var(--color-canvas-100)",
        },
        surface: {
          DEFAULT: "var(--color-surface)",
          light: "var(--color-surface-light)",
          lighter: "var(--color-surface-lighter)",
        },
        accent: {
          cyan: "rgb(var(--accent-cyan-rgb) / <alpha-value>)",
          "cyan-dim": "#00919a",
          "cyan-dark": "#004d52",
          purple: "rgb(var(--accent-purple-rgb) / <alpha-value>)",
          "purple-dim": "#a06cb8",
        },
        border: {
          DEFAULT: "var(--color-border)",
          light: "var(--color-border-light)",
          focus: "rgb(var(--accent-cyan-rgb) / 1)",
        },
        status: {
          active: "#22c55e",
          inactive: "#6b7280",
          warning: "#f59e0b",
          error: "#ef4444",
        },
        text: {
          primary: "var(--color-text-primary)",
          secondary: "var(--color-text-secondary)",
          muted: "var(--color-text-muted)",
        },
      },
      fontFamily: {
        display: ['"Space Grotesk"', "system-ui", "sans-serif"],
        body: ['"Inter"', "system-ui", "sans-serif"],
        mono: ['"JetBrains Mono"', "Consolas", "monospace"],
      },
      borderRadius: {
        sm: "4px",
        md: "8px",
        DEFAULT: "4px",
      },
      boxShadow: {
        "glow-cyan": "0 0 4px rgba(var(--accent-cyan-rgb), 0.2)",
        "glow-cyan-md": "0 0 8px rgba(var(--accent-cyan-rgb), 0.25)",
        "glow-cyan-lg": "0 0 16px rgba(var(--accent-cyan-rgb), 0.3)",
        "glow-purple": "0 0 4px rgba(var(--accent-purple-rgb), 0.2)",
        "glow-purple-md": "0 0 8px rgba(var(--accent-purple-rgb), 0.25)",
        card: "0 1px 3px rgba(0, 0, 0, 0.4)",
        "card-hover": "0 4px 12px rgba(0, 0, 0, 0.5)",
      },
      backgroundImage: {
        "grid-pattern":
          "linear-gradient(rgba(38,38,38,0.5) 1px, transparent 1px), linear-gradient(90deg, rgba(38,38,38,0.5) 1px, transparent 1px)",
      },
      backgroundSize: {
        grid: "24px 24px",
      },
      animation: {
        "pulse-slow": "pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite",
        "glow-pulse": "glowPulse 2s ease-in-out infinite",
        "fade-in": "fadeIn 0.2s ease-out",
        "slide-in-right": "slideInRight 0.3s ease-out",
        "slide-in-up": "slideInUp 0.2s ease-out",
        "cursor-blink": "cursorBlink 1s step-end infinite",
      },
      keyframes: {
        glowPulse: {
          "0%, 100%": { boxShadow: "0 0 4px rgba(var(--accent-cyan-rgb), 0.2)" },
          "50%": { boxShadow: "0 0 12px rgba(var(--accent-cyan-rgb), 0.4)" },
        },
        fadeIn: {
          "0%": { opacity: "0" },
          "100%": { opacity: "1" },
        },
        slideInRight: {
          "0%": { transform: "translateX(20px)", opacity: "0" },
          "100%": { transform: "translateX(0)", opacity: "1" },
        },
        slideInUp: {
          "0%": { transform: "translateY(10px)", opacity: "0" },
          "100%": { transform: "translateY(0)", opacity: "1" },
        },
        cursorBlink: {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0" },
        },
      },
      transitionDuration: {
        DEFAULT: "150ms",
      },
    },
  },
  plugins: [],
};

export default config;
