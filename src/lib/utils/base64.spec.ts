import { base64ByteLength, decodeBase64ToBinaryString } from './base64.js';

describe('decodeBase64ToBinaryString', () => {
  it('decodes like atob, for every padding length and all byte values', () => {
    const bytes = Array.from({ length: 256 }, (_, index) =>
      String.fromCharCode(index),
    ).join('');
    for (const text of ['', 'a', 'ab', 'abc', 'abcd', bytes]) {
      const encoded = btoa(text);
      expect(decodeBase64ToBinaryString(encoded)).toBe(atob(encoded));
    }
  });

  it('ignores whitespace', () => {
    expect(decodeBase64ToBinaryString(' eyJh\nIjoxfQ== ')).toBe('{"a":1}');
  });

  it('rejects text that is not Base64', () => {
    expect(() => decodeBase64ToBinaryString('{"a":1}')).toThrowError(
      /Invalid Base64/,
    );
    expect(() => decodeBase64ToBinaryString('abcde')).toThrowError(
      /Invalid Base64/,
    );
  });
});

describe('base64ByteLength', () => {
  it('counts decoded bytes', () => {
    expect(base64ByteLength(btoa('a'))).toBe(1);
    expect(base64ByteLength(btoa('ab'))).toBe(2);
    expect(base64ByteLength(btoa('abc'))).toBe(3);
  });
});
