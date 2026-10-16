import type { ReactNode } from "react";
import "./globals.css";

export const metadata = { title: "Ask harness", description: "Chat harness demo: memory, retrieval, safe tools" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
