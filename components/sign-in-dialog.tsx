"use client";

import { FirebaseError } from "firebase/app";
import { AuthErrorCodes } from "firebase/auth";
import { type FormEvent, useEffect, useState } from "react";
import { FiLogIn, FiMapPin, FiX } from "react-icons/fi";
import { sendPasswordReset, signIn } from "../src/firebase";

interface SignInDialogProps {
  onClose: () => void;
}

function describeError(err: unknown): string {
  if (!(err instanceof FirebaseError)) {
    return err instanceof Error ? err.message : "Something went wrong.";
  }
  switch (err.code) {
    case AuthErrorCodes.INVALID_PASSWORD:
    case AuthErrorCodes.USER_DELETED:
    case "auth/invalid-credential":
      return "Invalid email or password.";
    case AuthErrorCodes.INVALID_EMAIL:
      return "That doesn't look like a valid email.";
    case AuthErrorCodes.TOO_MANY_ATTEMPTS_TRY_LATER:
      return "Too many attempts. Try again in a minute.";
    case AuthErrorCodes.NETWORK_REQUEST_FAILED:
      return "Network error. Check your connection.";
    case "auth/missing-email":
      return "Enter your email first.";
    default:
      return err.message;
  }
}

export default function SignInDialog({ onClose }: SignInDialogProps) {
  const [email, setEmail] = useState<string>("");
  const [password, setPassword] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState<boolean>(false);
  const [isResetting, setIsResetting] = useState<boolean>(false);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setInfo(null);
    setIsBusy(true);
    try {
      await signIn(email, password);
      onClose();
    } catch (err) {
      setError(describeError(err));
      setIsBusy(false);
    }
  };

  const handleReset = async () => {
    setError(null);
    setInfo(null);
    if (!email) {
      setError("Enter your email first, then tap reset.");
      return;
    }
    setIsResetting(true);
    try {
      await sendPasswordReset(email);
      // firebase hides whether the email exists (anti-enumeration); show the same message either way
      setInfo(`If an account exists for ${email}, a reset link is on its way.`);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setIsResetting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[1100] flex items-end justify-center md:items-center">
      <button
        type="button"
        aria-label="Close sign in"
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-slate-950/40 backdrop-blur-sm"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="sign-in-title"
        className="relative max-h-[90dvh] w-full overflow-y-auto rounded-t-3xl bg-white p-6 shadow-2xl ring-1 ring-black/5 dark:bg-slate-800 dark:ring-white/10 md:max-w-sm md:rounded-3xl md:p-7"
      >
        <div className="mx-auto mb-3 h-1.5 w-10 rounded-full bg-slate-200 dark:bg-slate-700 md:hidden" />
        <div className="flex items-start gap-3">
          <span className="scenic-logo-pin grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-brand-400 to-brand-600 text-white shadow-lg">
            <FiMapPin className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <h2
              id="sign-in-title"
              className="text-lg font-semibold tracking-tight"
            >
              Scenic Route
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Sign in to drop and edit pins
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={isBusy}
            className="-m-1 grid h-8 w-8 shrink-0 place-items-center rounded-full text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700"
            aria-label="Close"
          >
            <FiX />
          </button>
        </div>
        <form onSubmit={submit} className="mt-6 flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-slate-600 dark:text-slate-300">
              Email
            </span>
            <input
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm outline-none transition focus:border-brand-400 focus:bg-white focus:ring-2 focus:ring-brand-100 dark:border-slate-700 dark:bg-slate-900 dark:focus:border-brand-500 dark:focus:bg-slate-900 dark:focus:ring-brand-500/20"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-slate-600 dark:text-slate-300">
              Password
            </span>
            <input
              type="password"
              required
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm outline-none transition focus:border-brand-400 focus:bg-white focus:ring-2 focus:ring-brand-100 dark:border-slate-700 dark:bg-slate-900 dark:focus:border-brand-500 dark:focus:bg-slate-900 dark:focus:ring-brand-500/20"
            />
          </label>
          {error ? (
            <div className="rounded-xl bg-rose-100 px-3 py-2 text-xs text-rose-800 dark:bg-rose-900/40 dark:text-rose-100">
              {error}
            </div>
          ) : null}
          {info ? (
            <div className="rounded-xl bg-emerald-100 px-3 py-2 text-xs text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-100">
              {info}
            </div>
          ) : null}
          <button
            type="submit"
            disabled={isBusy}
            className="mt-2 inline-flex items-center justify-center gap-2 rounded-xl bg-gradient-to-br from-brand-500 to-brand-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:from-brand-600 hover:to-brand-700 disabled:opacity-50"
          >
            <FiLogIn />
            Sign in
          </button>
        </form>
        <button
          type="button"
          onClick={handleReset}
          disabled={isResetting}
          className="mt-4 text-xs text-slate-500 underline-offset-2 hover:text-brand-600 hover:underline disabled:opacity-50 dark:text-slate-400 dark:hover:text-brand-400"
        >
          {isResetting ? "Sending reset link…" : "Forgot password?"}
        </button>
        <p className="mt-4 text-[11px] text-slate-400 dark:text-slate-500">
          Accounts are created by an admin.
        </p>
      </div>
    </div>
  );
}
