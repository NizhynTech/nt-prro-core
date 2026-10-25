import { crc32, encodeUtf8 } from '../utils/crc32.js';
import {
  formatOrderDate,
  formatOrderTime,
  parseOrderDateTime,
} from './document-date.js';
import { createDocumentHead } from './document-head.js';
import { hashTaxDocument } from './document-hash.js';
import {
  createOfflineFiscalNumber,
  getOfflineControlNumber,
  getOfflineControlString,
  isPreviousDocumentHashRequired,
} from './offline-fiscal-number.js';

describe('offline fiscal number', () => {
  it('computes the official control-number test vector', () => {
    const controlString = getOfflineControlString({
      seed: '179625192271939',
      orderDate: '20082020',
      orderTime: '142338',
      orderNumber: 10,
      cashRegisterNum: '4000002411',
      cashDeskNum: 10,
      previousDocumentHash:
        'cdd68bb111f8993f3603f0179341571b35b73a07d5acee9b28fbfb714698e1b3',
    });

    expect(controlString).toBe(
      '179625192271939,20082020,142338,10,4000002411,10,' +
        'cdd68bb111f8993f3603f0179341571b35b73a07d5acee9b28fbfb714698e1b3',
    );
    expect(crc32(encodeUtf8(controlString))).toBe(0xa6bddbbd);
    expect(getOfflineControlNumber(controlString)).toBe(4758);
  });

  it('reverses the CRC bytes like reading its hex as a little-endian integer', () => {
    // The applications' original algorithm: the CRC as 8 hex digits, read as little-endian.
    const reference = (text: string) => {
      const hex = crc32(encodeUtf8(text)).toString(16).padStart(8, '0');
      const bytes = hex.match(/../g).map((pair) => parseInt(pair, 16));
      const value =
        (bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)) >>> 0;
      return value % 10000 || 1;
    };

    for (const text of ['', 'a', '1,2,3', '999,01012026,000000,1,4000000001,1,10.50']) {
      expect(getOfflineControlNumber(text)).toBe(reference(text));
    }
  });

  it('adds the check total before the previous document hash', () => {
    expect(
      getOfflineControlString({
        seed: 1,
        orderDate: '01102026',
        orderTime: '093005',
        orderNumber: 12,
        cashRegisterNum: '4000123456',
        cashDeskNum: 1,
        checkTotal: '10.50',
        previousDocumentHash: 'ab',
      }),
    ).toBe('1,01102026,093005,12,4000123456,1,10.50,ab');
  });

  it('builds the fiscal number and tells when PREVDOCHASH is needed', () => {
    expect(createOfflineFiscalNumber('1234', 3, 4758)).toBe('1234.3.4758');
    expect(isPreviousDocumentHashRequired(1)).toBeFalse();
    expect(isPreviousDocumentHashRequired('2')).toBeFalse();
    expect(isPreviousDocumentHashRequired('3')).toBeTrue();
  });
});

describe('document date and time', () => {
  it('formats the local date and time', () => {
    const date = new Date(2026, 0, 5, 7, 8, 9);
    expect(formatOrderDate(date)).toBe('05012026');
    expect(formatOrderTime(date)).toBe('070809');
  });

  it('parses text and numbers that lost their leading zero', () => {
    const expected = {
      year: '2026',
      month: '10',
      day: '01',
      hours: '09',
      minutes: '30',
      seconds: '05',
    };
    expect(parseOrderDateTime('01102026', '093005')).toEqual(expected);
    expect(parseOrderDateTime(1102026, 93005)).toEqual(expected);
  });
});

describe('createDocumentHead', () => {
  const issuer = {
    tin: '1234567890',
    ipn: '123456789012',
    organizationName: 'Org',
    pointName: 'Point',
    pointAddress: 'Addr',
    cashRegisterNum: 4000123456,
    cashDeskNum: 1,
    cashier: 'Cashier',
  };
  const base = {
    uid: 'u1',
    orderDate: '01102026',
    orderTime: '093005',
    orderNumber: 12,
    issuer,
  };

  it('builds an online header without offline fields', () => {
    expect(
      createDocumentHead({ ...base, docType: 0, docSubType: 1, testing: true }),
    ).toEqual({
      DOCTYPE: 0,
      SUBDOCTYPE: 1,
      UID: 'u1',
      TIN: '1234567890',
      IPN: '123456789012',
      ORGNM: 'Org',
      POINTNM: 'Point',
      POINTADDR: 'Addr',
      ORDERDATE: '01102026',
      ORDERTIME: '093005',
      ORDERNUM: 12,
      CASHDESKNUM: 1,
      CASHREGISTERNUM: '4000123456',
      CASHIER: 'Cashier',
      VER: 1,
      ORDERTAXNUM: null,
      OFFLINE: false,
      PREVDOCHASH: null,
      TESTING: true,
    });
  });

  it('numbers an offline check from the header values, total and hash', () => {
    const head = createDocumentHead({
      ...base,
      docType: 0,
      testing: true,
      offline: {
        sessionId: '777',
        seed: '555',
        localNum: '4',
        previousDocumentHash: 'ab',
        checkTotal: '10.50',
      },
    });

    const controlNumber = getOfflineControlNumber(
      '555,01102026,093005,12,4000123456,1,10.50,ab',
    );
    expect(head.OFFLINE).toBeTrue();
    expect(head.TESTING).toBeTrue();
    expect(head.PREVDOCHASH).toBe('ab');
    expect(head.ORDERTAXNUM).toBe(`777.4.${controlNumber}`);
  });

  it('never marks OfflineBegin or OfflineEnd as testing', () => {
    for (const docType of [102, 103]) {
      const head = createDocumentHead({
        ...base,
        docType,
        testing: true,
        offline: { sessionId: '777', seed: '555', localNum: 1 },
      });
      expect(head.TESTING).toBeNull();
      expect(head.PREVDOCHASH).toBeNull();
      expect(head.ORDERTAXNUM).toBe(
        `777.1.${getOfflineControlNumber('555,01102026,093005,12,4000123456,1')}`,
      );
    }
  });

  it('keeps a given VER', () => {
    expect(createDocumentHead({ ...base, docType: 103, ver: 2 }).VER).toBe(2);
  });
});

describe('hashTaxDocument', () => {
  it('hashes the Windows-1251 bytes', () => {
    expect(hashTaxDocument('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});
