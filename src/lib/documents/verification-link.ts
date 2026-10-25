// Link to check a fiscal document on the tax office site (the receipt's QR code):
// <baseUrl>?fn=<register>&id=<document fiscal number>&date=YYYYMMDD&time=HHMMSS&sm=<sum>

import { parseXml } from '../utils/xml-parser.js';
import { parseOrderDateTime } from './document-date.js';

export interface DocumentVerificationLinkInput {
  registerFiscalNumber: string | number; // fn: CASHREGISTERNUM
  fiscalNumber: string | number; // id: ORDERTAXNUM
  orderDate: string | number; // ORDERDATE, DDMMYYYY
  orderTime: string | number; // ORDERTIME, HHMMSS
  sum?: string | number | null; // sm: the document total, written as given
}

export function getDocumentVerificationUrl(
  baseUrl: string,
  input: DocumentVerificationLinkInput,
): string {
  const parts = parseOrderDateTime(input.orderDate, input.orderTime);
  const url =
    `${baseUrl}?fn=${input.registerFiscalNumber}&id=${input.fiscalNumber}` +
    `&date=${parts.year}${parts.month}${parts.day}` +
    `&time=${parts.hours}${parts.minutes}${parts.seconds}`;
  // A Z-report has no total in its header: the link then has no sm.
  return input.sum === null || input.sum === undefined
    ? url
    : `${url}&sm=${input.sum}`;
}

// The link for a check or Z-report XML. null when the XML is neither.
export function getDocumentVerificationUrlFromXml(
  baseUrl: string,
  xml: string,
): string | null {
  const doc = parseXml<any>(xml, {
    keepText: ['ORDERTAXNUM', 'CASHREGISTERNUM', 'SUM', 'ORDERDATE', 'ORDERTIME'],
  });
  const head = doc?.CHECK?.CHECKHEAD || doc?.ZREP?.ZREPHEAD;
  if (!head) {
    return null;
  }

  return getDocumentVerificationUrl(baseUrl, {
    registerFiscalNumber: head.CASHREGISTERNUM,
    fiscalNumber: head.ORDERTAXNUM,
    orderDate: head.ORDERDATE,
    orderTime: head.ORDERTIME,
    sum: doc.CHECK ? doc.CHECK.CHECKTOTAL?.SUM : head.SUM,
  });
}
