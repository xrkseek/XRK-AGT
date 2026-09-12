/**
 * 对照 docs/代码审查清单.md §3 安全：
 * InputValidator · SSRF 默认拒私网 · tool approval 默认关（ask→拒绝）
 * @see docs/agent-context.md §5.2 · .cursor/skills/xrk-crawl/SKILL.md
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { InputValidator } from '#utils/input-validator.js';
import { RuntimeError, ErrorCodes } from '#utils/error-handler.js';
import {
  assertUrlSafeForFetch,
  SsrFBlockedError,
  isPrivateNetworkAllowedByPolicy,
} from '#infrastructure/crawl/index.js';
import { isPrivateIpAddress } from '#infrastructure/crawl/ssrf-ip-policy.js';
import {
  isToolApprovalEnabled,
  parseApprovalCommand,
} from '#utils/security/tool-approval.js';
import { inspectToolCallSecurity } from '#utils/security/tool-security-inspect.js';
import runtimeConfig from '#infrastructure/config/config.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dataRoot = path.join(root, 'data');
const checklist = path.join(root, 'docs/代码审查清单.md');

function awKey() {
  return `server.${runtimeConfig._port}.ai-workflow`;
}

function stubAiWorkflow(patch) {
  const key = awKey();
  const prev = runtimeConfig.config[key];
  runtimeConfig.config[key] = {
    policies: [],
    ...(patch || {}),
    security: {
      toolScan: {
        enabled: true,
        onCritical: 'deny',
        onHigh: 'ask',
        onMedium: 'allow',
        ...(patch?.security?.toolScan || {}),
      },
      approval: {
        enabled: false,
        ...(patch?.security?.approval || {}),
      },
    },
  };
  return () => {
    if (prev === undefined) delete runtimeConfig.config[key];
    else runtimeConfig.config[key] = prev;
  };
}

describe('代码审查清单 §3 安全对照', () => {
  it('清单 §3 覆盖 InputValidator / SSRF / tool approval', () => {
    const src = fs.readFileSync(checklist, 'utf8');
    assert.match(src, /## 3\.\s*安全/);
    assert.match(src, /InputValidator/);
    assert.match(src, /assertUrlSafeForFetch|SSRF/);
    assert.match(src, /security\.approval|tool-approval|工具审批/);
  });

  it('InputValidator：合法路径放行、穿越拒绝', () => {
    const ok = InputValidator.validatePath('server_bots/sec-check.yaml', dataRoot);
    assert.ok(ok.includes('server_bots'));
    assert.throws(
      () => InputValidator.validatePath('../../../etc/passwd', dataRoot),
      (err) => err instanceof RuntimeError && err.code === ErrorCodes.INVALID_PATH,
    );
  });

  it('SSRF：默认拒私网；仅显式 allowPrivateNetwork 放行', async () => {
    assert.equal(isPrivateNetworkAllowedByPolicy({}), false);
    assert.equal(isPrivateNetworkAllowedByPolicy({ allowPrivateNetwork: true }), true);
    assert.equal(isPrivateIpAddress('127.0.0.1'), true);
    assert.equal(isPrivateIpAddress('10.0.0.1'), true);

    await assert.rejects(
      () => assertUrlSafeForFetch('http://127.0.0.1/'),
      (err) => err instanceof SsrFBlockedError,
    );
    await assert.rejects(
      () => assertUrlSafeForFetch('http://10.1.2.3/'),
      (err) => err instanceof SsrFBlockedError,
    );
    await assert.rejects(
      () => assertUrlSafeForFetch('http://169.254.169.254/latest/meta-data/'),
      (err) => err instanceof SsrFBlockedError,
    );

    const lookup = async () => [{ address: '127.0.0.1', family: 4 }];
    await assertUrlSafeForFetch('http://127.0.0.1/', { allowPrivateNetwork: true }, lookup);
  });
});

describe('tool approval 路径（默认关）', () => {
  /** @type {(() => void) | undefined} */
  let restore;

  afterEach(() => {
    restore?.();
    restore = undefined;
  });

  it('默认 approval.enabled=false；ask 未开交互则拒绝', async () => {
    restore = stubAiWorkflow({
      policies: [{ effect: 'ask', action: 'tool.call', resource: 'need.ask' }],
      security: { approval: { enabled: false } },
    });
    assert.equal(isToolApprovalEnabled(), false);
    const r = await inspectToolCallSecurity('need.ask', {});
    assert.equal(r.ok, false);
    assert.match(String(r.error || ''), /未获批准|需审批|交互审批未开/);
  });

  it('parseApprovalCommand：#批准 / #拒绝 路径可解析', () => {
    assert.deepEqual(parseApprovalCommand('#批准ab12', 'allow'), {
      decision: 'allow',
      id: 'ab12',
    });
    assert.deepEqual(parseApprovalCommand('#拒绝x9', 'deny'), {
      decision: 'deny',
      id: 'x9',
    });
    assert.equal(parseApprovalCommand('无关', 'allow'), null);
  });
});
