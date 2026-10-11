/**
 * 聊天滚动：进会话贴底（对齐 QQ/微信），不记忆中间位置。
 * 用户上翻阅读时暂停自动贴底；回到底部附近再恢复。
 */

const NEAR_PX = 72;

export function isNearBottom(box: HTMLElement | null | undefined, px = NEAR_PX): boolean {
  if (!box) return true;
  return box.scrollHeight - box.scrollTop - box.clientHeight <= px;
}

/** 立刻滚到底；双 rAF 覆盖布局未定 / 气泡刚插入 */
export function scrollChatToBottom(box: HTMLElement | null | undefined): void {
  if (!box) return;
  const run = () => {
    box.scrollTop = box.scrollHeight;
  };
  box.style.scrollBehavior = 'auto';
  run();
  requestAnimationFrame(() => {
    run();
    requestAnimationFrame(() => {
      run();
      box.style.removeProperty('scroll-behavior');
    });
  });
}

/** 清掉旧版 chatScroll_*，避免刷新后误恢复到半腰 */
export function clearStoredChatScroll(mode?: string): void {
  const modes: string[] = mode ? [mode] : ['event', 'ai', 'voice'];
  for (const m of modes) {
    try {
      localStorage.removeItem(`chatScroll_${m}`);
    } catch {
      /* ignore */
    }
  }
}

/** @deprecated 已改为始终贴底，保留空实现以免外部引用报错 */
export function readStoredChatScroll(): null {
  return null;
}

/** @deprecated */
export function persistChatScroll(): void {}

/** @deprecated */
export function applyChatScroll(box: HTMLElement | null | undefined, savedTop?: number | null): void {
  if (typeof savedTop === 'number' && box) {
    const max = Math.max(0, box.scrollHeight - box.clientHeight);
    box.scrollTop = Math.min(savedTop, max);
    return;
  }
  scrollChatToBottom(box);
}
