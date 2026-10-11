import runtimeConfig from '#infrastructure/config/config.js';
import fs from 'node:fs/promises';
import path from 'node:path';

function resolvePaths() {
  const agtCfg = runtimeConfig.agt || {};
  const filesCfg = agtCfg.files || {};
  const bannedWordsPath = filesCfg.bannedWordsPath || 'data/bannedWords/';
  const bannedImagesPath = filesCfg.bannedImagesPath || 'data/bannedWords/images/';
  const bannedConfigPath = filesCfg.bannedConfigPath || 'data/bannedWords/config/';
  return { bannedWordsPath, bannedImagesPath, bannedConfigPath };
}

function normalizeStr(s: any) {
  return String(s ?? '').trim();
}

async function readJsonIfExists(filePath: any) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * 轻量违禁词服务（HTTP 侧复用 data/bannedWords/global.json）
 * - exact: 精确匹配（按“包含”判断，保留原项目语义）
 * - fuzzy: 模糊匹配（包含）
 * - images: md5 => info
 */
export class BannedWordsService {
  [key: string]: any;
  #cache: any = null;
  #lastLoadTs = 0;

  async #loadGlobalIfNeeded() {
    const now = Date.now();
    if (this.#cache && now - this.#lastLoadTs < 5_000) return this.#cache;
    this.#lastLoadTs = now;

    const { bannedWordsPath } = resolvePaths();
    const filePath = path.join(bannedWordsPath, 'global.json');
    const data = (await readJsonIfExists(filePath)) || {};

    const exact = new Set(Array.isArray(data.exact) ? data.exact.map(normalizeStr).filter(Boolean) : []);
    const fuzzy = new Set(Array.isArray(data.fuzzy) ? data.fuzzy.map(normalizeStr).filter(Boolean) : []);
    const images = new Map(Object.entries(data.images && typeof data.images === 'object' ? data.images : {}));
    const config = data.config && typeof data.config === 'object' ? data.config : {};

    this.#cache = { exact, fuzzy, images, config, filePath };
    return this.#cache;
  }

  async checkText(text: any) {
    const t = normalizeStr(text);
    if (!t) return null;
    const { exact, fuzzy } = await this.#loadGlobalIfNeeded();

    for (const w of exact) {
      if (t.includes(w)) return { type: 'exact', word: w };
    }
    for (const w of fuzzy) {
      if (t.includes(w)) return { type: 'fuzzy', word: w };
    }
    return null;
  }

  async checkImageMd5(md5: any) {
    const h = normalizeStr(md5).toLowerCase();
    if (!h) return null;
    const { images } = await this.#loadGlobalIfNeeded();
    if (images.has(h)) return { type: 'image', md5: h, info: images.get(h) };
    return null;
  }
}

export const bannedWordsService = new BannedWordsService();

