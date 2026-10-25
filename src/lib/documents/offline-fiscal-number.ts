// Fiscal number of an offline document: <OfflineSessionId>.<number in session>.<control number>
// ("Структура фіскального номера офлайн документа", "Розрахунок контрольного числа").

import { crc32, encodeUtf8 } from '../utils/crc32.js';

export interface OfflineControlInput {
  seed: string | number; // OfflineSeed of the session
  orderDate: string; // ORDERDATE as written in the document
  orderTime: string; // ORDERTIME as written in the document
  orderNumber: number | string; // ORDERNUM, the global local number
  cashRegisterNum: string | number; // CASHREGISTERNUM, the register's fiscal number
  cashDeskNum: number | string; // CASHDESKNUM, the register's local number
  checkTotal?: string | null; // total sum formatted 0.00, for checks that have one
  previousDocumentHash?: string | null; // PREVDOCHASH, when the document contains it
}

// The string the control number is computed from: the fields joined with commas, the check
// total and the previous document hash only when present.
export function getOfflineControlString(input: OfflineControlInput): string {
  const parts = [
    input.seed,
    input.orderDate,
    input.orderTime,
    input.orderNumber,
    input.cashRegisterNum,
    input.cashDeskNum,
  ].map(String);
  if (input.checkTotal) {
    parts.push(input.checkTotal);
  }
  if (input.previousDocumentHash) {
    parts.push(input.previousDocumentHash);
  }
  return parts.join(',');
}

// The standard CRC-32 of the control string with its byte order reversed, modulo 10000;
// 1 when that is 0. The official vector
// "179625192271939,20082020,142338,10,4000002411,10,cdd68bb1…" gives 4758.
export function getOfflineControlNumber(controlString: string): number {
  const crc = crc32(encodeUtf8(controlString));
  const reversed =
    (((crc & 0xff) << 24) |
      (((crc >>> 8) & 0xff) << 16) |
      (((crc >>> 16) & 0xff) << 8) |
      (crc >>> 24)) >>>
    0;
  return reversed % 10000 || 1;
}

export function createOfflineFiscalNumber(
  offlineSessionId: string | number,
  offlineLocalNum: number | string,
  controlNumber: number,
): string {
  return `${offlineSessionId}.${offlineLocalNum}.${controlNumber}`;
}

// PREVDOCHASH is written from the third document of an offline session: OfflineBegin (1) and
// the document after it (2) have none.
export function isPreviousDocumentHashRequired(
  offlineLocalNum: number | string,
): boolean {
  return Number(offlineLocalNum) > 2;
}
