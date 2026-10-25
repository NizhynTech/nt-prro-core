// Header (CHECKHEAD) of a document, with the offline rules applied
// ("Офлайн документи", "Тестові документи", "Розрахунок гешу офлайн документа").

import { TaxDocumentType } from '../models/tax.model.js';
import {
  createOfflineFiscalNumber,
  getOfflineControlNumber,
  getOfflineControlString,
} from './offline-fiscal-number.js';
import { CHECKHEAD } from './tax-document.model.js';

// Who issues the document: the organization, the point of sale and the register.
export interface DocumentIssuer {
  tin: string;
  ipn?: string;
  organizationName: string;
  pointName: string;
  pointAddress: string;
  cashRegisterNum: string | number; // register fiscal number
  cashDeskNum: number; // register local number
  cashier: string;
}

// Numbering of an offline document. Its presence makes the document offline.
export interface OfflineDocumentNumbering {
  sessionId: string | number; // OfflineSessionId
  seed: string | number; // OfflineSeed
  localNum: number | string; // the document's number in the session
  // PREVDOCHASH. Give it whenever the document must carry it; see
  // isPreviousDocumentHashRequired. null or absent: the document has none.
  previousDocumentHash?: string | null;
  // Total sum formatted 0.00, for a check that has one (part of the control number).
  checkTotal?: string | null;
}

export interface DocumentHeadInput {
  docType: number;
  docSubType?: number;
  uid: string;
  orderDate: string; // DDMMYYYY
  orderTime: string; // HHMMSS
  orderNumber: number; // ORDERNUM
  issuer: DocumentIssuer;
  testing?: boolean;
  ver?: number;
  offline?: OfflineDocumentNumbering | null;
}

// Online documents have no ORDERTAXNUM (the server assigns it) and no PREVDOCHASH. Offline
// documents get OFFLINE, the offline fiscal number and, when given, PREVDOCHASH;
// OfflineBegin and OfflineEnd never carry TESTING.
export function createDocumentHead(input: DocumentHeadInput): CHECKHEAD {
  const issuer = input.issuer;
  const head: CHECKHEAD = {
    DOCTYPE: input.docType,
    SUBDOCTYPE: input.docSubType,
    UID: input.uid,
    TIN: issuer.tin,
    IPN: issuer.ipn,
    ORGNM: issuer.organizationName,
    POINTNM: issuer.pointName,
    POINTADDR: issuer.pointAddress,
    ORDERDATE: input.orderDate,
    ORDERTIME: input.orderTime,
    ORDERNUM: input.orderNumber,
    CASHDESKNUM: issuer.cashDeskNum,
    CASHREGISTERNUM: String(issuer.cashRegisterNum),
    CASHIER: issuer.cashier,
    VER: input.ver ?? 1,
    ORDERTAXNUM: null,
    OFFLINE: false,
    PREVDOCHASH: null,
    TESTING: input.testing,
  };

  const offline = input.offline;
  if (!offline) {
    return head;
  }

  head.OFFLINE = true;
  if (
    Number(input.docType) === TaxDocumentType.OOFFLINE_BEGIN ||
    Number(input.docType) === TaxDocumentType.OFFLINE_END
  ) {
    head.TESTING = null;
  }
  head.PREVDOCHASH = offline.previousDocumentHash || null;

  const controlNumber = getOfflineControlNumber(
    getOfflineControlString({
      seed: offline.seed,
      orderDate: head.ORDERDATE,
      orderTime: head.ORDERTIME,
      orderNumber: head.ORDERNUM,
      cashRegisterNum: head.CASHREGISTERNUM,
      cashDeskNum: head.CASHDESKNUM,
      checkTotal: offline.checkTotal,
      previousDocumentHash: head.PREVDOCHASH,
    }),
  );
  head.ORDERTAXNUM = createOfflineFiscalNumber(
    offline.sessionId,
    offline.localNum,
    controlNumber,
  );
  return head;
}
