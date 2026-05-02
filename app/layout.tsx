import type { Metadata, Viewport } from "next";
import { Inter, Fraunces } from "next/font/google";
import "./globals.css";
import { PwaRegister } from "@/components/PwaRegister";
import { RootErrorBoundary } from "@/components/RootErrorBoundary";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});

const fraunces = Fraunces({
  subsets: ["latin"],
  variable: "--font-display",
  display: "swap",
  axes: ["opsz", "SOFT"],
});

export const metadata: Metadata = {
  title: "Zuzi Studio",
  description: "A creative ideation tool for Zuzi.",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Zuzi",
    startupImage: [
      // iPad Pro 12.9"
      {
        url: "/apple-splash-2048-2732.png",
        media:
          "(device-width: 1024px) and (device-height: 1366px) and (orientation: portrait)",
      },
      {
        url: "/apple-splash-2732-2048.png",
        media:
          "(device-width: 1024px) and (device-height: 1366px) and (orientation: landscape)",
      },
      // iPad Pro 11" / iPad Air 11" M2/M3
      {
        url: "/apple-splash-1668-2388.png",
        media:
          "(device-width: 834px) and (device-height: 1194px) and (orientation: portrait)",
      },
      {
        url: "/apple-splash-2388-1668.png",
        media:
          "(device-width: 834px) and (device-height: 1194px) and (orientation: landscape)",
      },
      // iPad Air 10.9" (4th/5th gen)
      {
        url: "/apple-splash-1640-2360.png",
        media:
          "(device-width: 820px) and (device-height: 1180px) and (orientation: portrait)",
      },
      {
        url: "/apple-splash-2360-1640.png",
        media:
          "(device-width: 820px) and (device-height: 1180px) and (orientation: landscape)",
      },
      // iPad mini 6 / 7
      {
        url: "/apple-splash-1488-2266.png",
        media:
          "(device-width: 744px) and (device-height: 1133px) and (orientation: portrait)",
      },
      {
        url: "/apple-splash-2266-1488.png",
        media:
          "(device-width: 744px) and (device-height: 1133px) and (orientation: landscape)",
      },
    ],
  },
  icons: {
    icon: [
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [
      { url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" },
    ],
  },
  manifest: "/manifest.webmanifest",
};

export const viewport: Viewport = {
  themeColor: "#0E0C0A",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  userScalable: false,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${fraunces.variable} antialiased`}
    >
      <body className="font-sans min-h-svh">
        {/* RootErrorBoundary wraps children so any throw during render or
            in a useEffect surfaces a recoverable UI instead of crashing
            the React root and triggering iPad Safari's "This page
            couldn't load" white screen. PwaRegister stays OUTSIDE the
            boundary so the SW + reset-and-reload affordance keep working
            even if children threw. */}
        <RootErrorBoundary>{children}</RootErrorBoundary>
        <PwaRegister />
      </body>
    </html>
  );
}
