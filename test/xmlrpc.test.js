// -----------------------------------------------------------------------------
// The XML-RPC codec of the rTorrent client (src/clients/xmlrpc.js): every
// value type rTorrent sends, entities, faults, and what is not XML-RPC.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  XmlRpcFault,
  XmlRpcFormatError,
  decodeCall,
  decodeResponse,
  encodeCall,
  encodeFault,
  encodeResponse,
  unescapeXml,
} from '../src/clients/xmlrpc.js';

const answer = (value) =>
  `<?xml version="1.0"?>\n<methodResponse>\n  <params>\n    <param>${value}</param>\n  </params>\n</methodResponse>\n`;

test('integers: i4, int, i8 (rTorrent 0.16 answers i8), beyond 32 bits', () => {
  assert.equal(decodeResponse(answer('<value><i4>-12</i4></value>')), -12);
  assert.equal(decodeResponse(answer('<value><int>7</int></value>')), 7);
  assert.equal(decodeResponse(answer('<value><i8>42932940800</i8></value>')), 42932940800);
  assert.throws(() => decodeResponse(answer('<value><i8>12x</i8></value>')), XmlRpcFormatError);
});

test('strings: typed, untyped, empty, self-closing, with entities', () => {
  assert.equal(decodeResponse(answer('<value><string>a b</string></value>')), 'a b');
  assert.equal(decodeResponse(answer('<value>untyped text</value>')), 'untyped text');
  assert.equal(decodeResponse(answer('<value><string></string></value>')), '');
  assert.equal(decodeResponse(answer('<value><string/></value>')), '');
  assert.equal(decodeResponse(answer('<value/>')), '');
  assert.equal(
    decodeResponse(
      answer('<value><string>Tom &amp; Jerry &lt;1080p&gt; &#233;t&#xE9;</string></value>'),
    ),
    'Tom & Jerry <1080p> été',
  );
  assert.equal(unescapeXml('&quot;&apos;&unknown;&#xZZ;'), `"'&unknown;&#xZZ;`);
});

test('boolean, double, nil, base64', () => {
  assert.equal(decodeResponse(answer('<value><boolean>1</boolean></value>')), true);
  assert.equal(decodeResponse(answer('<value><boolean>0</boolean></value>')), false);
  assert.throws(() => decodeResponse(answer('<value><boolean>yes</boolean></value>')));
  assert.equal(decodeResponse(answer('<value><double>1.5</double></value>')), 1.5);
  assert.equal(decodeResponse(answer('<value><nil/></value>')), null);
  assert.equal(decodeResponse(answer('<value><base64>AAEC</base64></value>')), 'AAEC');
});

test('arrays and structs, nested and empty', () => {
  const body = answer(`<value><array><data>
      <value><array><data><value><string>x</string></value><value><i8>1</i8></value></data></array></value>
      <value><struct>
        <member><name>a</name><value><i4>1</i4></value></member>
        <member><name>b</name><value><array><data/></array></value></member>
      </struct></value>
      <value><array><data></data></array></value>
      <value><struct></struct></value>
    </data></array></value>`);
  assert.deepEqual(decodeResponse(body), [['x', 1], { a: 1, b: [] }, [], {}]);
});

test('a fault answer throws its code and message', () => {
  const body = encodeFault(-506, "method 'x' not defined");
  assert.throws(
    () => decodeResponse(body),
    (err) => {
      assert.ok(err instanceof XmlRpcFault);
      assert.equal(err.code, -506);
      assert.equal(err.message, "method 'x' not defined");
      return true;
    },
  );
});

test('what is not an XML-RPC answer', () => {
  for (const body of [
    '',
    '<html><body>ruTorrent</body></html>',
    '{"result": 1}',
    answer('<value><i8>1</i8>'),
    answer('<value><unknown>1</unknown></value>'),
    '<methodResponse><params><param><value><string>never closed',
  ]) {
    assert.throws(() => decodeResponse(body), XmlRpcFormatError, body);
  }
});

test('a call round trip: strings escaped, integers, booleans, arrays, structs', () => {
  const params = [
    '',
    'a <b> & "c"',
    3,
    2 ** 40,
    true,
    1.5,
    ['d.hash='],
    { methodName: 'x', params: [] },
  ];
  const body = encodeCall('system.multicall', params);
  assert.match(body, /<i4>3<\/i4>/);
  assert.match(body, /<i8>1099511627776<\/i8>/);
  assert.match(body, /a &lt;b&gt; &amp; &quot;c&quot;/);
  assert.deepEqual(decodeCall(body), { method: 'system.multicall', params });
  assert.deepEqual(decodeResponse(encodeResponse(params)), params);
  assert.throws(() => encodeCall('x', [undefined]), TypeError);
});

test('comments between tags are skipped', () => {
  assert.equal(
    decodeResponse(
      '<!-- proxy --><methodResponse><params><param><value><i4>1</i4></value></param></params></methodResponse>',
    ),
    1,
  );
});

test('a member named __proto__ stays a plain property, an empty double is refused', () => {
  const struct = decodeResponse(
    answer(
      '<value><struct><member><name>__proto__</name><value><i4>1</i4></value></member></struct></value>',
    ),
  );
  assert.equal(Object.getPrototypeOf(struct), Object.prototype);
  assert.equal(Object.getOwnPropertyDescriptor(struct, '__proto__').value, 1);
  assert.throws(
    () => decodeResponse(answer('<value><double></double></value>')),
    XmlRpcFormatError,
  );
});
