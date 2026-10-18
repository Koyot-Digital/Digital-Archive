import { NextResponse, type NextRequest } from "next/server";
// The constants subpath, not the package root: the root barrel re-exports the
// zod schemas, and middleware runs on every request - there is no reason to
// ship a validation library into that bundle to read one string.
import { SESSION_COOKIE_NAME } from "@archive/shared/constants";

/**
 * The outer gate.
 *
 * Two jobs, and it is important they are not confused with each other:
 *
 *  1. **Turn anonymous traffic away before it renders anything.** A visitor
 *     with no session cookie is redirected to /login here, so the archive
 *     never begins assembling a page for them.
 *
 *  2. **Tell the server components which path was asked for**, via
 *     `x-archive-path`, so the root layout can build a `return_to` without
 *     re-deriving the URL.
 *
 * What this is *not* is the authority on whether a cookie is valid. It only
 * checks that one is present - a cookie is a string, and this runs before any
 * of the machinery that could verify its signature or look up its session.
 * Verification happens where it can be done properly: the root layout asks
 * the API, and the API itself refuses every read without a session. Treating
 * cookie presence as proof here would mean anyone could forge the gate by
 * setting `archive_session=x` in their own browser.
 *
 * So: this is the fast path, not the lock.
 */

/** Reachable without a session. Everything else is not. */
const OPEN_PATHS = new Set(["/login"]);

/**
 * Development bypass. The API grants every request admin rights when this is
 * off, and nobody holds a session cookie, so the gate below would bounce
 * every request to /login - where the page would send it straight back,
 * because the API reports it as signed in. Checked here to break that loop.
 *
 * Read at request time on the server; `config.ts` in the API refuses this
 * value under NODE_ENV=production, so it cannot unlock a deployed instance.
 */
const authDisabled = () => /^(0|false|no|off)$/i.test((process.env.AUTH_ENABLED ?? "true").trim());

export function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;

  const headers = new Headers(req.headers);
  headers.set("x-archive-path", `${pathname}${search}`);
  const proceed = () => NextResponse.next({ request: { headers } });

  if (authDisabled() || OPEN_PATHS.has(pathname)) return proceed();
  if (req.cookies.has(SESSION_COOKIE_NAME)) return proceed();

  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  url.searchParams.set("return_to", `${pathname}${search}`);
  return NextResponse.redirect(url);
}

export const config = {
  /*
   * Everything except Next's own build output and the two files that have to
   * stay fetchable for the site to behave correctly while closed:
   * robots.txt, which is how a crawler learns to stay out, and the favicon,
   * which would otherwise 307 to /login on every page.
   */
  matcher: ["/((?!_next/static|_next/image|favicon.ico|robots.txt).*)"],
};
