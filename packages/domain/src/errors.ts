export type AppErrorCode =
  | 'INVALID_INPUT'
  | 'UNSUPPORTED_TARGET'
  | 'CONFLICT'
  | 'WORKSPACE_ADMISSION_STALE'
  | 'WORKSPACE_NOT_FOUND'
  | 'PATH_OUTSIDE_WORKSPACE'
  | 'SECRET_ACCESS_DENIED'
  | 'PERMISSION_DENIED'
  | 'PERMISSION_REQUIRED'
  | 'FILE_NOT_FOUND'
  | 'FILE_TOO_LARGE'
  | 'BINARY_FILE'
  | 'PROCESS_NOT_FOUND'
  | 'PROCESS_TIMEOUT'
  | 'RESOURCE_PRESSURE'
  | 'EXECUTABLE_NOT_FOUND'
  | 'GIT_NOT_REPOSITORY'
  | 'CODEX_NOT_AVAILABLE'
  | 'UNSUPPORTED_PLATFORM'
  | 'INTERNAL_ERROR';

export interface AppError {
  readonly code: AppErrorCode;
  readonly message: string;
  readonly recoverable: boolean;
  readonly details?: Readonly<Record<string, string | number>>;
}

/**
 * Runtime companion to `AppErrorCode`.
 *
 * Keyed by the union, so adding a code fails the build until it is listed here.
 * `Object.hasOwn` rather than a truthiness check keeps prototype names
 * (`constructor`, `toString`) from validating as error codes.
 */
const APP_ERROR_CODES: Readonly<Record<AppErrorCode, true>> = {
  INVALID_INPUT: true,
  UNSUPPORTED_TARGET: true,
  CONFLICT: true,
  WORKSPACE_ADMISSION_STALE: true,
  WORKSPACE_NOT_FOUND: true,
  PATH_OUTSIDE_WORKSPACE: true,
  SECRET_ACCESS_DENIED: true,
  PERMISSION_DENIED: true,
  PERMISSION_REQUIRED: true,
  FILE_NOT_FOUND: true,
  FILE_TOO_LARGE: true,
  BINARY_FILE: true,
  PROCESS_NOT_FOUND: true,
  PROCESS_TIMEOUT: true,
  RESOURCE_PRESSURE: true,
  EXECUTABLE_NOT_FOUND: true,
  GIT_NOT_REPOSITORY: true,
  CODEX_NOT_AVAILABLE: true,
  UNSUPPORTED_PLATFORM: true,
  INTERNAL_ERROR: true,
};

export function isAppErrorCode(value: unknown): value is AppErrorCode {
  return typeof value === 'string' && Object.hasOwn(APP_ERROR_CODES, value);
}

export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: AppError };

export function appError(
  code: AppErrorCode,
  message: string,
  recoverable = false,
  details?: Readonly<Record<string, string | number>>,
): AppError {
  return { code, message, recoverable, ...(details === undefined ? {} : { details }) };
}

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function err<T = never>(error: AppError): Result<T> {
  return { ok: false, error };
}
