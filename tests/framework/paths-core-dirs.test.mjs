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

  it('warmup still lists www-only Core dirs', async (t) => {
    if (!fs.existsSync(path.join(vibeLearnCore, 'www'))) {
      t.skip('missing fixture core/vibe-learn-Core/www');
      return;
    }
    assert.equal(
      fs.existsSync(path.join(vibeLearnCore, 'plugin')),
      false,
      'fixture must have no plugin/ to cover www-only cores',
    );

    await paths.warmupCoreLayout();
    const dirs = await paths.getCoreDirs();
    const names = dirs.map((d) => path.basename(d));

    assert.ok(
      names.includes('vibe-learn-Core'),
      `getCoreDirs should include vibe-learn-Core, got: ${names.slice(0, 8).join(',')}`,
    );
  });
});
