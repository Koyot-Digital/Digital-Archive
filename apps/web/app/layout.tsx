import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
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
    default: `${SITE_NAME} - Roblox and Discord moderation records`,
    template: `%s · ${SITE_NAME}`,
  },
  description:
    "A searchable archive of Roblox and Discord moderation records. Every entry carries its source, its evidence and its full edit history.",
  // Nothing here is reachable without a Discord role, so there is nothing for
  // a crawler to index - and an indexed title or excerpt would leak the
  // contents of records the gate exists to keep private. Mirrored in
  // public/robots.txt and in an X-Robots-Tag from next.config.mjs, because a
  // meta tag only helps a crawler that got as far as rendering the page.
  robots: {
    index: false,
    follow: false,
    nocache: true,
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
 * Inline by necessity - any external script would run too late.
 */
const themeScript = `
(function(){try{var t=localStorage.getItem("archive-theme");
if(t==="dark"||t==="light")document.documentElement.setAttribute("data-theme",t);}catch(e){}})();
`;

const ANON: Viewer = { authenticated: false, authEnabled: true, devBypass: false, user: null };

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Falls back to anon, which now means "send them to the login page". That
  // is the correct direction to fail in: when the archive cannot establish
  // who is asking, it must not render records on the assumption that it will
  // probably be fine.
  const viewer = await api.viewer().catch(() => ANON);

  /*
   * The authoritative gate.
   *
   * The middleware already turned away anyone with no cookie, but a cookie is
   * just a string: expired, revoked, tampered with, or belonging to an
   * account whose Discord role was removed ten minutes ago all look identical
   * until the API is asked. This is where it is asked.
   *
   * A redirect thrown from the root layout aborts the whole render, so it
   * does not matter that the page below rendered concurrently and may have
   * already taken a 401 from its own fetches - that output is discarded.
   */
  const path = (await headers()).get("x-archive-path") ?? "/";
  const onLoginPage = path === "/login" || path.startsWith("/login?");

  if (viewer.authEnabled && !viewer.authenticated && !onLoginPage) {
    redirect(`/login?return_to=${encodeURIComponent(path)}`);
  }

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

        <Footer viewer={viewer} />
      </body>
    </html>
  );
}
