// Base64 helpers without DOM or Node APIs.

const ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const VALUES = new Map<string, number>(
  Array.from(ALPHABET, (char, index) => [char, index] as const),
);

// Decodes Base64 to a string with one character per byte, as atob() does. Whitespace is
// ignored; any other character outside the alphabet throws.
export function decodeBase64ToBinaryString(base64: string): string {
  const value = (base64 || '').replace(/\s/g, '').replace(/={1,2}$/, '');
  if (value.length % 4 === 1) {
    throw new Error('Invalid Base64: wrong length.');
  }

  let result = '';
  let buffer = 0;
  let bits = 0;
  for (const char of value) {
    const digit = VALUES.get(char);
    if (digit === undefined) {
      throw new Error(`Invalid Base64: unexpected character ${char}.`);
    }
    buffer = (buffer << 6) | digit;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      result += String.fromCharCode((buffer >> bits) & 0xff);
    }
  }

  return result;
}

// Number of bytes a Base64 text decodes to.
export function base64ByteLength(base64: string): number {
  const value = (base64 || '').replace(/\s/g, '');
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  return Math.floor((value.length * 3) / 4) - padding;
}
