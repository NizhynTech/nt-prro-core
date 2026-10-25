// The server's receipt (квитанція, ticket01.xsd) for a document sent online. It is a generic
// structure: the official example shows every element at once, ERRORCODE next to a fiscal
// number and offline credentials.

import { TaxErrorEnum } from '../errors/tax-error.js';
import { decodeBase64ToBinaryString } from '../utils/base64.js';
import { parseXml } from '../utils/xml-parser.js';

// Values are kept as written: identifiers and the seed can exceed the safe integer range.
export interface TaxTicket {
  UID?: string;
  ORDERDATE?: string;
  ORDERTIME?: string;
  ORDERNUM?: string;
  ORDERTAXNUM?: string;
  OFFLINESESSIONID?: string; // credentials of the next offline session, after shift opening
  OFFLINESEED?: string;
  ERRORCODE?: string;
  ERRORTEXT?: string;
  VER?: string;
}

// The receipt XML from a document response: the signed response (Base64, or text already
// decoded) contains the XML between "<?xml" and "</TICKET>". null when it is not found.
export function extractTicketXml(signedTicket: string): string | null {
  if (!signedTicket) {
    return null;
  }

  const decoded = signedTicket.includes('<?xml')
    ? signedTicket
    : decodeBase64ToBinaryString(signedTicket.replace(/\s/g, ''));
  const start = decoded.indexOf('<?xml');
  const end = decoded.indexOf('</TICKET>');
  if (end < start) {
    return null;
  }

  const ticketXml = decoded.substring(start, end);
  return ticketXml ? `${ticketXml}</TICKET>` : null;
}

// The receipt's fields, as text.
export function parseTaxTicket(ticketXml: string): TaxTicket | null {
  if (!ticketXml) {
    return null;
  }

  const ticket = parseXml<{ TICKET?: TaxTicket }>(ticketXml, {
    keepText: true,
  }).TICKET;
  return ticket && typeof ticket === 'object' ? ticket : null;
}

// The rejection a receipt reports, in the format of the server's error responses ("Код помилки:
// <code> <name>", then the message), or null. A receipt with the fiscal number (ORDERTAXNUM)
// registered the document, so its ERRORCODE is ignored. Without one, a non-zero ERRORCODE means
// the document was not registered.
export function getTaxTicketError(ticket: TaxTicket | null): string | null {
  if (!ticket || hasText(ticket.ORDERTAXNUM)) {
    return null;
  }

  const code = Number(ticket.ERRORCODE);
  if (!hasText(ticket.ERRORCODE) || !Number.isInteger(code) || code === 0) {
    return null;
  }

  const name = TaxErrorEnum[code] || 'TicketError';
  const message = hasText(ticket.ERRORTEXT)
    ? ticket.ERRORTEXT
    : 'Документ не зареєстровано.';
  return `Код помилки: ${code} ${name}\r\n${message}`;
}

// Writes the fiscal number the server assigned (receipt ORDERTAXNUM) into an online document:
// replaces the value the document already has, or adds the element after VER, its place in the
// schema. An empty fiscal number leaves the document unchanged.
export function setDocumentFiscalNumber(
  xml: string,
  fiscalNumber: string,
): string {
  if (!hasText(fiscalNumber)) {
    return xml;
  }

  const element = `<ORDERTAXNUM>${String(fiscalNumber).trim()}</ORDERTAXNUM>`;
  const existing = /<ORDERTAXNUM>[^<]*<\/ORDERTAXNUM>/;
  return existing.test(xml)
    ? xml.replace(existing, () => element)
    : xml.replace('</VER>', () => `</VER>${element}`);
}

function hasText(value: unknown): boolean {
  return value !== null && value !== undefined && String(value).trim() !== '';
}
