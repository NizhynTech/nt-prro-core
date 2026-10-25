// XML to object conversion for fiscal documents, without DOM or Node APIs.
//
// The result has the shape applications already use for these documents:
// - the root is a single key: { CHECK: {...} };
// - an element with child elements becomes an object, and a repeated child becomes an array;
// - an element with text only becomes its value;
// - an empty element becomes null;
// - attributes are '@name' keys; text next to attributes or child elements is '#text';
//   CDATA is '#cdata';
// - every string that reads as a number becomes a number ("0012" -> 12, "1.5" -> 1.5).

export type XmlObject = Record<string, any>;

interface XmlElement {
  name: string;
  attributes: Array<[string, string]>;
  children: XmlNode[];
}

type XmlNode =
  | { kind: 'element'; element: XmlElement }
  | { kind: 'text'; value: string }
  | { kind: 'cdata'; value: string };

const NAMED_ENTITIES: Record<string, string> = {
  lt: '<',
  gt: '>',
  amp: '&',
  quot: '"',
  apos: "'",
};

const NON_WHITESPACE = /[^ \f\n\r\t\v]/;
const NAME_END = /[ \f\n\r\t\v/>=<]/;

export function parseXml<T extends XmlObject = XmlObject>(xml: string): T {
  if (typeof xml !== 'string') {
    throw new Error('XML must be a string.');
  }

  const root = new XmlReader(xml).readDocument();
  return { [root.name]: toValue(root) } as T;
}

class XmlReader {
  private _position = 0;

  constructor(private _xml: string) {}

  readDocument(): XmlElement {
    if (this._xml.charCodeAt(0) === 0xfeff) {
      this._position = 1;
    }
    this._skipProlog();
    if (!this._startsWith('<')) {
      this._fail('Root element is missing');
    }

    const root = this._readElement();
    this._skipProlog();
    if (this._position < this._xml.length) {
      this._fail('Unexpected content after the root element');
    }

    return root;
  }

  // Whitespace, processing instructions, comments and DOCTYPE around the root element.
  private _skipProlog(): void {
    for (;;) {
      this._skipWhitespace();
      if (this._startsWith('<?')) {
        this._skipPast('?>');
      } else if (this._startsWith('<!--')) {
        this._skipPast('-->');
      } else if (this._startsWith('<!DOCTYPE')) {
        const subsetStart = this._xml.indexOf('[', this._position);
        const end = this._xml.indexOf('>', this._position);
        if (subsetStart >= 0 && subsetStart < end) {
          this._skipPast(']>');
        } else {
          this._skipPast('>');
        }
      } else {
        return;
      }
    }
  }

  private _readElement(): XmlElement {
    this._expect('<');
    const element: XmlElement = {
      name: this._readName(),
      attributes: [],
      children: [],
    };

    for (;;) {
      this._skipWhitespace();
      if (this._startsWith('/>')) {
        this._position += 2;
        return element;
      }
      if (this._startsWith('>')) {
        this._position++;
        break;
      }

      const name = this._readName();
      this._skipWhitespace();
      this._expect('=');
      this._skipWhitespace();
      const quote = this._xml[this._position];
      if (quote !== '"' && quote !== "'") {
        this._fail(`Attribute ${name} value must be quoted`);
      }
      const end = this._xml.indexOf(quote, this._position + 1);
      if (end < 0) {
        this._fail(`Attribute ${name} value is not closed`);
      }
      element.attributes.push([
        name,
        decodeEntities(this._xml.slice(this._position + 1, end)),
      ]);
      this._position = end + 1;
    }

    for (;;) {
      if (this._position >= this._xml.length) {
        this._fail(`Element ${element.name} is not closed`);
      }

      if (this._startsWith('</')) {
        this._position += 2;
        const name = this._readName();
        if (name !== element.name) {
          this._fail(`Expected </${element.name}> but found </${name}>`);
        }
        this._skipWhitespace();
        this._expect('>');
        return element;
      }

      if (this._startsWith('<!--')) {
        this._skipPast('-->');
      } else if (this._startsWith('<![CDATA[')) {
        const start = this._position + 9;
        const end = this._xml.indexOf(']]>', start);
        if (end < 0) {
          this._fail('CDATA section is not closed');
        }
        element.children.push({
          kind: 'cdata',
          value: this._xml.slice(start, end),
        });
        this._position = end + 3;
      } else if (this._startsWith('<?')) {
        this._skipPast('?>');
      } else if (this._startsWith('<')) {
        element.children.push({ kind: 'element', element: this._readElement() });
      } else {
        const end = this._xml.indexOf('<', this._position);
        const value = decodeEntities(
          this._xml.slice(this._position, end < 0 ? this._xml.length : end),
        );
        this._position = end < 0 ? this._xml.length : end;
        // Adjacent text is one text node.
        const previous = element.children[element.children.length - 1];
        if (previous?.kind === 'text') {
          previous.value += value;
        } else {
          element.children.push({ kind: 'text', value });
        }
      }
    }
  }

  private _readName(): string {
    const start = this._position;
    while (
      this._position < this._xml.length &&
      !NAME_END.test(this._xml[this._position])
    ) {
      this._position++;
    }

    if (this._position === start) {
      this._fail('Name is expected');
    }
    return this._xml.slice(start, this._position);
  }

  private _skipWhitespace(): void {
    while (
      this._position < this._xml.length &&
      !NON_WHITESPACE.test(this._xml[this._position])
    ) {
      this._position++;
    }
  }

  private _skipPast(marker: string): void {
    const end = this._xml.indexOf(marker, this._position);
    if (end < 0) {
      this._fail(`${marker} is expected`);
    }
    this._position = end + marker.length;
  }

  private _expect(char: string): void {
    if (this._xml[this._position] !== char) {
      this._fail(`${char} is expected`);
    }
    this._position++;
  }

  private _startsWith(value: string): boolean {
    return this._xml.startsWith(value, this._position);
  }

  private _fail(message: string): never {
    throw new Error(`Invalid XML at position ${this._position}: ${message}.`);
  }
}

function toValue(element: XmlElement): unknown {
  const nodes = element.children.filter(
    (node) => node.kind !== 'text' || NON_WHITESPACE.test(node.value),
  );
  if (!element.attributes.length && !nodes.length) {
    return null;
  }

  const result: XmlObject = {};
  for (const [name, value] of element.attributes) {
    result[`@${name}`] = toScalar(value);
  }

  if (nodes.some((node) => node.kind === 'element')) {
    for (const node of nodes) {
      if (node.kind === 'text') {
        result['#text'] = toScalar(node.value);
      } else if (node.kind === 'cdata') {
        result['#cdata'] = toScalar(node.value);
      } else {
        const name = node.element.name;
        const value = toValue(node.element);
        if (!(name in result)) {
          result[name] = value;
        } else if (Array.isArray(result[name])) {
          result[name].push(value);
        } else {
          result[name] = [result[name], value];
        }
      }
    }
    return result;
  }

  const textOf = (kind: 'text' | 'cdata') =>
    nodes
      .map((node) => (node.kind === kind ? node.value : ''))
      .join('');
  const text = textOf('text');
  if (text) {
    if (!element.attributes.length) {
      return toScalar(text);
    }
    result['#text'] = toScalar(text);
    return result;
  }

  result['#cdata'] = toScalar(textOf('cdata'));
  return result;
}

function toScalar(value: string): string | number {
  return isNaN(+value) ? value : +value;
}

function decodeEntities(value: string): string {
  if (value.indexOf('&') < 0) {
    return value;
  }

  return value.replace(
    /&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z]+);|&/g,
    (match: string, entity: string | undefined) => {
      if (!entity) {
        throw new Error('Invalid XML: unescaped & in text.');
      }
      if (entity[0] === '#') {
        const code =
          entity[1] === 'x' || entity[1] === 'X'
            ? parseInt(entity.slice(2), 16)
            : parseInt(entity.slice(1), 10);
        return String.fromCodePoint(code);
      }
      const char = NAMED_ENTITIES[entity];
      if (char === undefined) {
        throw new Error(`Invalid XML: unknown entity ${match}.`);
      }
      return char;
    },
  );
}
