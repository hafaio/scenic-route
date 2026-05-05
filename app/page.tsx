import Link from "next/link";

export default function Home() {
  return (
    <main className="flex min-h-full items-center justify-center p-8">
      <div className="max-w-md text-center">
        <h1 className="text-3xl font-semibold">Scenic Route</h1>
        <p className="mt-2 text-slate-600 dark:text-slate-300">
          Tag and annotate places along the way.
        </p>
        <Link
          href="/logger"
          className="mt-6 inline-block rounded-lg bg-slate-900 px-4 py-2 font-medium text-white hover:bg-slate-700 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-slate-300"
        >
          Open the logger
        </Link>
      </div>
    </main>
  );
}
