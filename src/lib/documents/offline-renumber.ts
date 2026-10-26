// Renumbering an offline document: the same document at another place in the numbering — another
// global number, session, number in the session or previous document.

import { parseXml } from '../utils/xml-parser.js';
import {
  createOfflineFiscalNumber,
  getOfflineControlNumber,
  getOfflineControlString,
  isPreviousDocumentHashRequired,
} from './offline-fiscal-number.js';

export interface OfflineDocumentRenumbering {
  orderNumber: number; // ORDERNUM
  sessionId: string | number; // OfflineSessionId of the session
  seed: string | number; // OfflineSeed of the session
  localNum: number; // the document's number in the session
  // PREVDOCHASH: SHA-256 of the session's previous document, required from the third document of
  // the session on.
  previousDocumentHash?: string | null;
}

// The offline document with new numbers: ORDERNUM, the offline fiscal number (session, number in
// the session, control number) and PREVDOCHASH change. Date, time, UID, issuer, the body and
// REVOKELASTONLINEDOC stay as they are; the control number uses them as written.
export function renumberOfflineDocument(
  xml: string,
  numbering: OfflineDocumentRenumbering,
): string {
  const orderNumber = Number(numbering?.orderNumber);
  const localNum = Number(numbering?.localNum);
  if (!Number.isInteger(orderNumber) || orderNumber < 1) {
    throw new Error(`Некоректний локальний номер документа: ${numbering?.orderNumber}`);
  }
  if (!Number.isInteger(localNum) || localNum < 1) {
    throw new Error(`Некоректний номер документа в офлайн сесії: ${numbering?.localNum}`);
  }
  if (!hasText(numbering.sessionId) || !hasText(numbering.seed)) {
    throw new Error('Немає даних офлайн сесії (OfflineSessionId, OfflineSeed).');
  }

  const hashRequired = isPreviousDocumentHashRequired(localNum);
  const previousDocumentHash = hashRequired ? text(numbering.previousDocumentHash) : '';
  if (hashRequired && !previousDocumentHash) {
    throw new Error('Невідомий геш попереднього документа офлайн сесії (PREVDOCHASH).');
  }

  const head = readHead(xml);
  const controlNumber = getOfflineControlNumber(
    getOfflineControlString({
      seed: numbering.seed,
      orderDate: text(head.ORDERDATE),
      orderTime: text(head.ORDERTIME),
      orderNumber,
      cashRegisterNum: text(head.CASHREGISTERNUM),
      cashDeskNum: text(head.CASHDESKNUM),
      checkTotal: getDocumentCheckTotal(xml),
      previousDocumentHash: previousDocumentHash || null,
    }),
  );
  return writeOfflineHead(xml, {
    orderNumber,
    fiscalNumber: createOfflineFiscalNumber(numbering.sessionId, localNum, controlNumber),
    previousDocumentHash,
  });
}

// CHECKTOTAL/SUM of a check formatted 0.00, for the control number; null for documents without
// one (Z-reports, OfflineBegin, OfflineEnd, shift opening and closing).
export function getDocumentCheckTotal(xml: string): string | null {
  const sum = parseXml<{ CHECK?: { CHECKTOTAL?: { SUM?: unknown } } }>(xml, {
    keepText: true,
  }).CHECK?.CHECKTOTAL?.SUM;
  if (!hasText(sum)) {
    return null;
  }

  const value = String(sum).trim();
  if (/^-?\d+\.\d{2}$/.test(value)) {
    return value;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(2) : null;
}

interface OfflineDocumentHead {
  ORDERDATE?: string;
  ORDERTIME?: string;
  CASHREGISTERNUM?: string;
  CASHDESKNUM?: string;
}

function readHead(xml: string): OfflineDocumentHead {
  const document = parseXml<{
    CHECK?: { CHECKHEAD?: OfflineDocumentHead };
    ZREP?: { ZREPHEAD?: OfflineDocumentHead };
  }>(xml, { keepText: true });
  const head = document?.CHECK?.CHECKHEAD || document?.ZREP?.ZREPHEAD;
  if (!head) {
    throw new Error('Tax document CHECKHEAD or ZREPHEAD is missing.');
  }
  return head;
}

// Sets ORDERNUM and puts ORDERTAXNUM, OFFLINE and PREVDOCHASH right after VER, their schema
// position, replacing earlier values. Only the header changes.
function writeOfflineHead(
  xml: string,
  values: { orderNumber: number; fiscalNumber: string; previousDocumentHash: string },
): string {
  const headEnd = Math.max(xml.indexOf('</CHECKHEAD>'), xml.indexOf('</ZREPHEAD>'));
  if (headEnd < 0) {
    throw new Error('Tax document CHECKHEAD or ZREPHEAD is missing.');
  }

  let head = xml.slice(0, headEnd);
  const orderNumber = /<ORDERNUM>[^<]*<\/ORDERNUM>/;
  if (!orderNumber.test(head)) {
    throw new Error('Tax document ORDERNUM is missing.');
  }
  head = head.replace(orderNumber, `<ORDERNUM>${values.orderNumber}</ORDERNUM>`);
  for (const name of ['ORDERTAXNUM', 'OFFLINE', 'PREVDOCHASH']) {
    head = head.replace(new RegExp(`<${name}>[^<]*</${name}>\\s*`), '');
  }

  const ver = head.indexOf('</VER>');
  if (ver < 0) {
    throw new Error('Tax document VER is missing.');
  }
  const at = ver + '</VER>'.length;
  const elements =
    `<ORDERTAXNUM>${values.fiscalNumber}</ORDERTAXNUM><OFFLINE>true</OFFLINE>` +
    (values.previousDocumentHash
      ? `<PREVDOCHASH>${values.previousDocumentHash}</PREVDOCHASH>`
      : '');
  return `${head.slice(0, at)}${elements}${head.slice(at)}${xml.slice(headEnd)}`;
}

function hasText(value: unknown): boolean {
  return value !== null && value !== undefined && String(value).trim() !== '';
}

function text(value: unknown): string {
  return hasText(value) ? String(value).trim() : '';
}
