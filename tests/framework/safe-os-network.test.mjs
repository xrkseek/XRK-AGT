/**
 * `#utils/safe-os-network`：网卡枚举容错与 uv_interface_addresses 识别。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  safeOsNetworkInterfaces,
  isUvInterfaceAddressesError
} from '#utils/safe-os-network.js';

describe('safe-os-network', () => {
  it('safeOsNetworkInterfaces 返回对象且不抛', () => {
    const ifaces = safeOsNetworkInterfaces();
    assert.equal(typeof ifaces, 'object');
    assert.ok(ifaces !== null);
  });

  it('识别 uv_interface_addresses / ERR_SYSTEM_ERROR', () => {
    const err = new Error(
      'A system error occurred: uv_interface_addresses returned Unknown system error 2 (Unknown system error 2)'
    );
    err.code = 'ERR_SYSTEM_ERROR';
    assert.equal(isUvInterfaceAddressesError(err), true);
    assert.equal(isUvInterfaceAddressesError(new Error('plain')), false);
  });
});
