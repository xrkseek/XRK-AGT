import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('no hot-reload', () => {
  it('does not ship hot-reload-base source', () => {
    assert.equal(
      fs.existsSync(path.join(root, 'src/utils/hot-reload-base.js')),
      false,
    );
    assert.equal(
      fs.existsSync(path.join(root, 'src/utils/hot-reload-base.ts')),
      false,
    );
  });

  it('does not depend on chokidar', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    assert.equal(pkg.dependencies?.chokidar, undefined);
    assert.equal(pkg.devDependencies?.chokidar, undefined);
  });

  it('runtime-boot does not enable loader watches', () => {
    const boot = fs.readFileSync(
      path.join(root, 'src/infrastructure/http/runtime-boot.ts'),
      'utf8',
    );
    assert.equal(/\bPluginLoader\.watch\s*\(/.test(boot), false);
    assert.equal(/\bHttpApiLoader\.watch\s*\(/.test(boot), false);
    assert.equal(/\bAiWorkflowLoader\.watch\s*\(/.test(boot), false);
    assert.equal(/\bCommonConfigRegistry\.watch\s*\(/.test(boot), false);
  });
});
