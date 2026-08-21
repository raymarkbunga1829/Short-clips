import type { Metadata, Viewport } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "Short-clips",
  description: "Type a topic, get a 9:16 clip with a voiceover and burned-in captions.",
  applicationName: "Short-clips",
  appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "Short-clips" },
};

export const viewport: Viewport = {
  themeColor: "#0B0F14",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
