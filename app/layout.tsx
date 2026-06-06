import type { Metadata, Viewport } from "next";
import ThemeProvider from "../components/theme-provider";
import "./globals.css";

export const metadata: Metadata = {
  title: "Scenic Route",
  description: "Tag and annotate places along the way",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#0f172a",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className="h-full" suppressHydrationWarning>
      <body className="h-full bg-slate-50 text-slate-900 dark:bg-slate-900 dark:text-slate-100">
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          {children}
        </ThemeProvider>
      </body>
    </html>
  );
}
