import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { Footer, Header } from "@/components/chrome";
import { SITE_NAME, api, type Viewer } from "@/lib/api";

const sans = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-sans",
});

const mono = JetBrains_Mono({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-mono",
});

export const metadata: Metadata = {
  title: {
    default: `${SITE_NAME} — Roblox moderation records`,
    template: `%s · ${SITE_NAME}`,
  },
  description:
    "A searchable archive of Roblox moderation records. Every entry carries its source, its evidence and its full edit history.",
  robots: {
    index: true,
    follow: true,
    // Archived evidence should not be mirrored into image search results.
    noimageindex: true,
  },
  openGraph: {
    type: "website",
    siteName: SITE_NAME,
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#08090b" },
    { media: "(prefers-color-scheme: light)", color: "#fcfcfd" },
  ],
};

/**
 * Applied before first paint so a pinned theme never flashes the other one.
 * Inline by necessity — any external script would run too late.
 */
const themeScript = `
(function(){try{var t=localStorage.getItem("archive-theme");
if(t==="dark"||t==="light")document.documentElement.setAttribute("data-theme",t);}catch(e){}})();
`;

const ANON: Viewer = { authenticated: false, authEnabled: true, devBypass: false, user: null };

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // A failure here must not take the whole archive down — fall back to anon.
  const viewer = await api.viewer().catch(() => ANON);

  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="flex min-h-dvh flex-col">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-3 focus:z-50 focus:rounded-md focus:bg-accent focus:px-3 focus:py-2 focus:text-sm focus:text-accent-fg"
        >
          Skip to content
        </a>

        <Header viewer={viewer} />

        <main id="main" className="mx-auto w-full max-w-content flex-1 px-4 py-8 sm:px-6">
          {children}
        </main>

        <Footer />
      </body>
    </html>
  );
}
