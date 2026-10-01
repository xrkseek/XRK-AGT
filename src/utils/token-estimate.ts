/**
 * Token 粗估（无 tokenizer 依赖）
 * `estimateTokensRough`：chars/4；`estimateTokensMixed`：中英/URL/hex 分权重。
 */

/** 粗估：约 4 字符 ≈ 1 token */
export function estimateTokensRough(text: unknown): number {
  const s = text == null ? '' : String(text);
  if (!s) return 0;
  return Math.ceil(s.length / 4);
}

/** 混合启发式：CJK / 英文词 / 标点 / URL / 长 hex 分别加权 */
export function estimateTokensMixed(text: unknown): number {
  if (text == null || typeof text !== 'string' || text.length === 0) return 0;

  let chinese = 0;
  let cjkOther = 0;
  let latinLetters = 0;
  let digits = 0;
  let punct = 0;
  let whitespace = 0;
  let other = 0;

  for (let i = 0; i < text.length; i++) {
    const cp = text.codePointAt(i)!;
    if (cp > 0xffff) i += 1;
    if (cp >= 0x4e00 && cp <= 0x9fff) chinese += 1;
    else if (
      (cp >= 0x3040 && cp <= 0x30ff)
      || (cp >= 0xac00 && cp <= 0xd7af)
    ) {
      cjkOther += 1;
    } else if ((cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a)) {
      latinLetters += 1;
    } else if (cp >= 0x30 && cp <= 0x39) digits += 1;
    else if (cp === 0x20 || cp === 0x09 || cp === 0x0a || cp === 0x0d) whitespace += 1;
    else if (
      (cp >= 0x21 && cp <= 0x2f)
      || (cp >= 0x3a && cp <= 0x40)
      || (cp >= 0x5b && cp <= 0x60)
      || (cp >= 0x7b && cp <= 0x7e)
      || cp === 0x3001
      || cp === 0x3002
      || cp === 0xff0c
      || cp === 0xff01
      || cp === 0xff1f
    ) {
      punct += 1;
    } else {
      other += 1;
    }
  }

  const englishWords = (text.match(/[a-zA-Z]+/g) || []).length;
  const identish = (text.match(/[A-Za-z][A-Za-z0-9_]{2,}/g) || []).length;
  const urls = text.match(/https?:\/\/\S+/gi) || [];
  let urlChars = 0;
  for (const u of urls) urlChars += u.length;
  const hexRuns = text.match(/\b[0-9a-fA-F]{16,}\b/g) || [];
  let hexChars = 0;
  for (const h of hexRuns) hexChars += h.length;

  const bodyChars = Math.max(0, text.length - urlChars - hexChars);
  const dense =
    chinese * 1.6
    + cjkOther * 1.5
    + englishWords * 1.25
    + identish * 0.15
    + digits * 0.35
    + punct * 0.4
    + whitespace * 0.15
    + other * 0.5
    + Math.max(0, latinLetters - englishWords) * 0.2;

  return Math.max(
    1,
    Math.ceil(dense + bodyChars * 0.12 + urlChars / 4 + hexChars / 3.5),
  );
}
