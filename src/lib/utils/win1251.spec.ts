import { encodeWin1251 } from './win1251.js';

describe('encodeWin1251', () => {
  it('encodes ASCII and Ukrainian letters', () => {
    expect(Array.from(encodeWin1251('A1 ІіЇїЄєҐґ Яя'))).toEqual([
      0x41, 0x31, 0x20, 0xb2, 0xb3, 0xaf, 0xbf, 0xaa, 0xba, 0xa5, 0xb4, 0x20,
      0xdf, 0xff,
    ]);
  });

  it('encodes punctuation from the upper half of the code page', () => {
    expect(Array.from(encodeWin1251('«№»—…'))).toEqual([
      0xab, 0xb9, 0xbb, 0x97, 0x85,
    ]);
  });

  it('writes the hryvnia sign as 0xB4', () => {
    expect(Array.from(encodeWin1251('₴'))).toEqual([0xb4]);
  });

  it('rejects characters the code page does not have', () => {
    expect(() => encodeWin1251('€✓')).toThrowError(
      "Character ✓ isn't supported by win1251!",
    );
  });
});
