import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import paths from '#utils/paths.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const vibeLearnCore = path.join(repoRoot, 'core', 'vibe-learn-Core');

describe('paths.getCoreDirs', () => {
  before(() => {
    paths.invalidateCoreCache();
  });

  after(() => {
    paths.invalidateCoreCache();
  });

  it('warmup ?????? www ? Core??? loader ????????', async () => {
    assert.ok(
      fs.existsSync(path.join(vibeLearnCore, 'www')),
      '????? vibe-learn-Core/www??????'
    );
    assert.equal(
      fs.existsSync(path.join(vibeLearnCore, 'plugin')),
      false,
      '???? plugin??????? www???'
    );

    await paths.warmupCoreLayout();
    const dirs = await paths.getCoreDirs();
    const names = dirs.map((d) => path.basename(d));

    assert.ok(
      names.includes('vibe-learn-Core'),
      `getCoreDirs ?? vibe-learn-Core???: ${names.filter((n) => n.includes('vibe') || n.includes('Example')).join(',') || names.slice(0, 5).join(',')}`
    );
  });
});
