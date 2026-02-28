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
      <body className="bg-background text-foreground antialiased">
        <div className="flex min-h-dvh flex-col px-2 py-2 pt-safe sm:px-3 sm:py-3">
          <div className="ember-shell flex min-h-0 flex-1 overflow-hidden rounded-[28px] border border-white/10">
            {children}
          </div>
        </div>
      </body>
    </html>
  );
}
