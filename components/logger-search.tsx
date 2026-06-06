"use client";

import { useEffect, useRef, useState } from "react";
import { FiCrosshair, FiSearch, FiX } from "react-icons/fi";
import { type GeocodeResult, searchAddress } from "../src/geocode";

interface LoggerSearchProps {
  onSelect: (result: GeocodeResult) => void;
  onLocate: (lat: number, lng: number) => void;
}

const DEBOUNCE_MS = 300;

export default function LoggerSearch({
  onSelect,
  onLocate,
}: LoggerSearchProps) {
  const [queryString, setQueryString] = useState<string>("");
  const [results, setResults] = useState<GeocodeResult[]>([]);
  const [isOpen, setIsOpen] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [isLocating, setIsLocating] = useState<boolean>(false);

  useEffect(() => {
    const trimmed = queryString.trim();
    if (trimmed.length < 3) {
      setResults([]);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      searchAddress(trimmed, controller.signal)
        .then((hits) => {
          setResults(hits);
          setIsOpen(true);
        })
        .catch((err: unknown) => {
          if ((err as { name?: string }).name === "AbortError") {
            return;
          }
          setError("Search failed");
        });
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [queryString]);

  const handleLocate = () => {
    if (!("geolocation" in navigator)) {
      setError("Geolocation not supported");
      return;
    }
    setIsLocating(true);
    setError(null);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setIsLocating(false);
        onLocate(position.coords.latitude, position.coords.longitude);
      },
      (geoError) => {
        setIsLocating(false);
        if (geoError.code === geoError.PERMISSION_DENIED) {
          setError("Location permission denied");
        } else {
          setError("Couldn't get your location");
        }
      },
      { enableHighAccuracy: true, timeout: 10_000 },
    );
  };

  const handleSelect = (result: GeocodeResult) => {
    onSelect(result);
    setQueryString("");
    setResults([]);
    setIsOpen(false);
  };

  const wrapperRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const onDocClick = (event: MouseEvent) => {
      if (
        wrapperRef.current &&
        !wrapperRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  return (
    <div
      ref={wrapperRef}
      className="absolute top-16 left-3 right-3 z-[1000] md:top-3 md:left-1/2 md:-translate-x-1/2 md:w-[28rem] md:max-w-[90vw]"
    >
      <div className="flex items-center gap-2 rounded-2xl bg-white/85 px-3 py-2 shadow-lg ring-1 ring-black/5 backdrop-blur-md dark:bg-slate-800/80 dark:ring-white/10">
        <FiSearch
          className="h-4 w-4 text-slate-400 dark:text-slate-500"
          aria-hidden="true"
        />
        <input
          type="text"
          value={queryString}
          onChange={(event) => setQueryString(event.target.value)}
          onFocus={() => {
            if (results.length > 0) {
              setIsOpen(true);
            }
          }}
          placeholder="Search an address"
          className="flex-1 bg-transparent text-sm outline-none placeholder:text-slate-400 dark:placeholder:text-slate-500"
        />
        {queryString ? (
          <button
            type="button"
            onClick={() => {
              setQueryString("");
              setResults([]);
              setIsOpen(false);
            }}
            className="rounded-full p-1.5 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700"
            aria-label="Clear search"
          >
            <FiX />
          </button>
        ) : null}
        <span className="h-5 w-px bg-slate-200 dark:bg-slate-700" />
        <button
          type="button"
          onClick={handleLocate}
          disabled={isLocating}
          className="grid h-7 w-7 place-items-center rounded-full bg-brand-500 text-white shadow-sm transition hover:bg-brand-600 disabled:opacity-50"
          aria-label="Use my location"
          title="Center on my location"
        >
          <FiCrosshair className={isLocating ? "animate-spin" : undefined} />
        </button>
      </div>
      {error ? (
        <div className="mt-2 rounded-xl bg-rose-100/90 px-3 py-1.5 text-xs text-rose-800 shadow ring-1 ring-rose-200/60 backdrop-blur-md dark:bg-rose-900/40 dark:text-rose-100 dark:ring-rose-700/40">
          {error}
        </div>
      ) : null}
      {isOpen && results.length > 0 ? (
        <ul className="mt-2 max-h-80 overflow-y-auto rounded-2xl bg-white/95 shadow-2xl ring-1 ring-black/5 backdrop-blur-md dark:bg-slate-800/95 dark:ring-white/10">
          {results.map((result) => (
            <li key={result.placeId}>
              <button
                type="button"
                onClick={() => handleSelect(result)}
                className="block w-full px-3 py-2.5 text-left text-sm hover:bg-slate-50 dark:hover:bg-slate-700/60"
              >
                <div className="line-clamp-2 text-slate-800 dark:text-slate-100">
                  {result.displayName}
                </div>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
