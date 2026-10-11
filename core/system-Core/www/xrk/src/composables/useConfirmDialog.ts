import { useDialog } from 'naive-ui';

/**
 * Naive UI 确认框（替代 window.confirm，避免浏览器原生弹窗）
 * @returns {{ confirm: (opts: { title?: string, content: string, positiveText?: string, negativeText?: string }) => Promise<boolean> }}
 */
export interface ConfirmOptions {
  title?: string;
  content: string;
  positiveText?: string;
  negativeText?: string;
}

export function useConfirmDialog() {
  const dialog = useDialog();

  function confirm({
    title = '确认',
    content,
    positiveText = '确定',
    negativeText = '取消',
  }: ConfirmOptions): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      dialog.warning({
        title,
        content: content || '',
        positiveText,
        negativeText,
        onPositiveClick: () => resolve(true),
        onNegativeClick: () => resolve(false),
        onClose: () => resolve(false),
      });
    });
  }

  return { confirm, dialog };
}
