"use client";

import { FirebaseError } from "firebase/app";
import { AuthErrorCodes } from "firebase/auth";
import { type FormEvent, useState } from "react";
import { FiLogIn } from "react-icons/fi";
import { sendPasswordReset, signIn } from "../src/firebase";

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

export default function Login() {
  const [email, setEmail] = useState<string>("");
  const [password, setPassword] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState<boolean>(false);
  const [isResetting, setIsResetting] = useState<boolean>(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setInfo(null);
    setIsBusy(true);
    try {
      await signIn(email, password);
    } catch (err) {
      setError(describeError(err));
    } finally {
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
      // Firebase doesn't reveal whether the email exists (to prevent
      // enumeration); show the same message either way.
      setInfo(`If an account exists for ${email}, a reset link is on its way.`);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setIsResetting(false);
    }
  };

  return (
    <main className="flex h-dvh w-full items-center justify-center p-6">
      <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-lg ring-1 ring-black/5 dark:bg-slate-800 dark:ring-white/10">
        <h1 className="text-lg font-semibold">Scenic Route</h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          Sign in to access the logger. Accounts are created by an admin.
        </p>
        <form onSubmit={submit} className="mt-4 flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-slate-600 dark:text-slate-300">Email</span>
            <input
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm outline-none focus:border-slate-400 dark:border-slate-700 dark:bg-slate-900 dark:focus:border-slate-500"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-slate-600 dark:text-slate-300">Password</span>
            <input
              type="password"
              required
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm outline-none focus:border-slate-400 dark:border-slate-700 dark:bg-slate-900 dark:focus:border-slate-500"
            />
          </label>
          {error ? (
            <div className="rounded-lg bg-rose-100 px-3 py-2 text-xs text-rose-800 dark:bg-rose-900/40 dark:text-rose-100">
              {error}
            </div>
          ) : null}
          {info ? (
            <div className="rounded-lg bg-emerald-100 px-3 py-2 text-xs text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-100">
              {info}
            </div>
          ) : null}
          <button
            type="submit"
            disabled={isBusy}
            className="mt-2 inline-flex items-center justify-center gap-2 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white"
          >
            <FiLogIn />
            Sign in
          </button>
        </form>
        <button
          type="button"
          onClick={handleReset}
          disabled={isResetting}
          className="mt-3 text-xs text-slate-500 underline-offset-2 hover:text-slate-700 hover:underline disabled:opacity-50 dark:text-slate-400 dark:hover:text-slate-200"
        >
          {isResetting ? "Sending reset link…" : "Forgot password?"}
        </button>
      </div>
    </main>
  );
}
