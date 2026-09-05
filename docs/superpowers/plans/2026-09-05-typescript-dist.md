# TypeScript → dist + Remove Hot-Reload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship XRK-AGT from `refactor/typescript` with `tsc` emit to `dist/`, no business hot-reload, and progressive `.ts` sources for `app` + `src/` + `core/`.

**Architecture:** Delete `HotReloadBase`/chokidar and all YAML/module/template watchers so loaders load once at boot. Add `tsconfig.build.json` + asset copy so runtime only executes `dist/`. Point `package.json` `#` imports and start scripts at `dist`. Migrate `.js` → `.ts` directory-by-directory while `allowJs` is on, then tighten.

**Tech Stack:** Node ≥26, pnpm, TypeScript 5.9 (`module`/`moduleResolution`: `NodeNext`), existing Express loaders, no strip-types on the production start path.

**Spec:** [docs/superpowers/specs/2026-09-05-typescript-dist-design.md](../specs/2026-09-05-typescript-dist-design.md) · **ADR:** [docs/adr/0004-typescript-dist-no-hot-reload.md](../../adr/0004-typescript-dist-no-hot-reload.md)

**Locked open details (from design §10):**
- Keep root `app.js` → rename to `app.ts` later; `outDir`/`rootDir` so emit is `dist/app.js`, `dist/src/...`, `dist/core/...`.
- Add `pnpm build:watch` = `tsc -p tsconfig.build.json -w` (manual process restart).
- CI/unit: `pnpm build` then tests; prefer `#` imports → `dist` after Phase 2. Until then relative `src/` imports may remain for unmigrated tests.

---

## File map (decomposition)

| Path | Role after change |
|------|-------------------|
| `src/utils/hot-reload-base.js` | **Delete** |
| `src/infrastructure/plugins/loader-hot-reload.js` | Strip watch; keep unload/change helpers needed by discovery, or fold into `loader-discovery.js` / `loader-deal.js` |
| `src/infrastructure/plugins/loader.js` | Drop `hotReloadMethods` / `_hotReload` |
| `src/infrastructure/http/loader.js` | Remove `watch()` body / `_hotReload` |
| `src/infrastructure/commonconfig/loader.js` | Same |
| `src/infrastructure/ai-workflow/loader.js` | Same |
| `src/infrastructure/config/config.js` | Remove YAML `watch` / `_configHotReload` |
| `src/infrastructure/renderer/Renderer.js` | Remove template watch |
| `src/infrastructure/renderer/loader.js` | `stopAllWatchers` no-op or delete call sites |
| `src/infrastructure/http/runtime-boot.js` | Stop calling `*.watch(true)` |
| `src/utils/loader-shutdown.js` | Stop watchers only where destroy still needed; no chokidar |
| `src/utils/paths.js` | Module scan root → `dist/core` (after Phase 2); asset helpers for source `core/` www if needed |
| `scripts/copy-runtime-assets.mjs` | **Create** — copy non-JS under `core/` into `dist/core/` |
| `tsconfig.build.json` | **Create** — emit |
| `package.json` | `build`, `#` → `dist`, start without strip-types |
| `app.js` / `start.bat` / `start.sh` | Start `dist/app.js` |
| `.github/workflows/ci.yml` | `pnpm build` before tests; fix `node --check` paths to `dist/` |

---

### Task 1: Regression test — hot-reload must disappear

**Files:**
- Create: `tests/framework/no-hot-reload.test.mjs`
- Test: same

- [ ] **Step 1: Write the failing test**

```javascript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);

describe('no hot-reload', () => {
  it('does not ship hot-reload-base source', () => {
    assert.equal(
      fs.existsSync(path.join(root, 'src/utils/hot-reload-base.js')),
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
      path.join(root, 'src/infrastructure/http/runtime-boot.js'),
      'utf8',
    );
    assert.equal(/\bPluginLoader\.watch\s*\(/.test(boot), false);
    assert.equal(/\bHttpApiLoader\.watch\s*\(/.test(boot), false);
    assert.equal(/\bAiWorkflowLoader\.watch\s*\(/.test(boot), false);
    assert.equal(/\bCommonConfigRegistry\.watch\s*\(/.test(boot), false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/framework/no-hot-reload.test.mjs`

Expected: FAIL (file still exists / chokidar still in package.json / watch calls present)

- [ ] **Step 3: Commit the failing test**

```bash
git add tests/framework/no-hot-reload.test.mjs
git commit -m "test: assert hot-reload and chokidar are removed"
```

---

### Task 2: Stop enabling watches at boot + simplify shutdown

**Files:**
- Modify: `src/infrastructure/http/runtime-boot.js` (search `watch(true)` ~284–287)
- Modify: `src/utils/loader-shutdown.js`

- [ ] **Step 1: Remove watch enablement in runtime-boot**

Delete the Promise entries that call:

```javascript
CommonConfigRegistry.watch(true),
AiWorkflowLoader.watch(true),
PluginLoader.watch(true),
HttpApiLoader.watch(true),
```

Keep the rest of the boot parallel load unchanged. If those were the only items in an array, leave other loaders/init calls intact.

- [ ] **Step 2: Rewrite loader-shutdown without watch toggles**

Replace `src/utils/loader-shutdown.js` with:

```javascript
/**
 * 停机时销毁 Loader / 配置资源（无文件监视器）。
 */
import PluginLoader from '#infrastructure/plugins/loader.js';
import HttpApiLoader from '#infrastructure/http/loader.js';
import CommonConfigRegistry from '#infrastructure/commonconfig/loader.js';
import AiWorkflowLoader from '#infrastructure/ai-workflow/loader.js';
import runtimeConfig from '#infrastructure/config/config.js';
import RendererLoader from '#infrastructure/renderer/loader.js';
import { setShuttingDown } from '#utils/runtime-globals.js';

export async function stopAllLoaderWatchers() {
  setShuttingDown(true);
  await PluginLoader.destroy().catch(() => {});
  await AiWorkflowLoader.cleanupAll().catch(() => {});
  if (typeof HttpApiLoader.destroy === 'function') {
    await HttpApiLoader.destroy().catch(() => {});
  }
  if (typeof CommonConfigRegistry.destroy === 'function') {
    await CommonConfigRegistry.destroy().catch(() => {});
  }
  await RendererLoader.stopAllWatchers?.().catch(() => {});
  await runtimeConfig.destroy().catch(() => {});
}
```

(If `HttpApiLoader.destroy` / `CommonConfigRegistry.destroy` do not exist yet, keep only existing destroy/cleanup APIs and remove `watch(false)` calls — do not invent destroy methods in this step.)

- [ ] **Step 3: Run fast tests that do not require full remove yet**

Run: `node --test tests/framework/no-hot-reload.test.mjs`

Expected: runtime-boot assertion PASS; other assertions may still FAIL

- [ ] **Step 4: Commit**

```bash
git add src/infrastructure/http/runtime-boot.js src/utils/loader-shutdown.js
git commit -m "refactor: stop enabling loader file watchers at boot"
```

---

### Task 3: Remove HotReload from HTTP / commonconfig / ai-workflow loaders

**Files:**
- Modify: `src/infrastructure/http/loader.js`
- Modify: `src/infrastructure/commonconfig/loader.js`
- Modify: `src/infrastructure/ai-workflow/loader.js`

- [ ] **Step 1: HttpApiLoader — delete hot-reload**

In `src/infrastructure/http/loader.js`:
- Remove `import { HotReloadBase } from '#utils/hot-reload-base.js'`
- Remove field `_hotReload = null`
- Replace `async watch(enable = true) { ... }` with:

```javascript
async watch(_enable = true) {
  // hot-reload removed; kept as no-op for any stray callers
}
```

Or delete `watch` entirely if Task 2 removed all callers (prefer delete + fix any remaining references with Grep).

- [ ] **Step 2: CommonConfigRegistry — same pattern**

Remove `HotReloadBase` import, `_hotReload`, and `watch` implementation (no-op or delete).

- [ ] **Step 3: AiWorkflowLoader — same pattern**

Remove `HotReloadBase` import, `_hotReload`, watch start/stop in `cleanupAll`/`watch`, and any `await this._hotReload?.stop()`.

- [ ] **Step 4: Grep for leftover HotReloadBase in these three files**

Run: `git grep -n HotReloadBase -- src/infrastructure/http src/infrastructure/commonconfig src/infrastructure/ai-workflow`

Expected: no matches

- [ ] **Step 5: Commit**

```bash
git add src/infrastructure/http/loader.js src/infrastructure/commonconfig/loader.js src/infrastructure/ai-workflow/loader.js
git commit -m "refactor: remove hot-reload from http/commonconfig/workflow loaders"
```

---

### Task 4: Remove plugin hot-reload mixin

**Files:**
- Modify: `src/infrastructure/plugins/loader-discovery.js`
- Modify: `src/infrastructure/plugins/loader.js`
- Modify: `src/infrastructure/plugins/loader-hot-reload.js` (delete or gut)
- Check: `src/infrastructure/plugins/loader-deal.js` for change/unload helpers still needed

- [ ] **Step 1: Fix discovery to use module-ext directly**

In `src/infrastructure/plugins/loader-discovery.js`, replace:

```javascript
import { HotReloadBase } from '#utils/hot-reload-base.js'
```

with:

```javascript
import { moduleFileKey } from '#utils/module-ext.ts'
```

Replace `HotReloadBase.moduleFileKey(nameOrPath)` with `moduleFileKey(nameOrPath)`.

- [ ] **Step 2: Decide loader-hot-reload.js**

Keep non-watch helpers (`changePlugin`, `unloadPlugin`, etc.) in `loader-hot-reload.js` **or** move them into `loader-deal.js`. Delete every method that constructs `HotReloadBase` or calls `hotReload.watch`. Remove `_hotReload` handling from `watch` / `destroy` in that mixin.

Minimal `watch` if still assigned:

```javascript
async watch(_enable = true) {}
```

- [ ] **Step 3: loader.js destroy**

In `src/infrastructure/plugins/loader.js`, remove:

```javascript
await this._hotReload?.stop()
this._hotReload = null
```

Remove `_hotReload = null` field if unused. If `hotReloadMethods` becomes empty of watch-only code but still has change/unload, keep `Object.assign(..., hotReloadMethods)`. If the file is watch-only after gutting, remove it from `Object.assign` and delete the file.

- [ ] **Step 4: Commit**

```bash
git add src/infrastructure/plugins/
git commit -m "refactor: remove plugin loader file watching"
```

---

### Task 5: Remove YAML and template watching

**Files:**
- Modify: `src/infrastructure/config/config.js`
- Modify: `src/infrastructure/renderer/Renderer.js`
- Modify: `src/infrastructure/renderer/loader.js`

- [ ] **Step 1: config.js — load once, no watch**

Remove `HotReloadBase` import and all of: `_configHotReload`, `_hotReloads`, `_watchHandlers` (if only used for hot reload), methods `watch`, handlers that re-read on change. Where `if (watchFile) this.watch(...)` appears after load, delete those calls; keep the initial file read/load path.

`destroy()` should only clear caches/maps — no `await this._configHotReload?.stop()`.

- [ ] **Step 2: Renderer.js — no template watch**

Remove `HotReloadBase` import. Delete `watch(tplFile)` calls from render path and delete `watch` / `stopAllWatchers` implementations that use chokidar (or make `stopAllWatchers` empty async).

- [ ] **Step 3: renderer/loader.js**

Keep `stopAllWatchers` as:

```javascript
async stopAllWatchers() {
  // no-op: template hot-reload removed
}
```

so shutdown remains safe.

- [ ] **Step 4: Commit**

```bash
git add src/infrastructure/config/config.js src/infrastructure/renderer/Renderer.js src/infrastructure/renderer/loader.js
git commit -m "refactor: remove YAML and template file watching"
```

---

### Task 6: Delete HotReloadBase and chokidar dependency

**Files:**
- Delete: `src/utils/hot-reload-base.js`
- Modify: `package.json`
- Modify docs listed below (can be same commit or Task 7)

- [ ] **Step 1: Grep repo for remaining references**

Run: `git grep -n "hot-reload-base\|HotReloadBase\|chokidar" -- "*.js" "*.ts" "*.mjs" "package.json"`

Expected: only docs (fix in Task 7) or nothing in code

- [ ] **Step 2: Delete the file and uninstall**

```bash
git rm src/utils/hot-reload-base.js
pnpm remove chokidar
```

- [ ] **Step 3: Run the Task 1 test — expect PASS**

Run: `node --test tests/framework/no-hot-reload.test.mjs`

Expected: all three tests PASS

- [ ] **Step 4: Run fast suite**

Run: `pnpm test:fast`

Expected: PASS (fix any incidental import breakage first)

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-lock.yaml src/utils/
git commit -m "chore: delete HotReloadBase and chokidar dependency"
```

---

### Task 7: Document hot-reload removal + mark design Accepted

**Files:**
- Modify: `docs/superpowers/specs/2026-09-05-typescript-dist-design.md` (status → Accepted for hot-reload section progress, or overall keep Proposed until build lands — set **状态：Accepted** when Task 6 done for decisions; build still pending implementation)
- Modify: `docs/adr/0004-typescript-dist-no-hot-reload.md` — Status stays Proposed until Phase 2 ships; after Task 12 set Accepted
- Modify: `docs/coding-style.md` — remove hot-reload / strip-types-as-primary rows; state restart-required
- Modify: `docs/node-26-runtime.md` — replace 「TypeScript Core（渐进）」with dist-build note; remove strip-types as production path
- Modify: `docs/api-loader.md`, `docs/plugins-loader.md`, `docs/renderer.md`, `docs/infrastructure-shared.md` — delete or strike hot-reload sections; link ADR-0004
- Modify: `docs/startup.md` — note config changes need restart

- [ ] **Step 1: Edit docs (no contradictory “use HotReloadBase” guidance left)**

- [ ] **Step 2: Commit**

```bash
git add docs/
git commit -m "docs: drop hot-reload guidance; point to ADR-0004"
```

---

### Task 8: Add `tsconfig.build.json` and asset copy script

**Files:**
- Create: `tsconfig.build.json`
- Create: `scripts/copy-runtime-assets.mjs`
- Modify: `tsconfig.json` (widen `include` for IDE: `app.js`, `src/**/*`, `core/**/*` with `allowJs`)
- Modify: `.gitignore` — ensure root `dist/` ignored; keep existing `!core/system-Core/www/xrk/dist/` exceptions

- [ ] **Step 1: Write `tsconfig.build.json`**

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": false,
    "allowJs": true,
    "checkJs": false,
    "outDir": "dist",
    "rootDir": ".",
    "declaration": false,
    "sourceMap": true,
    "rewriteRelativeImportExtensions": true
  },
  "include": [
    "app.js",
    "app.ts",
    "start.js",
    "debug.js",
    "src/**/*",
    "core/**/*.js",
    "core/**/*.ts",
    "core/**/*.mjs",
    "core/**/*.mts"
  ],
  "exclude": [
    "node_modules",
    "dist",
    "**/www/**",
    "**/site/**",
    "core/**/node_modules/**",
    "tests",
    "subserver",
    "scripts"
  ]
}
```

If `tsc` errors on `rootDir: "."` because of excluded folders, narrow `include` or set `"rootDir": "."` only with the listed includes (tsc computes rootDir from included files).

- [ ] **Step 2: Write `scripts/copy-runtime-assets.mjs`**

Copy non-code assets from `core/` → `dist/core/` (yaml, json, html, css, svg, png, etc.), skipping `node_modules`, `www` build inputs if already handled by `build:www`, and skipping `.js/.ts/.mjs/.mts` (those come from tsc).

```javascript
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcCore = path.join(root, 'core');
const destCore = path.join(root, 'dist', 'core');
const SKIP_DIR = new Set(['node_modules', '.git']);
const CODE_EXT = new Set(['.js', '.ts', '.mjs', '.mts', '.cjs', '.cts']);

async function walk(dir, rel = '') {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (SKIP_DIR.has(ent.name)) continue;
    const from = path.join(dir, ent.name);
    const relPath = path.join(rel, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === 'www' || ent.name === 'site') {
        // optional: skip heavy frontend trees if served from source paths;
        // default: copy (www static may be needed under dist/core)
      }
      await walk(from, relPath);
      continue;
    }
    const ext = path.extname(ent.name).toLowerCase();
    if (CODE_EXT.has(ext)) continue;
    const to = path.join(destCore, relPath);
    await fs.mkdir(path.dirname(to), { recursive: true });
    await fs.copyFile(from, to);
  }
}

await fs.mkdir(destCore, { recursive: true });
await walk(srcCore);
console.log('copy-runtime-assets: core assets → dist/core');
```

Adjust www/site skip policy in-implementation if copy is too large: then keep `paths` www pointing at source `core/.../site` (see Task 9).

- [ ] **Step 3: Widen IDE `tsconfig.json` include**

Set `"include"` to at least:

```json
"include": ["app.js", "app.ts", "src/**/*", "core/**/*.ts", "core/**/*.js", "tests/framework/**/*.ts"]
```

Keep `"allowJs": true`, `"noEmit": true`.

- [ ] **Step 4: Smoke `tsc` emit**

Run: `pnpm exec tsc -p tsconfig.build.json`

Expected: `dist/app.js` and `dist/src/...` exist (fix type errors by temporarily `skipLibCheck` already on; if strict errors block, fix only blockers or set `"strict": true` still but exclude broken files — prefer fix).

- [ ] **Step 5: Commit**

```bash
git add tsconfig.json tsconfig.build.json scripts/copy-runtime-assets.mjs
git commit -m "build: add tsc emit config and core asset copy script"
```

---

### Task 9: Point runtime paths and `#` imports at `dist`

**Files:**
- Modify: `src/utils/paths.js`
- Modify: `package.json`
- Modify: `app.js` (stay at root until renamed; build emits `dist/app.js`)
- Modify: `start.bat`, `start.sh`
- Create or modify: ensure `pnpm build` runs tsc + copy

- [ ] **Step 1: paths.js — dual roots**

After computing `_root` from `import.meta.url` (works from both `src/utils` and `dist/src/utils` as `../..` → repo root):

```javascript
const _dist = path.join(_root, 'dist');
const _src = path.join(_root, 'src');
/** Loader 扫描与动态 import 的 Core 根（编译产物） */
const _core = path.join(_dist, 'core');
/** 源码树 Core（www / 未拷贝资源回退） */
const _coreSource = path.join(_root, 'core');
```

Export both `core` (`_core`) and `coreSource` (`_coreSource`). Point `_www` at existing site path under `_coreSource` if assets are not copied:

```javascript
const _www = path.join(_coreSource, 'system-Core', 'site');
```

`listAllCoreDirs` / `getCoreSubDirs` must use `_core` (dist). If `dist/core` missing, throw a clear error: `run pnpm build first`.

- [ ] **Step 2: package.json scripts and imports**

```json
"main": "dist/app.js",
"imports": {
  "#utils/*": "./dist/src/utils/*",
  "#core/*": "./dist/core/*",
  "#config/*": "./config/*",
  "#data/*": "./data/*",
  "#renderers/*": "./dist/src/renderers/*",
  "#modules/*": "./dist/src/modules/*",
  "#infrastructure/*": "./dist/src/infrastructure/*",
  "#factory/*": "./dist/src/factory/*"
},
"scripts": {
  "build": "tsc -p tsconfig.build.json && node scripts/copy-runtime-assets.mjs",
  "build:watch": "tsc -p tsconfig.build.json -w",
  "typecheck": "tsc -p tsconfig.json --noEmit",
  "start": "pnpm build && node dist/app.js",
  "dev": "pnpm build && node dist/app.js"
}
```

Remove `--experimental-strip-types` from start scripts. Keep `debug` consistent (`node dist/debug.js` after including `debug.js` in build).

- [ ] **Step 3: start.bat / start.sh**

`start.sh`:

```bash
exec node --no-warnings --no-deprecation dist/app.js "$@"
```

(Callers should `pnpm build` first, or script runs build — match package.json.)

`start.bat`:

```bat
node dist/app.js %*
```

- [ ] **Step 4: Verify boot from dist**

Run:

```bash
pnpm build
node dist/app.js --help
```

or whatever non-interactive smoke the project supports (if menu blocks, run existing smoke test / `pnpm test:smoke` after build).

Expected: process starts loaders from `dist/core` without strip-types.

- [ ] **Step 5: Commit**

```bash
git add package.json src/utils/paths.js start.bat start.sh
git commit -m "build: run from dist and resolve Core modules under dist/core"
```

---

### Task 10: CI uses build + dist checks

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: any Dockerfiles under repo that `CMD node app.js`

- [ ] **Step 1: Update CI**

```yaml
- name: Build
  run: pnpm build
- name: Test (fast)
  run: pnpm test:fast
- name: Syntax-check runtime facade
  run: |
    node --check dist/src/agent-runtime.js
    node --check dist/src/infrastructure/http/runtime-auth.js
    # ... same list under dist/src/...
```

Add `refactor/typescript` is covered by `pull_request` already.

- [ ] **Step 2: Update Docker entry if present**

Grep Dockerfiles for `app.js` / `strip-types`; switch to `pnpm build` in image build and `node dist/app.js`.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: require pnpm build and check dist facades"
```

---

### Task 11: Mark ADR build decision in progress docs; smoke

- [ ] **Step 1: Set ADR-0004 Status to Accepted** (emit + no hot-reload both landed)

- [ ] **Step 2: Design doc status → Accepted**

- [ ] **Step 3: `pnpm build && pnpm test:fast && pnpm typecheck`**

Expected: all green (typecheck may still only cover partial includes — widen as files migrate)

- [ ] **Step 4: Commit + push branch**

```bash
git add docs/adr/0004-typescript-dist-no-hot-reload.md docs/superpowers/specs/2026-09-05-typescript-dist-design.md
git commit -m "docs: accept ADR-0004 after dist runtime lands"
git push origin refactor/typescript
```

---

### Task 12: Migrate leaf `src/utils` to TypeScript (batch pattern)

**Files:** start with pure helpers (no Express): e.g. `src/utils/loader-constants.js`, `src/utils/normalize-error.js`, `src/utils/simple-logger.js`, already-`module-ext.ts`.

- [ ] **Step 1: Pick one file — example `loader-constants.js` → `.ts`**

Rename:

```bash
git mv src/utils/loader-constants.js src/utils/loader-constants.ts
```

Add types:

```typescript
export const SCAN_IGNORE_PREFIXES = Object.freeze(['.', '_'] as const);

export const LOADER_BATCH_SIZE = 10;

export const API_REGISTER_BATCH_SIZE = 8;
```

Update imports that referenced `loader-constants.js` to keep **`.js` extension in import paths** (NodeNext emit):

```typescript
import { LOADER_BATCH_SIZE } from '#utils/loader-constants.js';
```

- [ ] **Step 2: `pnpm build && node --test` relevant tests**

- [ ] **Step 3: Commit**

```bash
git commit -am "refactor(ts): migrate loader-constants to TypeScript"
```

- [ ] **Step 4: Repeat for remaining `src/utils/*.js` in small commits (≤10 files each)**

Priority order: `normalize-error` → `runtime-globals` → `core-fs` → `file-loader` → `paths` → rest. After each batch: `pnpm build`.

---

### Task 13: Migrate `src/infrastructure`, `src/factory`, `src/renderers`, `src/agent-runtime.js`, root `app.js`

- [ ] **Step 1: infrastructure loaders and config** — same `git mv` + minimal types; keep default exports
- [ ] **Step 2: factory LLM clients**
- [ ] **Step 3: `agent-runtime.js` → `.ts`, `app.js` → `app.ts`**
- [ ] **Step 4: Update `tsconfig.build.json` include to prefer `.ts`; remove migrated `.js` leftovers
- [ ] **Step 5: Commit per subdirectory**

---

### Task 14: Migrate Cores

Order:
1. `core/harness-proxy-Core/http/reverse-proxy-8787.js` → `.ts`
2. `JM-Core`, `QQbot-Core`, `Roco-Core`
3. `system-Core` (largest; multiple commits by `plugin/` `http/` `workflow/`)

- [ ] **Step 1: Each Core — mv to `.ts`, build, smoke load**
- [ ] **Step 2: Final commit when all Core JS modules migrated**

---

### Task 15: Tighten build (drop allowJs) + final gate

**Files:**
- Modify: `tsconfig.build.json` — `"allowJs": false` when no JS sources remain under include
- Modify: `src/utils/module-ext.ts` — MODULE_EXTS can remain `.js` for emit output; source scan of repo for loaders is on `dist` (`.js` only)

- [ ] **Step 1: Count remaining source JS**

Run: `git ls-files "src/**/*.js" "core/**/*.js" "app.js" | findstr /V www`

Expected: empty (except intentional assets)

- [ ] **Step 2: `allowJs: false`, full `pnpm build && pnpm typecheck && pnpm test:fast`**

- [ ] **Step 3: Final docs pass + push**

```bash
git commit -m "build: disable allowJs; TypeScript sources only"
git push origin refactor/typescript
```

---

## Spec coverage self-check

| Spec requirement | Task(s) |
|------------------|---------|
| tsc → dist, no strip-types main path | 8–11 |
| Remove module/YAML/template hot-reload | 1–7 |
| Remove chokidar | 6 |
| `#` imports → dist | 9 |
| Loader scans dist/core | 9 |
| Asset copy for non-JS core files | 8–9 |
| Migrate src then core | 12–14 |
| Drop allowJs / CI build | 10, 15 |
| Docs + ADR | 7, 11 |
| start.bat/sh / Docker | 9–10 |
| build:watch | 9 |
| Tests after build | 10–11 |

**Placeholder scan:** none intentional; Task 12–14 use a repeatable migration pattern with a concrete first-file example rather than pasting every file’s full source.

**Type consistency:** `moduleFileKey` from `#utils/module-ext`; paths export `core` (dist) + `coreSource`; `stopAllLoaderWatchers` name retained for call-site stability.
