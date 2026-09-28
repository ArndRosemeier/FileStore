/**
 * THE app's ONE error/notification surface (AGENTS.md, binding rule 2; ledger
 * row 9): the only place a failure becomes something the owner can see.
 *
 * TWO RULES MAKE IT WORTH HAVING, and both are pinned in `tests/lib/toast.test.ts`:
 *
 *  1. **A real error does NOT auto-dismiss.** Sonner's default is 4 s, which is
 *     long enough to miss and short enough to lose the evidence; a failure the
 *     owner must act on stays until he dismisses it ({@link ERROR_TOAST_DURATION_MS}).
 *  2. **A cancellation is NEVER a toast.** The two browser seams already answer a
 *     dismissed dialog with `{status:'cancelled'}` rather than throwing
 *     (`src/lib/saveFile.ts`, `src/lib/openFile.ts`), so the flows simply return
 *     and never call this module. A toast here would be the app arguing with the
 *     owner about his own decision.
 *
 * THE CREDENTIAL RULE APPLIES TO A TOAST AS MUCH AS TO A URL: a toast is rendered
 * text. `errorMessage` therefore strips the stored key out of whatever it is about
 * to show, as a LAST line of defence — the seams below already promise never to
 * format the key into a message, and this seam does not rely on that promise
 * holding forever, because the service's own `message` field is arbitrary text a
 * proxy could make echo the `Authorization` header back. Nothing is swallowed by
 * this: the message is still shown, with the credential replaced by `[redacted]`.
 *
 * WHAT IS DELIBERATELY NOT HERE: success/notice toasts carry no policy beyond
 * sonner's default; only the error path is opinionated.
 */

import { toast } from 'sonner';

import { ServerStoreError } from '@/server/store-errors';
import { readSettings } from '@/settings/settings';

/**
 * A real error stays until the owner dismisses it. `Infinity` is sonner's own
 * "never auto-close" value, stated once here rather than at each call site.
 */
export const ERROR_TOAST_DURATION_MS = Number.POSITIVE_INFINITY;

/** What a caller may say about the toast itself (never about its text). */
export interface ToastErrorOptions {
  /**
   * A stable id. Sonner REPLACES a toast carrying an id it already shows instead
   * of stacking a second copy — which is what keeps one failure from an effect
   * (React StrictMode mounts an effect twice in development) to ONE toast.
   */
  id?: string;
}

/** The stored key, read ONLY so it can be redacted — never to be rendered. */
function storedKey(): string {
  const read = readSettings();
  return read.status === 'ok' ? read.settings.key : '';
}

/**
 * Replace the stored credential with `[redacted]`, wherever it appears. An empty
 * key (the honest first-run state) redacts nothing, so no ordinary text is
 * mangled by an empty-pattern replace.
 */
export function redactCredential(text: string): string {
  const key = storedKey();
  if (key === '') return text;
  return text.split(key).join('[redacted]');
}

/** The human detail for a failure, without any context prefix. */
function failureDetail(error: unknown): string {
  if (error instanceof ServerStoreError) {
    const wait = error.retryAfterSeconds;
    if (error.code === 'rate_limited' && wait !== null) {
      // A 429 is REPORTED, with the wait (`src/server/store-client.ts` never
      // retries): the owner has to decide, and the wait is what he needs.
      return `${error.message} The service asks for a ${String(wait)}s wait; nothing was retried for you.`;
    }
    // `.message` names the code and the endpoint and carries the service's own
    // words verbatim (the client builds it that way). `.serverMessage` alone
    // would drop the code, and a code is the one stable thing to branch on.
    return error.message;
  }
  if (error instanceof Error) return error.message;
  return `The step failed with a value that is not an Error: ${String(error)}`;
}

/**
 * Compose the line for a failure. PURE: no storage, no rendering — so the
 * composition can be pinned without a browser, and {@link errorMessage} is the
 * only thing that knows a credential exists.
 */
export function errorText(error: unknown, context?: string): string {
  const prefix = context === undefined || context.trim() === '' ? '' : `${context.trim()}: `;
  return `${prefix}${failureDetail(error)}`;
}

/**
 * The exact text the owner sees, in a toast AND wherever the shell renders a
 * failure inline: `errorText` with the credential redacted. Returned as a string
 * so a component can render it and this module can toast it — ONE composition,
 * two surfaces.
 */
export function errorMessage(error: unknown, context?: string): string {
  return redactCredential(errorText(error, context));
}

/** Show a failure. It does not auto-dismiss; it is never called for a cancel. */
export function toastError(error: unknown, context?: string, options: ToastErrorOptions = {}): void {
  const id = options.id;
  toast.error(errorMessage(error, context), {
    duration: ERROR_TOAST_DURATION_MS,
    ...(id === undefined ? {} : { id }),
  });
}

/** Show that something worked. Sonner's own duration applies. */
export function toastSuccess(message: string): void {
  toast.success(message);
}
