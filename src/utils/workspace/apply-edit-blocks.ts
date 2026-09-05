// @ts-nocheck
/**
 * aider editblock 可移植核：解析并应用 SEARCH/REPLACE 围栏。
 * 供 `tools.apply_edit` 使用；路径相对工作区根解析。
 *
 * 块格式（可多个连续）：
 *   path/to/file.ext
 *   <<<<<<< SEARCH
 *   ...old...
 *   =======
 *   ...new...
 *   >>>>>>> REPLACE
 *
 * dryRun=true 时只校验匹配、不写盘。
 */
import fs from 'node:fs/promises';
import path from 'node:path';

const BLOCK_RE =
  /(?:^|\n)([^\n]+?)\n<<<<<<< SEARCH\n([\s\S]*?)\n=======\n([\s\S]*?)\n>>>>>>> REPLACE/g;

/**
 * @param {string} patchText
 * @returns {Array<{ filePath: string, oldText: string, newText: string }>}
 */
export function parseSearchReplaceBlocks(patchText) {
  const text = String(patchText || '');
  const out = [];
  BLOCK_RE.lastIndex = 0;
  let m;
  while ((m = BLOCK_RE.exec(text)) !== null) {
    const filePath = String(m[1] || '').trim();
    if (!filePath || filePath.startsWith('<<<<<<<')) continue;
    out.push({
      filePath,
      oldText: m[2],
      newText: m[3]
    });
  }
  return out;
}

/**
 * @param {string} content
 * @param {string} oldText
 * @param {string} newText
 */
function replaceOnce(content, oldText, newText) {
  if (oldText === '') {
    // 空 SEARCH = 新建/整文件写入（调用方处理不存在文件）
    return { ok: true, content: newText, mode: 'whole' };
  }
  const idx = content.indexOf(oldText);
  if (idx === -1) {
    // 宽松：去尾空白再试
    const softOld = oldText.replace(/\r\n/g, '\n').trimEnd();
    const softContent = content.replace(/\r\n/g, '\n');
    const i2 = softContent.indexOf(softOld);
    if (i2 === -1) return { ok: false, content, mode: 'miss' };
    const softNew = newText.replace(/\r\n/g, '\n');
    return {
      ok: true,
      content: softContent.slice(0, i2) + softNew + softContent.slice(i2 + softOld.length),
      mode: 'soft'
    };
  }
  if (content.indexOf(oldText, idx + oldText.length) !== -1) {
    return { ok: false, content, mode: 'ambiguous' };
  }
  return {
    ok: true,
    content: content.slice(0, idx) + newText + content.slice(idx + oldText.length),
    mode: 'exact'
  };
}

/**
 * @param {string} workspace
 * @param {string} patchText
 * @param {{ dryRun?: boolean }} [opts]
 */
export async function applyEditBlocks(workspace, patchText, opts = {}) {
  const root = path.resolve(workspace || process.cwd());
  const blocks = parseSearchReplaceBlocks(patchText);
  if (!blocks.length) {
    return { success: false, error: '未解析到 SEARCH/REPLACE 块（需 aider editblock 格式）', applied: [], failed: [] };
  }

  const applied = [];
  const failed = [];

  for (const block of blocks) {
    const abs = path.isAbsolute(block.filePath)
      ? path.normalize(block.filePath)
      : path.resolve(root, block.filePath);
    if (!abs.startsWith(root + path.sep) && abs !== root) {
      failed.push({ ...block, error: '路径越出工作区' });
      continue;
    }

    let existing = null;
    try {
      existing = await fs.readFile(abs, 'utf8');
    } catch {
      existing = null;
    }

    if (existing == null) {
      if (block.oldText.trim() !== '') {
        failed.push({ filePath: block.filePath, error: '文件不存在且 SEARCH 非空' });
        continue;
      }
      if (!opts.dryRun) {
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, block.newText, 'utf8');
      }
      applied.push({ filePath: block.filePath, mode: 'create' });
      continue;
    }

    const replaced = replaceOnce(existing, block.oldText, block.newText);
    if (!replaced.ok) {
      failed.push({
        filePath: block.filePath,
        error: replaced.mode === 'ambiguous'
          ? 'SEARCH 匹配多处，请加长上下文'
          : 'SEARCH 未精确匹配，请 read 后重试'
      });
      continue;
    }
    if (!opts.dryRun) {
      await fs.writeFile(abs, replaced.content, 'utf8');
    }
    applied.push({ filePath: block.filePath, mode: replaced.mode });
  }

  return {
    success: failed.length === 0,
    applied,
    failed,
    dryRun: !!opts.dryRun,
    error: failed.length ? `${failed.length} 个块失败` : undefined
  };
}
