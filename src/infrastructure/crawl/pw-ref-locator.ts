/** refLocator 移植 — role / aria / ax ref + frame scope */
import { parseRoleRef } from './pw-role-snapshot.js';
import {
  AX_REF_PATTERN,
  BROWSER_REF_MARKER_ATTRIBUTE,
  ensurePageState,
  getPageState,
} from './pw-page-state.js';

type PageLike = {
  frameLocator: (selector: string) => any;
  locator: (selector: string) => any;
  getByRole: (role: any, options?: { name?: string; exact?: boolean }) => any;
};

/**
 * @param page Playwright Page
 * @param ref 引用字符串
 */
export function refLocator(page: PageLike, ref: string): any {
  const normalized = ref.startsWith('@')
    ? ref.slice(1)
    : ref.startsWith('ref=')
      ? ref.slice(4)
      : ref;

  if (/^e\d+$/i.test(normalized)) {
    const state: any = getPageState(page as any) ?? ensurePageState(page as any);
    if (state.roleRefsMode === 'aria') {
      const scope = state.roleRefsFrameSelector
        ? page.frameLocator(state.roleRefsFrameSelector)
        : page;
      return scope.locator(`aria-ref=${normalized}`);
    }
    const info = state.roleRefs?.[normalized];
    if (!info) {
      throw new Error(
        `Unknown ref "${normalized}". Run a new snapshot and use a ref from that snapshot.`,
      );
    }
    const scope = state.roleRefsFrameSelector
      ? page.frameLocator(state.roleRefsFrameSelector)
      : page;
    const locator = info.name
      ? scope.getByRole(info.role, { name: info.name, exact: true })
      : scope.getByRole(info.role);
    return info.nth !== undefined ? locator.nth(info.nth) : locator;
  }

  if (AX_REF_PATTERN.test(normalized)) {
    const state: any = getPageState(page as any) ?? ensurePageState(page as any);
    const info = state.roleRefs?.[normalized];
    if (!info) {
      throw new Error(
        `Unknown ref "${normalized}". Run a new snapshot and use a ref from that snapshot.`,
      );
    }
    const scope = state.roleRefsFrameSelector
      ? page.frameLocator(state.roleRefsFrameSelector)
      : page;
    if (info.domMarker) {
      return scope.locator(`[${BROWSER_REF_MARKER_ATTRIBUTE}="${normalized}"]`);
    }
    const locator = info.name
      ? scope.getByRole(info.role, { name: info.name, exact: true })
      : scope.getByRole(info.role);
    return info.nth !== undefined ? locator.nth(info.nth) : locator;
  }

  return page.locator(`aria-ref=${normalized}`);
}

/**
 * @param target ref 或 selector
 * @param page Playwright Page
 */
export function resolveInteractionTarget(
  target: { ref?: string; selector?: string },
  page: PageLike,
): { kind: string; ref?: string; selector?: string; locator: any } {
  const refRaw = typeof target.ref === 'string' ? target.ref.trim() : '';
  if (refRaw) {
    const parsed = parseRoleRef(refRaw);
    if (!parsed) throw new Error(`Invalid ref: ${refRaw}`);
    return { kind: 'ref', ref: parsed, locator: refLocator(page, parsed) };
  }
  const selector = typeof target.selector === 'string' ? target.selector.trim() : '';
  if (selector) {
    return { kind: 'selector', selector, locator: page.locator(selector).first() };
  }
  throw new Error('ref 或 selector 必填其一');
}
