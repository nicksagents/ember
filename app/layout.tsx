import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Ember",
  description: "Ember - private local AI with your own memory",
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Ember",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: "#0a0a0a",
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className="h-dvh overflow-hidden bg-black text-foreground antialiased">
        <div className="flex h-dvh flex-col overflow-hidden pt-safe sm:px-2.5 sm:py-2.5">
          <div className="ember-shell flex min-h-0 flex-1 overflow-hidden border border-white/10 sm:rounded-[24px]">
            {children}
          </div>
        </div>
      </body>
    </html>
  );
}
