import type { Metadata } from "next";
import "./globals.css";
import { Toaster } from "sonner";

const themeBootstrap = `
  (() => {
    try {
      const savedTheme = localStorage.getItem("ss_theme");
      const theme = savedTheme === "dark" ? "dark" : "light";
      document.documentElement.setAttribute("data-theme", theme);
    } catch {
      document.documentElement.setAttribute("data-theme", "light");
    }
  })();
`;

export const metadata: Metadata = {
  title: "System Synthesis — Collaborative Architecture Modeling",
  description:
    "Model, lint, version, and export collaborative software architecture graphs.",
  keywords: [
    "system architecture",
    "whiteboard",
    "software engineering",
    "diagram",
    "collaboration",
    "architecture linting",
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" data-theme="light" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootstrap }} />
      </head>
      <body className="min-h-screen bg-canvas text-text-primary font-body antialiased">
        {children}
        <Toaster theme="system" position="bottom-right" richColors />
      </body>
    </html>
  );
}
