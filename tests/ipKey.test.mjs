import test from 'node:test';
import assert from 'node:assert/strict';
import { ipKey } from '../server/ipKey.mjs';

test('ipKey：IPv4 原样；IPv4 映射的 IPv6 归成点分 IPv4', () => {
  assert.equal(ipKey('1.2.3.4'), '1.2.3.4');
  assert.equal(ipKey('::ffff:1.2.3.4'), '1.2.3.4');
  assert.equal(ipKey('::FFFF:10.0.0.1'), '10.0.0.1');
  assert.equal(ipKey('::ffff:0102:0304'), '1.2.3.4');
});

test('ipKey：IPv6 按 /64 前缀分组，各种写法归一', () => {
  const k = ipKey('2001:db8:1:2::1');
  assert.equal(k, '2001:db8:1:2::/64');
  assert.equal(ipKey('2001:0db8:0001:0002:ffff:eeee:dddd:cccc'), k);
  assert.equal(ipKey('2001:DB8:1:2:abcd::9'), k);
  assert.equal(ipKey('2001:db8:1:2::1%eth0'), k);
  assert.notEqual(ipKey('2001:db8:1:3::1'), k);
  assert.equal(ipKey('::1'), '0:0:0:0::/64');
  assert.equal(ipKey('fe80::1'), 'fe80:0:0:0::/64');
  assert.equal(ipKey('2001:db8::'), '2001:db8:0:0::/64');
  assert.equal(ipKey('2001:db8:1:2:3:4:1.2.3.4'), '2001:db8:1:2::/64');
});

test('ipKey：空值与认不出的串原样返回（不抛）', () => {
  assert.equal(ipKey(null), null);
  assert.equal(ipKey(undefined), null);
  assert.equal(ipKey(''), null);
  assert.equal(ipKey('not-an-ip'), 'not-an-ip');
});
