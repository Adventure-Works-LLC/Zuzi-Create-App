import type { Metadata, Viewport } from "next";
import { Inter, Fraunces } from "next/font/google";
import "./globals.css";
import { PwaRegister } from "@/components/PwaRegister";

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
      {
        url: "/apple-splash-1668-2224.png",
        media:
          "(device-width: 834px) and (device-height: 1112px) and (orientation: portrait)",
      },
      {
        url: "/apple-splash-2224-1668.png",
        media:
          "(device-width: 834px) and (device-height: 1112px) and (orientation: landscape)",
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
        {children}
        <PwaRegister />
      </body>
    </html>
  );
}
