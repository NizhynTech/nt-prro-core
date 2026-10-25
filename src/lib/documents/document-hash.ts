import { sha256 } from 'js-sha256';
import { encodeWin1251 } from '../utils/win1251.js';

// SHA-256 (hex) of a document's Windows-1251 bytes: the value of the next offline document's
// PREVDOCHASH.
export function hashTaxDocument(xml: string): string {
  return sha256(encodeWin1251(xml));
}
