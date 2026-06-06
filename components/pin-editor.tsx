"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { FiCheck, FiCopy, FiMapPin, FiTrash2, FiX } from "react-icons/fi";
import type { Pin, PinDraft } from "../src/pin";
import { encodePlusCode } from "../src/plus-code";

interface PinEditorProps {
  target: Pin | PinDraft;
  mode: "create" | "edit";
  onSave: (text: string) => void | Promise<void>;
  onDelete?: () => void | Promise<void>;
  onCancel: () => void;
}

export default function PinEditor({
  target,
  mode,
  onSave,
  onDelete,
  onCancel,
}: PinEditorProps) {
  const [text, setText] = useState<string>(target.text);
  const [isBusy, setIsBusy] = useState<boolean>(false);
  const [copiedCode, setCopiedCode] = useState<boolean>(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const plusCode = useMemo(
    () => encodePlusCode(target.lat, target.lng),
    [target.lat, target.lng],
  );

  const handleCopyCode = async () => {
    try {
      await navigator.clipboard.writeText(plusCode);
      setCopiedCode(true);
      window.setTimeout(() => setCopiedCode(false), 1500);
    } catch {}
  };

  useEffect(() => {
    setText(target.text);
  }, [target]);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onCancel();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const handleBackdrop = () => {
    onCancel();
  };

  const handleSave = async () => {
    setIsBusy(true);
    try {
      await onSave(text);
    } finally {
      setIsBusy(false);
    }
  };

  const handleDelete = async () => {
    if (!onDelete) {
      return;
    }
    setIsBusy(true);
    try {
      await onDelete();
    } finally {
      setIsBusy(false);
    }
  };

  const eyebrow = mode === "create" ? "New pin" : "Edit pin";

  return (
    <div className="fixed inset-0 z-[1100] flex items-end justify-center md:items-center">
      <button
        type="button"
        aria-label="Close editor"
        onClick={handleBackdrop}
        className="absolute inset-0 cursor-default bg-slate-950/40 backdrop-blur-sm"
      />
      <div
        role="dialog"
        aria-modal="true"
        className="relative w-full max-h-[90dvh] overflow-y-auto rounded-t-3xl bg-white p-5 shadow-2xl ring-1 ring-black/5 dark:bg-slate-800 dark:ring-white/10 md:max-w-lg md:rounded-3xl md:p-6"
      >
        <div className="mx-auto mb-3 h-1.5 w-10 rounded-full bg-slate-200 dark:bg-slate-700 md:hidden" />
        <div className="flex items-start gap-3">
          <span className="mt-0.5 grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-brand-400 to-brand-600 text-white shadow-md">
            <FiMapPin className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-brand-600 dark:text-brand-400">
              {eyebrow}
            </p>
            <h2 className="mt-0.5 break-words text-base font-semibold text-slate-900 dark:text-slate-100">
              {target.address}
            </h2>
            <button
              type="button"
              onClick={handleCopyCode}
              title="Copy Plus Code — paste into Google or Apple Maps to find this spot"
              className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-brand-50 px-2.5 py-1 font-mono text-[11px] font-semibold tracking-wider text-brand-700 ring-1 ring-brand-100 transition hover:bg-brand-100 dark:bg-brand-500/10 dark:text-brand-400 dark:ring-brand-500/20 dark:hover:bg-brand-500/20"
            >
              <span>{plusCode}</span>
              {copiedCode ? (
                <FiCheck className="h-3 w-3" aria-label="Copied" />
              ) : (
                <FiCopy className="h-3 w-3" aria-hidden="true" />
              )}
              <span className="sr-only">Copy Plus Code</span>
            </button>
          </div>
          <button
            type="button"
            onClick={onCancel}
            disabled={isBusy}
            className="-m-1 grid h-8 w-8 place-items-center rounded-full text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700"
            aria-label="Close"
          >
            <FiX />
          </button>
        </div>
        <label className="mt-4 block">
          <span className="sr-only">Note</span>
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="Add a note about this place…"
            rows={5}
            className="w-full resize-none rounded-2xl border border-slate-200 bg-slate-50 p-3.5 text-sm leading-relaxed text-slate-800 outline-none transition focus:border-brand-400 focus:bg-white focus:ring-2 focus:ring-brand-100 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:focus:border-brand-500 dark:focus:bg-slate-900 dark:focus:ring-brand-500/20"
          />
        </label>
        <div className="mt-4 flex items-center justify-between gap-2">
          <div>
            {mode === "edit" && onDelete ? (
              <button
                type="button"
                onClick={handleDelete}
                disabled={isBusy}
                className="inline-flex items-center gap-1.5 rounded-xl px-3 py-2 text-sm font-medium text-rose-600 hover:bg-rose-50 disabled:opacity-50 dark:text-rose-400 dark:hover:bg-rose-900/30"
              >
                <FiTrash2 />
                Delete
              </button>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onCancel}
              disabled={isBusy}
              className="rounded-xl px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 disabled:opacity-50 dark:text-slate-300 dark:hover:bg-slate-700"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={isBusy}
              className="inline-flex items-center gap-1.5 rounded-xl bg-gradient-to-br from-brand-500 to-brand-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:from-brand-600 hover:to-brand-700 disabled:opacity-50"
            >
              <FiCheck />
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
