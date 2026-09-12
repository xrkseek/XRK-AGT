/** refLocator — role / aria / ax ref + frame scope */
import type { FrameLocator, Locator, Page } from 'playwright';
import { parseRoleRef } from './pw-role-snapshot.js';
import {
  AX_REF_PATTERN,
  BROWSER_REF_MARKER_ATTRIBUTE,
  ensurePageState,
  getPageState,
} from './pw-page-state.js';

type RoleScope = Pick<Page, 'locator' | 'getByRole'> | FrameLocator;

type PageLike = Pick<Page, 'frameLocator' | 'locator' | 'getByRole'>;

/**
 * @param page Playwright Page
 * @param ref 引用字符串
 */
export function refLocator(page: PageLike, ref: string): Locator {
  const normalized = ref.startsWith('@')
    ? ref.slice(1)
    : ref.startsWith('ref=')
      ? ref.slice(4)
      : ref;

  if (/^e\d+$/i.test(normalized)) {
    const state = getPageState(page as Page) ?? ensurePageState(page as Page);
    if (state.roleRefsMode === 'aria') {
      const scope: RoleScope = state.roleRefsFrameSelector
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
    const scope: RoleScope = state.roleRefsFrameSelector
      ? page.frameLocator(state.roleRefsFrameSelector)
      : page;
    const locator = info.name
      ? scope.getByRole(info.role as Parameters<Page['getByRole']>[0], {
          name: info.name,
          exact: true,
        })
      : scope.getByRole(info.role as Parameters<Page['getByRole']>[0]);
    return info.nth !== undefined ? locator.nth(info.nth) : locator;
  }

  if (AX_REF_PATTERN.test(normalized)) {
    const state = getPageState(page as Page) ?? ensurePageState(page as Page);
    const info = state.roleRefs?.[normalized];
    if (!info) {
      throw new Error(
        `Unknown ref "${normalized}". Run a new snapshot and use a ref from that snapshot.`,
      );
    }
    const scope: RoleScope = state.roleRefsFrameSelector
      ? page.frameLocator(state.roleRefsFrameSelector)
      : page;
    if (info.domMarker) {
      return scope.locator(`[${BROWSER_REF_MARKER_ATTRIBUTE}="${normalized}"]`);
    }
    const locator = info.name
      ? scope.getByRole(info.role as Parameters<Page['getByRole']>[0], {
          name: info.name,
          exact: true,
        })
      : scope.getByRole(info.role as Parameters<Page['getByRole']>[0]);
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
): { kind: string; ref?: string; selector?: string; locator: Locator } {
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
