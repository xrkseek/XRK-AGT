/**
 * 消息段工厂（多通道统一结构：image / at / reply / text …）
 * 全局裸名：msgSegment（由 bootstrap-globals 挂载）
 */
export const msgSegment = {
  custom(type: string, data: Record<string, unknown>) {
    return { type, ...data };
  },
  raw(data: unknown) {
    return { type: 'raw', data };
  },
  button(...data: unknown[]) {
    return { type: 'button', data };
  },
  markdown(data: unknown) {
    return { type: 'markdown', data };
  },
  image(file: unknown, name?: unknown) {
    return { type: 'image', file, name };
  },
  at(qq: unknown, name?: unknown) {
    return { type: 'at', qq, name };
  },
  record(file: unknown, name?: unknown) {
    return { type: 'record', file, name };
  },
  video(file: unknown, name?: unknown) {
    return { type: 'video', file, name };
  },
  file(file: unknown, name?: unknown) {
    return { type: 'file', file, name };
  },
  reply(id: unknown, text?: unknown, qq?: unknown, time?: unknown, seq?: unknown) {
    return { type: 'reply', id, text, qq, time, seq };
  },
  text(text: unknown) {
    return { type: 'text', text };
  },
  forward(id: unknown) {
    return { type: 'forward', id: String(id) };
  },
  node(data: unknown) {
    return { type: 'node', data };
  },
};
