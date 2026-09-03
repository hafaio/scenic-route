"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { FiInbox, FiTrash2, FiX } from "react-icons/fi";
import type { Feedback } from "../src/feedback";
import { deleteFeedback, watchFeedback } from "../src/firebase";

interface FeedbackInboxProps {
  onClose: () => void;
}

function formatSent(when: Date): string {
  return when.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export default function FeedbackInbox({ onClose }: FeedbackInboxProps) {
  const [notes, setNotes] = useState<Feedback[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    return watchFeedback(
      (next) => {
        setError(null);
        setNotes(next);
      },
      () => setError("Couldn't load feedback."),
    );
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // portalled for the same reason as the feedback dialog: the toolbar's wrapper traps its z-index
  return createPortal(
    <div className="fixed inset-0 z-[1100] flex items-end justify-center md:items-center">
      <button
        type="button"
        aria-label="Close feedback inbox"
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-slate-950/40 backdrop-blur-sm"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="feedback-inbox-title"
        className="relative flex max-h-[90dvh] w-full flex-col rounded-t-3xl bg-white p-5 shadow-2xl ring-1 ring-black/5 dark:bg-slate-800 dark:ring-white/10 md:max-w-lg md:rounded-3xl md:p-6"
      >
        <div className="mx-auto mb-3 h-1.5 w-10 rounded-full bg-slate-200 dark:bg-slate-700 md:hidden" />
        <div className="flex items-start gap-3">
          <span className="mt-0.5 grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-brand-400 to-brand-600 text-white shadow-md">
            <FiInbox className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <h2
              id="feedback-inbox-title"
              className="text-base font-semibold text-slate-900 dark:text-slate-100"
            >
              Feedback inbox
            </h2>
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              What readers have sent in
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="-m-1 grid h-8 w-8 shrink-0 place-items-center rounded-full text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700"
            aria-label="Close"
          >
            <FiX />
          </button>
        </div>
        {error ? (
          <div className="mt-4 rounded-xl bg-rose-100 px-3 py-2 text-xs text-rose-800 dark:bg-rose-900/40 dark:text-rose-100">
            {error}
          </div>
        ) : null}
        <div className="mt-4 min-h-0 flex-1 overflow-y-auto">
          {notes && notes.length > 0 ? (
            <ul className="flex flex-col gap-2">
              {notes.map((note) => (
                <li
                  key={note.id}
                  className="rounded-2xl border border-slate-200 bg-slate-50 p-3.5 dark:border-slate-700 dark:bg-slate-900"
                >
                  <p className="text-[11px] font-medium uppercase tracking-wide text-slate-400 dark:text-slate-500">
                    {formatSent(note.createdAt)}
                  </p>
                  <p className="mt-1.5 whitespace-pre-wrap break-words text-sm leading-relaxed text-slate-800 dark:text-slate-100">
                    {note.text}
                  </p>
                  <div className="mt-2 flex justify-end">
                    <button
                      type="button"
                      onClick={() => {
                        void deleteFeedback(note.id);
                      }}
                      className="inline-flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-200 dark:text-slate-300 dark:hover:bg-slate-700"
                    >
                      <FiTrash2 />
                      Delete
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="py-6 text-center text-sm text-slate-500 dark:text-slate-400">
              {notes === null ? "Loading…" : "Nothing yet."}
            </p>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
