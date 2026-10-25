import { TaxError, TaxErrorEnum, isDocumentRejectedByServer } from '../errors/tax-error.js';
import { validateOfflineSessionStart } from '../offline/offline-session-start.js';
import { TransactionsRegistrarStateResponse } from '../models/tax.model.js';
import { parseXml } from '../utils/xml-parser.js';
import {
  extractTicketXml,
  getTaxTicketError,
  parseTaxTicket,
  setDocumentFiscalNumber,
} from './tax-ticket.js';
import {
  getDocumentVerificationUrl,
  getDocumentVerificationUrlFromXml,
} from './verification-link.js';

const ticketXml =
  '<?xml version="1.0" encoding="windows-1251"?><TICKET><UID>u1</UID>' +
  '<ORDERDATE>01102026</ORDERDATE><ORDERTIME>093005</ORDERTIME><ORDERNUM>12</ORDERNUM>' +
  '<ORDERTAXNUM>0400012345</ORDERTAXNUM><OFFLINESESSIONID>123456789012345678</OFFLINESESSIONID>' +
  '<OFFLINESEED>987654321098765432</OFFLINESEED><ERRORCODE>0</ERRORCODE><VER>1</VER></TICKET>';

describe('server receipt', () => {
  it('finds the receipt XML in a Base64 signed response', () => {
    const signed = btoa('0\u0082signature-bytes' + ticketXml + 'more-signature');
    expect(extractTicketXml(signed)).toBe(ticketXml);
    expect(extractTicketXml(ticketXml)).toBe(ticketXml);
    expect(extractTicketXml('')).toBeNull();
  });

  it('keeps every receipt value as written', () => {
    expect(parseTaxTicket(ticketXml)).toEqual({
      UID: 'u1',
      ORDERDATE: '01102026',
      ORDERTIME: '093005',
      ORDERNUM: '12',
      ORDERTAXNUM: '0400012345',
      OFFLINESESSIONID: '123456789012345678',
      OFFLINESEED: '987654321098765432',
      ERRORCODE: '0',
      VER: '1',
    });
    expect(parseTaxTicket('<TICKET/>')).toBeNull();
  });

  it('writes the assigned fiscal number after VER, or replaces the one already there', () => {
    const xml = '<CHECK><CHECKHEAD><VER>1</VER><TESTING>true</TESTING></CHECKHEAD></CHECK>';
    const numbered = setDocumentFiscalNumber(xml, '4000001');
    expect(numbered).toBe(
      '<CHECK><CHECKHEAD><VER>1</VER><ORDERTAXNUM>4000001</ORDERTAXNUM>' +
        '<TESTING>true</TESTING></CHECKHEAD></CHECK>',
    );
    expect(setDocumentFiscalNumber(numbered, '4000002')).toBe(
      numbered.replace('4000001', '4000002'),
    );
    expect(setDocumentFiscalNumber(xml, '')).toBe(xml);
    expect(setDocumentFiscalNumber(xml, undefined)).toBe(xml);
  });

  it('reports ERRORCODE only for a receipt without a fiscal number', () => {
    const rejected = parseTaxTicket(
      '<TICKET><UID>u1</UID><ORDERNUM>12</ORDERNUM><ERRORCODE>7</ERRORCODE>' +
        '<ERRORTEXT>Невірний локальний номер чека, очікується 15</ERRORTEXT><VER>1</VER></TICKET>',
    );
    const error = getTaxTicketError(rejected);
    expect(error).toBe(
      'Код помилки: 7 CheckLocalNumberInvalid\r\nНевірний локальний номер чека, очікується 15',
    );
    expect(new TaxError(error).getNextCheckLocalNumberFromError()).toBe(15);

    // The official example shows ERRORCODE next to a fiscal number: the data is used.
    expect(
      getTaxTicketError({ ...parseTaxTicket(ticketXml), ERRORCODE: '1' }),
    ).toBeNull();
    expect(getTaxTicketError({ ...rejected, ERRORCODE: '0' })).toBeNull();
    expect(getTaxTicketError({ UID: 'u1', ORDERNUM: '12' })).toBeNull();
    expect(getTaxTicketError({ ERRORCODE: '1' })).toBe(
      'Код помилки: 1 TicketError\r\nДокумент не зареєстровано.',
    );
    expect(getTaxTicketError(null)).toBeNull();
  });
});

describe('TaxError', () => {
  it('reads the code, the name and the message', () => {
    const error = new TaxError(
      'Код помилки: 7 CheckLocalNumberInvalid\r\nНевірний локальний номер чека, очікується 15',
    );
    expect(error.error).toBe(TaxErrorEnum.CheckLocalNumberInvalid);
    expect(error.errorNumberCode).toBe(7);
    expect(error.text).toBe('Невірний локальний номер чека, очікується 15');
    expect(error.getNextCheckLocalNumberFromError()).toBe(15);
  });

  it('treats a one-line text as a server error', () => {
    const error = new TaxError('Service unavailable');
    expect(error.error).toBe(TaxErrorEnum.ServerError);
    expect(error.text).toBe('Service unavailable');
    expect(error.getNextCheckLocalNumberFromError()).toBeUndefined();
  });

  it('classifies failed sends', () => {
    expect(isDocumentRejectedByServer(400)).toBeTrue();
    expect(isDocumentRejectedByServer(499)).toBeTrue();
    expect(isDocumentRejectedByServer(500)).toBeFalse();
    expect(isDocumentRejectedByServer(0)).toBeFalse();
  });
});

describe('document verification link', () => {
  const base = 'https://cabinet.tax.gov.ua/cashregs/check';

  it('converts the document date and time', () => {
    expect(
      getDocumentVerificationUrl(base, {
        registerFiscalNumber: '4000123456',
        fiscalNumber: '4000001',
        orderDate: '01102026',
        orderTime: '093005',
        sum: '10.50',
      }),
    ).toBe(`${base}?fn=4000123456&id=4000001&date=20261001&time=093005&sm=10.50`);
  });

  it('reads a check XML and keeps its values as written', () => {
    const xml =
      '<CHECK><CHECKHEAD><ORDERDATE>01102026</ORDERDATE><ORDERTIME>093005</ORDERTIME>' +
      '<CASHREGISTERNUM>4000123456</CASHREGISTERNUM><ORDERTAXNUM>0400001</ORDERTAXNUM>' +
      '</CHECKHEAD><CHECKTOTAL><SUM>10.50</SUM></CHECKTOTAL></CHECK>';
    expect(getDocumentVerificationUrlFromXml(base, xml)).toBe(
      `${base}?fn=4000123456&id=0400001&date=20261001&time=093005&sm=10.50`,
    );
  });

  it('leaves out the sum for a Z-report, which has none', () => {
    const xml =
      '<ZREP><ZREPHEAD><ORDERDATE>01102026</ORDERDATE><ORDERTIME>235900</ORDERTIME>' +
      '<CASHREGISTERNUM>4000123456</CASHREGISTERNUM><ORDERTAXNUM>4000009</ORDERTAXNUM>' +
      '</ZREPHEAD></ZREP>';
    expect(getDocumentVerificationUrlFromXml(base, xml)).toBe(
      `${base}?fn=4000123456&id=4000009&date=20261001&time=235900`,
    );
    expect(getDocumentVerificationUrlFromXml(base, '<OTHER/>')).toBeNull();
  });
});

describe('validateOfflineSessionStart', () => {
  const ready = {
    OfflineSupported: true,
    OfflineSessionId: '1',
    OfflineSeed: '2',
    OfflineNextLocalNum: '1',
    OfflineSessionDuration: '60',
    OfflineSessionsMonthlyDuration: '600',
  } as TransactionsRegistrarStateResponse;

  it('allows a register with offline credentials and time left', () => {
    expect(() => validateOfflineSessionStart(ready)).not.toThrow();
  });

  it('rejects each blocking state with its reason', () => {
    const cases: Array<[Partial<TransactionsRegistrarStateResponse> & { Offline?: boolean }, string]> = [
      [{ Closed: true }, 'Реєстрацію ПРРО скасовано: офлайн режим недоступний.'],
      [{ OfflineSupported: false }, 'Каса не підтримує офлайн режим.'],
      [{ OfflineSeed: null }, 'Каса не підтримує офлайн режим.'],
      [{ Offline: true }, 'Каса вже працює в офлайн режимі.'],
      [
        { OfflineNextLocalNum: '3' },
        'Неможливо почати нову офлайн сесію, поки не надіслано попередній офлайн пакет.',
      ],
      [{ OfflineSessionDuration: String(36 * 60) }, 'Перевищено максимальну тривалість офлайн сесії.'],
      [
        { OfflineSessionsMonthlyDuration: String(168 * 60) },
        'Перевищено максимальну тривалість офлайн сесій за місяць.',
      ],
    ];
    for (const [change, message] of cases) {
      expect(() => validateOfflineSessionStart({ ...ready, ...change })).toThrowError(
        message,
      );
    }
  });
});

describe('parseXml keepText', () => {
  it('keeps the named values, or all values, as text', () => {
    const xml = '<A x="007"><B>0012</B><C>0012</C></A>';
    expect(parseXml(xml)).toEqual({ A: { '@x': 7, B: 12, C: 12 } });
    expect(parseXml(xml, { keepText: ['B', '@x'] })).toEqual({
      A: { '@x': '007', B: '0012', C: 12 },
    });
    expect(parseXml(xml, { keepText: true })).toEqual({
      A: { '@x': '007', B: '0012', C: '0012' },
    });
  });
});
