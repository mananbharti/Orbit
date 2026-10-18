import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

const siteUrl = "https://heyorbit.xyz";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: "Orbit — Your phone and PC, on the same team",
  description:
    "Orbit is an open-source, local-first project connecting phones and computers. The desktop and phone apps are built and in private device testing.",
  applicationName: "Orbit",
  alternates: { canonical: "/" },
  icons: { icon: "/favicon.svg" },
  openGraph: {
    type: "website",
    url: siteUrl,
    siteName: "Orbit",
    title: "Orbit — Your phone and PC, on the same team",
    description:
      "A local-first companion for your phone and computer. Both apps are built and in private device testing.",
    images: [{ url: "/og-image.svg", width: 1200, height: 630, alt: "Orbit connects your phone and computer" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Orbit — Your phone and PC, on the same team",
    description: "A local-first companion for your phone and computer. Both apps are built and in private device testing.",
    images: ["/og-image.svg"],
  },
  robots: { index: true, follow: true },
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
