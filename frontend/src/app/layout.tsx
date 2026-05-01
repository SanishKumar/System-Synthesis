import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "System Synthesis — Executable Architecture Canvas",
  description:
    "A visual whiteboard for software engineers to design, collaborate, and analyze system architectures in real-time with AI-powered insights.",
  keywords: [
    "system architecture",
    "whiteboard",
    "software engineering",
    "diagram",
    "collaboration",
    "AI analysis",
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen bg-canvas text-text-primary font-body antialiased">
        {children}
      </body>
    </html>
  );
}
