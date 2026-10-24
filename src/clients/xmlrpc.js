// -----------------------------------------------------------------------------
// A small XML-RPC codec for rTorrent, without an XML dependency: rTorrent
// only speaks a tiny, regular subset of XML (no attributes that matter, no
// CDATA, no namespaces), so a strict hand parser stays short and testable.
//
// Values: i4, int, i8 (rTorrent 0.9 to 0.16 answers i8), boolean, double,
// string (also an untyped <value>), base64 (kept as text), nil, array,
// struct. A <fault> answer becomes an XmlRpcFault.
// -----------------------------------------------------------------------------

export class XmlRpcFault extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'XmlRpcFault';
    this.code = code;
  }
}

/** A body that is not an XML-RPC answer (an HTML page, a proxy error...). */
export class XmlRpcFormatError extends Error {
  constructor(message) {
    super(message);
    this.name = 'XmlRpcFormatError';
  }
}

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };

export const escapeXml = (text) => String(text).replace(/[&<>"']/g, (c) => ESCAPES[c]);

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function unescapeXml(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, entity) => {
    if (entity[0] === '#') {
      const code =
        entity[1] === 'x' || entity[1] === 'X'
          ? parseInt(entity.slice(2), 16)
          : parseInt(entity.slice(1), 10);
      return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED[entity.toLowerCase()] ?? whole;
  });
}

function encodeValue(value) {
  if (typeof value === 'string') {
    return `<value><string>${escapeXml(value)}</string></value>`;
  }
  if (typeof value === 'boolean') {
    return `<value><boolean>${value ? 1 : 0}</boolean></value>`;
  }
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) {
      return `<value><double>${value}</double></value>`;
    }
    const type = value >= -(2 ** 31) && value < 2 ** 31 ? 'i4' : 'i8';
    return `<value><${type}>${value}</${type}></value>`;
  }
  if (Array.isArray(value)) {
    return `<value><array><data>${value.map(encodeValue).join('')}</data></array></value>`;
  }
  if (value && typeof value === 'object') {
    const members = Object.entries(value)
      .map(([name, v]) => `<member><name>${escapeXml(name)}</name>${encodeValue(v)}</member>`)
      .join('');
    return `<value><struct>${members}</struct></value>`;
  }
  throw new TypeError(`XML-RPC cannot encode ${value}`);
}

/** The body of a call. */
export function encodeCall(method, params = []) {
  const encoded = params.map((param) => `<param>${encodeValue(param)}</param>`).join('');
  return `<?xml version="1.0"?><methodCall><methodName>${escapeXml(method)}</methodName><params>${encoded}</params></methodCall>`;
}

// --- Parser ---------------------------------------------------------------------

class Reader {
  constructor(text) {
    this.text = text;
    this.at = 0;
  }

  fail(what) {
    throw new XmlRpcFormatError(`${what} at ${this.at}`);
  }

  skipSpace() {
    for (;;) {
      while (this.at < this.text.length && /\s/.test(this.text[this.at])) {
        this.at += 1;
      }
      if (this.text.startsWith('<!--', this.at)) {
        const end = this.text.indexOf('-->', this.at + 4);
        if (end < 0) {
          this.fail('Unclosed comment');
        }
        this.at = end + 3;
      } else {
        return;
      }
    }
  }

  /** The next tag, without consuming it: { name, closing, selfClosing, end }. */
  peekTag() {
    this.skipSpace();
    if (this.text[this.at] !== '<') {
      return null;
    }
    const end = this.text.indexOf('>', this.at);
    if (end < 0) {
      this.fail('Unclosed tag');
    }
    const inner = this.text.slice(this.at + 1, end);
    const closing = inner.startsWith('/');
    const selfClosing = inner.endsWith('/');
    const name = inner.replace(/^\//, '').replace(/\/$/, '').trim().split(/\s/)[0];
    return { name, closing, selfClosing, end: end + 1 };
  }

  open(name) {
    const tag = this.peekTag();
    if (!tag || tag.closing || tag.name !== name) {
      this.fail(`Expected <${name}>`);
    }
    this.at = tag.end;
    return tag;
  }

  close(name) {
    const tag = this.peekTag();
    if (!tag || !tag.closing || tag.name !== name) {
      this.fail(`Expected </${name}>`);
    }
    this.at = tag.end;
  }

  /** Raw text up to the next tag (entities decoded). */
  readText() {
    const end = this.text.indexOf('<', this.at);
    if (end < 0) {
      this.fail('Unexpected end');
    }
    const raw = this.text.slice(this.at, end);
    this.at = end;
    return unescapeXml(raw);
  }

  /** <tag>text</tag> or <tag/>. */
  leaf(name) {
    const tag = this.open(name);
    if (tag.selfClosing) {
      return '';
    }
    const value = this.readText();
    this.close(name);
    return value;
  }

  value() {
    const tag = this.open('value');
    if (tag.selfClosing) {
      return '';
    }
    const start = this.at;
    const inner = this.peekTag();
    if (!inner || inner.closing) {
      // An untyped value is a string (whitespace included).
      this.at = start;
      const text = this.readText();
      this.close('value');
      return text;
    }
    let result;
    switch (inner.name) {
      case 'i4':
      case 'int':
      case 'i8': {
        const text = this.leaf(inner.name).trim();
        if (!/^[+-]?\d+$/.test(text)) {
          this.fail(`Bad integer "${text.slice(0, 20)}"`);
        }
        result = Number(text);
        break;
      }
      case 'boolean': {
        const text = this.leaf('boolean').trim();
        if (text !== '0' && text !== '1') {
          this.fail('Bad boolean');
        }
        result = text === '1';
        break;
      }
      case 'double': {
        result = Number(this.leaf('double').trim());
        if (Number.isNaN(result)) {
          this.fail('Bad double');
        }
        break;
      }
      case 'string':
      case 'base64':
        result = this.leaf(inner.name);
        break;
      case 'nil':
        this.open('nil');
        if (!inner.selfClosing) {
          this.close('nil');
        }
        result = null;
        break;
      case 'array':
        result = this.array();
        break;
      case 'struct':
        result = this.struct();
        break;
      default:
        this.fail(`Unknown type <${inner.name}>`);
    }
    this.close('value');
    return result;
  }

  array() {
    const array = this.open('array');
    const list = [];
    if (array.selfClosing) {
      return list;
    }
    const data = this.open('data');
    if (!data.selfClosing) {
      while (this.peekTag()?.name === 'value' && !this.peekTag().closing) {
        list.push(this.value());
      }
      this.close('data');
    }
    this.close('array');
    return list;
  }

  struct() {
    const struct = this.open('struct');
    const object = {};
    if (struct.selfClosing) {
      return object;
    }
    while (this.peekTag()?.name === 'member' && !this.peekTag().closing) {
      this.open('member');
      const name = this.leaf('name');
      object[name] = this.value();
      this.close('member');
    }
    this.close('struct');
    return object;
  }
}

/**
 * The result of an XML-RPC answer.
 * @throws {XmlRpcFault} on a <fault> answer
 * @throws {XmlRpcFormatError} when the body is not an XML-RPC answer
 */
export function decodeResponse(body) {
  const text = String(body ?? '');
  const reader = new Reader(text);
  reader.skipSpace();
  if (text.startsWith('<?xml', reader.at)) {
    const end = text.indexOf('?>', reader.at);
    if (end < 0) {
      reader.fail('Unclosed declaration');
    }
    reader.at = end + 2;
  }
  reader.open('methodResponse');
  const tag = reader.peekTag();
  if (tag?.name === 'fault' && !tag.closing) {
    reader.open('fault');
    const fault = reader.value();
    reader.close('fault');
    reader.close('methodResponse');
    const code = Number(fault?.faultCode);
    throw new XmlRpcFault(
      Number.isFinite(code) ? code : 0,
      String(fault?.faultString ?? 'fault').slice(0, 200),
    );
  }
  reader.open('params');
  reader.open('param');
  const result = reader.value();
  reader.close('param');
  reader.close('params');
  reader.close('methodResponse');
  return result;
}

// --- Server side, for the fake rTorrent of the tests ---------------------------

/** A call body: { method, params }. */
export function decodeCall(body) {
  const text = String(body ?? '');
  const reader = new Reader(text.replace(/^\s*<\?xml[^>]*\?>/, ''));
  reader.open('methodCall');
  const method = reader.leaf('methodName').trim();
  const params = [];
  const tag = reader.peekTag();
  if (tag?.name === 'params' && !tag.closing) {
    reader.open('params');
    if (!tag.selfClosing) {
      while (reader.peekTag()?.name === 'param' && !reader.peekTag().closing) {
        reader.open('param');
        params.push(reader.value());
        reader.close('param');
      }
      reader.close('params');
    }
  }
  reader.close('methodCall');
  return { method, params };
}

export const encodeResponse = (value) =>
  `<?xml version="1.0"?><methodResponse><params><param>${encodeValue(value)}</param></params></methodResponse>`;

export const encodeFault = (code, message) =>
  `<?xml version="1.0"?><methodResponse><fault>${encodeValue({ faultCode: code, faultString: message })}</fault></methodResponse>`;
