/**
 * Shared file-locking helpers for team storage.
 *
 * The teams feature coordinates multiple processes through mailbox, cursor,
 * event-log, and state files. All of those writers should share one locking
 * helper so stale-lock handling and retry behaviour stay consistent.
 */

import {
  lock as acquireLock,
  check as checkLock,
  type CheckOptions as ProperLockCheckOptions,
  type LockOptions as ProperLockOptions,
  type UnlockOptions as ProperUnlockOptions,
  unlock as releaseLock,
} from "proper-lockfile";

export const DEFAULT_LOCK_STALE_MS = 10_000;
export const DEFAULT_LOCK_UPDATE_MS = 5_000;
export const MINIMUM_LOCK_STALE_MS = 5_000;
export const MINIMUM_LOCK_UPDATE_MS = 1_000;
export const DEFAULT_MAILBOX_LOCK_ATTEMPTS = 5;
export const MAILBOX_LOCK_RETRY_DELAY_MS = 5_000;

export type SharedLockOptions = {
  staleMs?: number;
  updateMs?: number;
  retries?: ProperLockOptions["retries"];
  onCompromised?: ProperLockOptions["onCompromised"];
  lockfilePath?: string;
};

export type SharedCheckLockOptions = {
  staleMs?: number;
  lockfilePath?: string;
};

export class SharedLockError extends Error {
  readonly code:
    | "lock-acquire-failed"
    | "lock-release-failed"
    | "lock-check-failed"
    | "lock-force-release-failed";

  constructor(
    code: SharedLockError["code"],
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SharedLockError";
    this.code = code;
  }
}

/**
 * Acquire an exclusive lock for `path`, run `callback`, and always release.
 *
 * Stale locks are considered recoverable once `staleMs` has elapsed. Callers
 * can therefore rely on this helper to wait or reclaim a stale lock rather
 * than inventing their own lockfile policy.
 */
export async function withFileLock<T>(
  path: string,
  callback: () => Promise<T>,
  options: SharedLockOptions = {},
): Promise<T> {
  const release = await acquireFileLock(path, options);

  const outcome: { ok: true; value: T } | { ok: false; error: unknown } =
    await callback()
      .then((value) => ({ ok: true as const, value }))
      .catch((error: unknown) => ({ ok: false as const, error }));

  try {
    await release();
  } catch (err: unknown) {
    const releaseError = new SharedLockError(
      "lock-release-failed",
      `Failed to release lock for "${path}"`,
      { cause: err },
    );

    if (outcome.ok) {
      throw releaseError;
    }

    throw new AggregateError(
      [outcome.error, releaseError],
      `Operation failed and the lock for "${path}" could not be released`,
    );
  }

  if (outcome.ok) {
    return outcome.value;
  }

  throw outcome.error;
}

/** Acquire a lock and return the release function directly. */
export async function acquireFileLock(
  path: string,
  options: SharedLockOptions = {},
): Promise<() => Promise<void>> {
  try {
    return await acquireLock(path, toProperLockOptions(options));
  } catch (err: unknown) {
    throw new SharedLockError(
      "lock-acquire-failed",
      `Failed to acquire lock for "${path}"`,
      { cause: err },
    );
  }
}

/** Check whether a file is currently locked with the configured stale policy. */
export async function isFileLocked(
  path: string,
  options: SharedCheckLockOptions = {},
): Promise<boolean> {
  try {
    return await checkLock(path, toProperCheckOptions(options));
  } catch (err: unknown) {
    throw new SharedLockError(
      "lock-check-failed",
      `Failed to check lock state for "${path}"`,
      { cause: err },
    );
  }
}

/** Force-release a lock file when recovery logic has already decided it is safe. */
export async function forceReleaseFileLock(
  path: string,
  options: SharedCheckLockOptions = {},
): Promise<void> {
  const unlockOptions: ProperUnlockOptions = {
    realpath: false,
    lockfilePath: options.lockfilePath,
  };

  try {
    await releaseLock(path, unlockOptions);
  } catch (err: unknown) {
    throw new SharedLockError(
      "lock-force-release-failed",
      `Failed to force-release lock for "${path}"`,
      { cause: err },
    );
  }
}

/**
 * Mailbox reads retry every 5 seconds; the number of retry cycles is driven by
 * `PI_MAILBOX_LOCK_ATTEMPTS` and defaults to 5.
 */
export function mailboxLockOptions(
  env: NodeJS.ProcessEnv = process.env,
  overrides: Omit<SharedLockOptions, "retries"> = {},
): SharedLockOptions {
  return {
    ...overrides,
    retries: {
      retries: getMailboxLockAttempts(env),
      factor: 1,
      minTimeout: MAILBOX_LOCK_RETRY_DELAY_MS,
      maxTimeout: MAILBOX_LOCK_RETRY_DELAY_MS,
      randomize: false,
    },
  };
}

export function getMailboxLockAttempts(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const rawValue = env.PI_MAILBOX_LOCK_ATTEMPTS;
  if (rawValue === undefined) {
    return DEFAULT_MAILBOX_LOCK_ATTEMPTS;
  }

  const parsedValue = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsedValue) || parsedValue < 1) {
    return DEFAULT_MAILBOX_LOCK_ATTEMPTS;
  }

  return parsedValue;
}

function toProperLockOptions(options: SharedLockOptions): ProperLockOptions {
  const staleMs = normalizeStaleMs(options.staleMs);
  const updateMs = normalizeUpdateMs(options.updateMs, staleMs);

  return {
    stale: staleMs,
    update: updateMs,
    retries: options.retries ?? 0,
    realpath: false,
    onCompromised: options.onCompromised,
    lockfilePath: options.lockfilePath,
  };
}

function toProperCheckOptions(
  options: SharedCheckLockOptions,
): ProperLockCheckOptions {
  return {
    stale: normalizeStaleMs(options.staleMs),
    realpath: false,
    lockfilePath: options.lockfilePath,
  };
}

function normalizeStaleMs(staleMs: number | undefined): number {
  return Math.max(staleMs ?? DEFAULT_LOCK_STALE_MS, MINIMUM_LOCK_STALE_MS);
}

function normalizeUpdateMs(
  updateMs: number | undefined,
  staleMs: number,
): number {
  const boundedUpdateMs = Math.max(
    updateMs ?? DEFAULT_LOCK_UPDATE_MS,
    MINIMUM_LOCK_UPDATE_MS,
  );
  return Math.min(boundedUpdateMs, Math.floor(staleMs / 2));
}
