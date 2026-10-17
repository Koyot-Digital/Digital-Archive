/**
 * Streaming skeleton.
 *
 * Deliberately NOT placed at the app root: a loading.tsx creates a Suspense
 * boundary, which makes the response stream, which commits HTTP 200 before
 * the page body runs. Any route that can call notFound() or redirect() would
 * then answer a missing record with a soft 200. Only segments that always
 * resolve get one.
 */
export default function Loading() {
  return (
    <div className="animate-fade-up">
      <div className="mb-6 space-y-2">
        <div className="skeleton h-3 w-40 rounded" />
        <div className="skeleton h-7 w-80 rounded" />
      </div>
      <div className="card divide-y divide-line overflow-hidden">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="flex gap-4 px-5 py-4">
            <div className="skeleton hidden h-16 w-24 shrink-0 rounded-md sm:block" />
            <div className="flex-1 space-y-2">
              <div className="skeleton h-3 w-28 rounded" />
              <div className="skeleton h-4 w-2/3 rounded" />
              <div className="skeleton h-3 w-full rounded" />
              <div className="skeleton h-3 w-24 rounded" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
