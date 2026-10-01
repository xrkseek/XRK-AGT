/**
 * 轻量资源清理栈（interval / timeout / event listener）
 */

type DisposableFn = () => void;

type EventEmitterLike = {
  on: (event: string | symbol, listener: (...args: unknown[]) => void) => unknown;
  off: (event: string | symbol, listener: (...args: unknown[]) => void) => unknown;
};

export class Disposables {
  #stack: DisposableFn[] = [];

  add(disposeFn: unknown): void {
    if (typeof disposeFn !== 'function') return;
    this.#stack.push(disposeFn as DisposableFn);
  }

  interval(fn: (...args: unknown[]) => void, ms: number): ReturnType<typeof setInterval> {
    const id = setInterval(fn, ms);
    this.add(() => clearInterval(id));
    return id;
  }

  timeout(fn: (...args: unknown[]) => void, ms: number): ReturnType<typeof setTimeout> {
    const id = setTimeout(fn, ms);
    this.add(() => clearTimeout(id));
    return id;
  }

  on(
    emitter: EventEmitterLike | null | undefined,
    event: string | symbol,
    listener: (...args: unknown[]) => void,
  ): void {
    if (!emitter?.on || !emitter?.off) return;
    emitter.on(event, listener);
    this.add(() => {
      try {
        emitter.off(event, listener);
      } catch {
        /* ignore */
      }
    });
  }

  dispose(): void {
    const tasks = this.#stack.splice(0, this.#stack.length);
    for (let i = tasks.length - 1; i >= 0; i--) {
      try {
        tasks[i]!();
      } catch {
        /* ignore */
      }
    }
  }
}
