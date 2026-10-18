import Link from "next/link";
import { SearchBox } from "@/components/search-box";
import { IconEmpty } from "@/components/icons";

export default function NotFound() {
  return (
    <div className="mx-auto flex max-w-prose flex-col items-center py-20 text-center">
      <IconEmpty className="h-9 w-9 text-line-strong" strokeWidth={1.3} />
      <p className="mt-4 font-mono text-xs uppercase tracking-widest text-faint">404</p>
      <h1 className="mt-3 text-2xl font-semibold tracking-tight">Nothing archived here</h1>
      <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-muted">
        This record does not exist, was never archived, or its identifier was mistyped. Archive IDs
        are 16 characters long.
      </p>

      <div className="mx-auto mt-8 max-w-md">
        <SearchBox />
      </div>

      <div className="mt-6 flex justify-center gap-2">
        <Link href="/" className="btn btn-outline">
          Home
        </Link>
        <Link href="/subjects" className="btn btn-ghost">
          Browse subjects
        </Link>
      </div>
    </div>
  );
}
