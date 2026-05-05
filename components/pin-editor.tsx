"use client";

import { useEffect, useRef, useState } from "react";
import { FiCheck, FiTrash2, FiX } from "react-icons/fi";
import type { Pin, PinDraft } from "../src/pin";

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
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

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

  return (
    <div className="fixed inset-0 z-[1100] flex items-end justify-center md:items-center">
      <button
        type="button"
        aria-label="Close editor"
        onClick={handleBackdrop}
        className="absolute inset-0 cursor-default bg-black/40"
      />
      <div
        role="dialog"
        aria-modal="true"
        className="relative w-full max-h-[90dvh] overflow-y-auto rounded-t-2xl bg-white p-4 shadow-2xl dark:bg-slate-800 md:max-w-lg md:rounded-2xl"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="break-words text-base font-semibold text-slate-900 dark:text-slate-100">
              {target.address}
            </h2>
            <p className="mt-1 text-xs text-slate-400 dark:text-slate-500">
              {target.lat.toFixed(5)}, {target.lng.toFixed(5)}
            </p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            disabled={isBusy}
            className="-m-1 rounded-full p-1 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700"
            aria-label="Close"
          >
            <FiX />
          </button>
        </div>
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="Add a note about this place…"
          rows={4}
          className="mt-3 w-full resize-none rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm outline-none focus:border-slate-400 dark:border-slate-700 dark:bg-slate-900 dark:focus:border-slate-500"
        />
        <div className="mt-3 flex items-center justify-between gap-2">
          <div>
            {mode === "edit" && onDelete ? (
              <button
                type="button"
                onClick={handleDelete}
                disabled={isBusy}
                className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium text-rose-600 hover:bg-rose-50 disabled:opacity-50 dark:text-rose-400 dark:hover:bg-rose-900/30"
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
              className="rounded-lg px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 disabled:opacity-50 dark:text-slate-300 dark:hover:bg-slate-700"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={isBusy}
              className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white"
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
