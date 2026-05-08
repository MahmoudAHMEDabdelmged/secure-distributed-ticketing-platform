"use client";

import { ThemeProvider } from "@/src/lib/theme";

export function Providers({ children }: { children: React.ReactNode }) {
  return <ThemeProvider>{children}</ThemeProvider>;
}
