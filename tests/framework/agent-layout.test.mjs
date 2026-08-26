import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AGENT_MANIFEST_BASENAMES,
  PROJECT_AGENTS_DIR_REL,
  PROJECT_RULES_DIR_REL,
  PROJECT_SKILLS_STANDARD_REL,
  PROJECT_SUBAGENTS_REL,
  WORKSPACE_BUNDLE_DIR_REL,
  LONG_TERM_MEMORY_REL,
  projectAgentsAbs,
  projectAgentsRel,
} from '../../src/utils/agent-workspace-paths.js';
import paths from '../../src/utils/paths.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('agents/ + .xrk/skills 仓库布局', () => {
  it('路径常量与 helpers 一致', () => {
    assert.equal(PROJECT_AGENTS_DIR_REL, 'agents');
    assert.equal(PROJECT_RULES_DIR_REL, 'agents/rules');
    assert.equal(PROJECT_SKILLS_STANDARD_REL, '.xrk/skills');
    assert.equal(WORKSPACE_BUNDLE_DIR_REL, 'agents/workspace');
    assert.equal(PROJECT_SUBAGENTS_REL, 'agents/subagents.yaml');
    assert.equal(projectAgentsRel('recipes'), 'agents/recipes');
    assert.equal(
      projectAgentsAbs(root, 'rules'),
      path.join(root, 'agents', 'rules')
    );
    assert.deepEqual(AGENT_MANIFEST_BASENAMES, [
      'subagents.yaml',
      'subagents.yml',
      'subagents.json',
    ]);
  });

  it('种子目录存在', () => {
    for (const rel of [PROJECT_RULES_DIR_REL, PROJECT_SKILLS_STANDARD_REL, WORKSPACE_BUNDLE_DIR_REL]) {
      assert.ok(fs.existsSync(path.join(root, rel)), rel);
    }
    assert.ok(fs.existsSync(path.join(root, WORKSPACE_BUNDLE_DIR_REL, LONG_TERM_MEMORY_REL)));
    assert.ok(fs.existsSync(path.join(root, PROJECT_SUBAGENTS_REL)));
  });

  it('根目录不再平铺 rules/skills/memory/www', () => {
    for (const name of ['rules', 'skills', 'memory', 'www']) {
      assert.equal(fs.existsSync(path.join(root, name)), false, name);
    }
    assert.ok(fs.existsSync(path.join(root, PROJECT_AGENTS_DIR_REL)), PROJECT_AGENTS_DIR_REL);
  });
});

describe('站点根静态', () => {
  it('paths.www 指向 system-Core/site', () => {
    const expected = path.join(root, 'core', 'system-Core', 'site');
    assert.equal(path.normalize(paths.www), path.normalize(expected));
    assert.ok(fs.existsSync(paths.www));
  });
});
