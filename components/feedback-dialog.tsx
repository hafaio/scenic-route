"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FiCheck, FiMessageSquare, FiSend, FiX } from "react-icons/fi";
import { sendFeedback } from "../src/firebase";

interface FeedbackDialogProps {
  onClose: () => void;
}

// A half-typed complaint is not a preference, so it stays on the device that typed it rather than
// joining the synced settings document.
const DRAFT_KEY = "scenic-route:feedback-draft";

// What the security rule enforces, counted the way it counts: Firestore's string size() is UTF-8
// BYTES, where a JavaScript string's length is UTF-16 units. Measuring characters here would take a
// note of a thousand CJK characters — comfortably under any character count — and have the server
// refuse it.
const MAX_BYTES = 2000;
const COUNTER_FROM = 1800;

// A coarse guard on the textarea itself, in its own units. No note this long survives the byte cap,
// and it stops a paste of a whole document from being measured on every keystroke.
const MAX_CHARS = 2000;

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

function readDraft(): string {
  try {
    return window.localStorage.getItem(DRAFT_KEY) ?? "";
  } catch {
    return "";
  }
}

function writeDraft(text: string): void {
  try {
    if (text) {
      window.localStorage.setItem(DRAFT_KEY, text);
    } else {
      window.localStorage.removeItem(DRAFT_KEY);
    }
  } catch {}
}

export default function FeedbackDialog({ onClose }: FeedbackDialogProps) {
  const [text, setText] = useState<string>(readDraft);
  const used = byteLength(text);
  const [sent, setSent] = useState<"online" | "offline" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const openRef = useRef<boolean>(true);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  // Set on the way in as well as cleared on the way out: an effect that only clears stays cleared
  // through a remount, and then a refusal would land on a dialog it thinks is gone.
  useEffect(() => {
    openRef.current = true;
    return () => {
      openRef.current = false;
    };
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

  const handleChange = (next: string) => {
    setText(next);
    writeDraft(next);
  };

  // Never awaited. Offline the SDK queues the write in IndexedDB and sends it on the next launch, so
  // the only failure worth showing is a refusal, and that arrives long after the sender has moved on.
  const handleSend = () => {
    const note = text.trim();
    if (!note) {
      return;
    }
    sendFeedback(note).catch(() => {
      if (openRef.current) {
        setSent(null);
        setText(note);
        writeDraft(note);
        setError("Couldn't send. Your note is below — try again.");
      }
    });
    setError(null);
    setText("");
    writeDraft("");
    setSent(navigator.onLine ? "online" : "offline");
  };

  // Portalled to the body because the toolbar that opens this dialog sits in a z-indexed wrapper of
  // its own, and no z-index inside that stacking context clears the map furniture — on a phone the
  // layer legend lands on top of the buttons and eats the taps.
  return createPortal(
    <div className="fixed inset-0 z-[1100] flex items-end justify-center md:items-center">
      <button
        type="button"
        aria-label="Close feedback"
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-slate-950/40 backdrop-blur-sm"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="feedback-title"
        className="relative max-h-[90dvh] w-full overflow-y-auto rounded-t-3xl bg-white p-5 shadow-2xl ring-1 ring-black/5 dark:bg-slate-800 dark:ring-white/10 md:max-w-md md:rounded-3xl md:p-6"
      >
        <div className="mx-auto mb-3 h-1.5 w-10 rounded-full bg-slate-200 dark:bg-slate-700 md:hidden" />
        <div className="flex items-start gap-3">
          <span className="mt-0.5 grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-brand-400 to-brand-600 text-white shadow-md">
            <FiMessageSquare className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <h2
              id="feedback-title"
              className="text-base font-semibold text-slate-900 dark:text-slate-100"
            >
              Feedback
            </h2>
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              Goes straight to the maintainer
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
        {sent ? (
          <>
            <div className="mt-5 flex items-center gap-2.5 text-sm text-slate-700 dark:text-slate-200">
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">
                <FiCheck className="h-4 w-4" />
              </span>
              {sent === "online"
                ? "Sent — thank you."
                : "Saved — it will be sent next time you're online."}
            </div>
            {/* "Saved" is a promise the browser has to keep for us: the queue lives in IndexedDB,
                and where that is refused — private browsing, or a device out of room — Firestore
                falls back to a cache that goes when the tab does. Better to say so than to have the
                note quietly not arrive. */}
            {sent === "offline" ? (
              <p className="mt-2 pl-[2.625rem] text-xs text-slate-500 dark:text-slate-400">
                It waits in this browser, so if yours stores nothing between
                visits, keep the tab open until you are back online.
              </p>
            ) : null}
            <div className="mt-5 flex justify-end">
              <button
                type="button"
                onClick={onClose}
                className="inline-flex items-center gap-1.5 rounded-xl bg-gradient-to-br from-brand-500 to-brand-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:from-brand-600 hover:to-brand-700"
              >
                Done
              </button>
            </div>
          </>
        ) : (
          <>
            {error ? (
              <div className="mt-4 rounded-xl bg-rose-100 px-3 py-2 text-xs text-rose-800 dark:bg-rose-900/40 dark:text-rose-100">
                {error}
              </div>
            ) : null}
            <label className="mt-4 block">
              <span className="sr-only">Your feedback</span>
              <textarea
                ref={textareaRef}
                value={text}
                onChange={(event) => handleChange(event.target.value)}
                placeholder="What's broken, confusing, or missing?"
                rows={6}
                maxLength={MAX_CHARS}
                className="w-full resize-none rounded-2xl border border-slate-200 bg-slate-50 p-3.5 text-sm leading-relaxed text-slate-800 outline-none transition focus:border-brand-400 focus:bg-white focus:ring-2 focus:ring-brand-100 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:focus:border-brand-500 dark:focus:bg-slate-900 dark:focus:ring-brand-500/20"
              />
            </label>
            {used >= COUNTER_FROM ? (
              <p className="mt-1 text-right text-xs tabular-nums text-slate-400 dark:text-slate-500">
                {used.toLocaleString()} / {MAX_BYTES.toLocaleString()}
              </p>
            ) : null}
            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                className="rounded-xl px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-700"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSend}
                disabled={!text.trim() || used > MAX_BYTES}
                className="inline-flex items-center gap-1.5 rounded-xl bg-gradient-to-br from-brand-500 to-brand-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:from-brand-600 hover:to-brand-700 disabled:opacity-50"
              >
                <FiSend />
                Send
              </button>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
