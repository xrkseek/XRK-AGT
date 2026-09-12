/**
 * Playwright PageState — role refs、console、network、dialog
 */
import type { ConsoleMessage, Dialog, Page, Request, Response } from 'playwright';

export const BROWSER_REF_MARKER_ATTRIBUTE = 'data-xrk-browser-ref';
export const AX_REF_PATTERN = /^ax\d+$/i;

const MAX_CONSOLE = 500;
const MAX_ERRORS = 200;
const MAX_NETWORK = 500;
const MAX_RECENT_DIALOGS = 20;
const OBSERVED_DIALOG_TIMEOUT_MS = 120_000;

export type RoleRefInfo = {
  role: string;
  name?: string;
  nth?: number;
  domMarker?: boolean;
};

export type ObservedDialogRecord = {
  id: string;
  type: string;
  message: string;
  defaultValue?: string;
  openedAt: string;
  closedAt?: string;
  closedBy?: string;
};

export type PendingObservedDialog = {
  id: string;
  type: string;
  message: string;
  defaultValue?: string;
  openedAt: string;
  dialog: Dialog;
};

export type NetworkRequestRecord = {
  id: string;
  timestamp: string;
  method: string;
  url: string;
  resourceType: string;
  status?: number;
  ok?: boolean;
  failureText?: string;
};

export type ConsoleRecord = {
  type: string;
  text: string;
  timestamp: string;
  location: ReturnType<ConsoleMessage['location']>;
};

export type PageErrorRecord = {
  message: string;
  name?: string;
  stack?: string;
  timestamp: string;
};

export type ArmedDialogResponse = {
  accept: boolean;
  promptText?: string;
  expiresAt: number;
  timer?: ReturnType<typeof setTimeout>;
};

export type ObservedBrowserState = {
  dialogs: {
    pending: Array<{
      id: string;
      type: string;
      message: string;
      defaultValue?: string;
      openedAt: string;
    }>;
    recent: ObservedDialogRecord[];
  };
};

export type PageState = {
  console: ConsoleRecord[];
  errors: PageErrorRecord[];
  requests: NetworkRequestRecord[];
  requestIds: WeakMap<Request, string>;
  nextRequestId: number;
  nextObservedDialogId: number;
  pendingDialogs: PendingObservedDialog[];
  recentDialogs: ObservedDialogRecord[];
  armedDialogResponse?: ArmedDialogResponse;
  dialogAbortControllers: Set<AbortController>;
  roleRefs?: Record<string, RoleRefInfo>;
  roleRefsMode?: 'role' | 'aria' | string;
  roleRefsFrameSelector?: string;
};

const pageStates = new WeakMap<Page, PageState>();
const observedPages = new WeakSet<Page>();

export class BrowserObservedDialogBlockedError extends Error {
  browserState: ObservedBrowserState;

  constructor(browserState: ObservedBrowserState) {
    super('Browser action blocked by a modal dialog.');
    this.name = 'BrowserObservedDialogBlockedError';
    this.browserState = browserState;
  }
}

export function isBrowserObservedDialogBlockedError(
  err: unknown,
): err is BrowserObservedDialogBlockedError {
  return err instanceof BrowserObservedDialogBlockedError;
}

function serializeObservedBrowserState(state: PageState): ObservedBrowserState {
  return {
    dialogs: {
      pending: state.pendingDialogs.map((d) => ({
        id: d.id,
        type: d.type,
        message: d.message,
        defaultValue: d.defaultValue,
        openedAt: d.openedAt,
      })),
      recent: state.recentDialogs,
    },
  };
}

function appendRecentDialog(state: PageState, record: ObservedDialogRecord) {
  state.recentDialogs.push(record);
  while (state.recentDialogs.length > MAX_RECENT_DIALOGS) state.recentDialogs.shift();
}

function abortActionsBlockedByDialog(state: PageState) {
  if (!state.dialogAbortControllers.size) return;
  const err = new BrowserObservedDialogBlockedError(serializeObservedBrowserState(state));
  for (const controller of state.dialogAbortControllers) {
    if (!controller.signal.aborted) controller.abort(err);
  }
  state.dialogAbortControllers.clear();
}

async function settleObservedDialog(params: {
  state: PageState;
  pending: PendingObservedDialog;
  accept: boolean;
  promptText?: string;
  closedBy: string;
}): Promise<ObservedDialogRecord> {
  const { state, pending, accept, promptText } = params;
  let closedBy = params.closedBy;
  state.pendingDialogs = state.pendingDialogs.filter((d) => d.id !== pending.id);
  try {
    if (accept) await pending.dialog.accept(promptText);
    else await pending.dialog.dismiss();
  } catch (err: unknown) {
    const msg = Error.isError(err) ? err.message : String(err);
    if (!msg.toLowerCase().includes('no dialog is showing')) {
      if (closedBy === 'agent') state.pendingDialogs.push(pending);
      throw err;
    }
    closedBy = 'remote';
  }
  const record: ObservedDialogRecord = {
    id: pending.id,
    type: pending.type,
    message: pending.message,
    defaultValue: pending.defaultValue,
    openedAt: pending.openedAt,
    closedAt: new Date().toISOString(),
    closedBy,
  };
  appendRecentDialog(state, record);
  return record;
}

function observeDialog(state: PageState, dialog: Dialog) {
  state.nextObservedDialogId += 1;
  const type = dialog.type();
  const pending: PendingObservedDialog = {
    id: `d${state.nextObservedDialogId}`,
    type,
    message: dialog.message(),
    openedAt: new Date().toISOString(),
    dialog,
    ...(type === 'prompt' ? { defaultValue: dialog.defaultValue() } : {}),
  };
  state.pendingDialogs.push(pending);

  const armed = state.armedDialogResponse;
  if (armed && armed.expiresAt > Date.now()) {
    state.armedDialogResponse = undefined;
    if (armed.timer) clearTimeout(armed.timer);
    void settleObservedDialog({
      state,
      pending,
      accept: armed.accept,
      promptText: armed.promptText,
      closedBy: 'armed',
    }).catch(() => {});
    return;
  }
  if (armed) {
    if (armed.timer) clearTimeout(armed.timer);
    state.armedDialogResponse = undefined;
  }
  abortActionsBlockedByDialog(state);
}

export function ensurePageState(page: Page): PageState {
  const existing = pageStates.get(page);
  if (existing) return existing;

  const state: PageState = {
    console: [],
    errors: [],
    requests: [],
    requestIds: new WeakMap(),
    nextRequestId: 0,
    nextObservedDialogId: 0,
    pendingDialogs: [],
    recentDialogs: [],
    armedDialogResponse: undefined,
    dialogAbortControllers: new Set(),
    roleRefs: undefined,
    roleRefsMode: undefined,
    roleRefsFrameSelector: undefined,
  };
  pageStates.set(page, state);

  if (!observedPages.has(page)) {
    observedPages.add(page);
    page.on('console', (msg: ConsoleMessage) => {
      state.console.push({
        type: msg.type(),
        text: msg.text(),
        timestamp: new Date().toISOString(),
        location: msg.location(),
      });
      if (state.console.length > MAX_CONSOLE) state.console.shift();
    });
    page.on('pageerror', (err: Error) => {
      state.errors.push({
        message: err.message || String(err),
        name: err.name,
        stack: err.stack,
        timestamp: new Date().toISOString(),
      });
      if (state.errors.length > MAX_ERRORS) state.errors.shift();
    });
    page.on('request', (req: Request) => {
      state.nextRequestId += 1;
      const id = `r${state.nextRequestId}`;
      state.requestIds.set(req, id);
      state.requests.push({
        id,
        timestamp: new Date().toISOString(),
        method: req.method(),
        url: req.url(),
        resourceType: req.resourceType(),
      });
      if (state.requests.length > MAX_NETWORK) state.requests.shift();
    });
    page.on('response', (resp: Response) => {
      const id = state.requestIds.get(resp.request());
      if (!id) return;
      const rec = state.requests.find((r) => r.id === id);
      if (rec) {
        rec.status = resp.status();
        rec.ok = resp.ok();
      }
    });
    page.on('requestfailed', (req: Request) => {
      const id = state.requestIds.get(req);
      if (!id) return;
      const rec = state.requests.find((r) => r.id === id);
      if (rec) {
        rec.failureText = req.failure()?.errorText;
        rec.ok = false;
      }
    });
    page.on('dialog', (dialog: Dialog) => observeDialog(state, dialog));
    page.on('close', () => {
      if (state.armedDialogResponse?.timer) clearTimeout(state.armedDialogResponse.timer);
      state.armedDialogResponse = undefined;
      for (const c of state.dialogAbortControllers) {
        if (!c.signal.aborted) c.abort(new Error('Page closed before browser action completed.'));
      }
      state.dialogAbortControllers.clear();
      state.pendingDialogs = [];
      pageStates.delete(page);
      observedPages.delete(page);
    });
  }
  return state;
}

export function getPageState(page: Page): PageState | null {
  return pageStates.get(page) ?? null;
}

export function storeRoleRefsOnPage(
  page: Page,
  params: {
    refs: Record<string, RoleRefInfo>;
    mode?: 'role' | 'aria' | string;
    frameSelector?: string;
  },
): void {
  const { refs, mode = 'role', frameSelector } = params;
  const state = ensurePageState(page);
  state.roleRefs = refs;
  state.roleRefsMode = mode;
  state.roleRefsFrameSelector = frameSelector;
}

export function getObservedBrowserStateForPage(page: Page): ObservedBrowserState {
  return serializeObservedBrowserState(ensurePageState(page));
}

export function createObservedDialogAbortSignalForPage(
  page: Page,
  parentSignal?: AbortSignal,
): { signal: AbortSignal; cleanup: () => void } {
  const state = ensurePageState(page);
  const controller = new AbortController();
  const abortForDialog = () => {
    if (!controller.signal.aborted) {
      controller.abort(new BrowserObservedDialogBlockedError(serializeObservedBrowserState(state)));
    }
  };
  const abortForParent = () => {
    if (!controller.signal.aborted) {
      controller.abort(parentSignal?.reason ?? new Error('aborted'));
    }
  };
  if (state.pendingDialogs.length > 0) abortForDialog();
  else state.dialogAbortControllers.add(controller);
  if (parentSignal) {
    if (parentSignal.aborted) abortForParent();
    else parentSignal.addEventListener('abort', abortForParent, { once: true });
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      state.dialogAbortControllers.delete(controller);
      parentSignal?.removeEventListener('abort', abortForParent);
    },
  };
}

export function armObservedDialogResponseOnPage(
  page: Page,
  opts: { accept: boolean; promptText?: string; timeoutMs?: number },
): void {
  const { accept, promptText, timeoutMs } = opts;
  const state = ensurePageState(page);
  if (state.armedDialogResponse?.timer) clearTimeout(state.armedDialogResponse.timer);
  const ms = Math.max(1, Math.floor(Number(timeoutMs) || OBSERVED_DIALOG_TIMEOUT_MS));
  const expiresAt = Date.now() + ms;
  const response: ArmedDialogResponse = { accept, promptText, expiresAt };
  response.timer = setTimeout(() => {
    if (state.armedDialogResponse === response) state.armedDialogResponse = undefined;
  }, ms);
  state.armedDialogResponse = response;
}

export async function respondToObservedDialogOnPage(
  page: Page,
  opts: { dialogId?: string; accept: boolean; promptText?: string },
): Promise<ObservedDialogRecord> {
  const { dialogId, accept, promptText } = opts;
  const state = ensurePageState(page);
  let pending: PendingObservedDialog | undefined;
  if (dialogId) {
    pending = state.pendingDialogs.find((d) => d.id === dialogId);
    if (!pending) throw new Error(`Dialog "${dialogId}" is not pending.`);
  } else if (state.pendingDialogs.length === 1) {
    pending = state.pendingDialogs[0];
  } else if (state.pendingDialogs.length > 1) {
    throw new Error('Multiple dialogs are pending; pass dialogId.');
  } else {
    throw new Error('No dialog is pending.');
  }
  return settleObservedDialog({ state, pending: pending!, accept, promptText, closedBy: 'agent' });
}
