import { parseXml } from '../utils/xml-parser.js';
import { ITaxOrder } from './tax-document.model.js';
import { TaxDocumentUtility } from './tax-document.utility.js';

describe('TaxDocumentUtility', () => {
  it('should convert ITaxOrder to xml document', () => {
    const taxOrder: ITaxOrder = {
      orderNumber: 1,
      tin: '1211324343',
      organizationName: 'ФОП Морозенко',
      pointName: '',
      pointAddress: '',
      cashDeskNum: 1,
      cashRegisterNum: '',
      cashRegisterName: '',
      cashier: '',
      CHECKBODY: [
        {
          NAME: 'Avocado',
          CODE: 1,
          PRICE: 100,
          AMOUNT: 1,
          COST: 100,

          // unit: p.unitId,
          LETTERS: 'AB',
          EXCISELABELS: ['11111111', '22222222'],
          UKTZED: '33333333',
          // DISCOUNTTYPE: p.discountType,
          // DISCOUNTPERCENT: p.percentDiscount,
          // DISCOUNTSUM: p.amountDiscount,
        },
        {
          NAME: 'Water',
          CODE: 1,
          PRICE: 50,
          AMOUNT: 1,
          COST: 50,

          // unit: p.unitId,
          LETTERS: 'B',
          EXCISELABELS: ['44444444', '55555555'],
          UKTZED: '66666666',
          // DISCOUNTTYPE: p.discountType,
          // DISCOUNTPERCENT: p.percentDiscount,
          // DISCOUNTSUM: p.amountDiscount,
        },
      ],
    };

    const xmlString = TaxDocumentUtility.getCheck(taxOrder);
    const doc = parseXml<any>(xmlString.xml);

    expect(doc.CHECK).toBeDefined();
    expect(doc.CHECK.CHECKBODY).toBeDefined();
    expect(doc.CHECK.CHECKBODY.ROW).toBeDefined();
    expect(doc.CHECK.CHECKBODY.ROW.length).toBe(2);
    const firstProduct = doc.CHECK.CHECKBODY.ROW[0];

    expect(firstProduct.UKTZED).toBe(33333333);
    expect(firstProduct.EXCISELABELS).toBeDefined();
    expect(firstProduct.EXCISELABELS.ROW.length).toBe(2);
    const firstProductFirstExciseLabel = firstProduct.EXCISELABELS.ROW[0];
    expect(firstProductFirstExciseLabel.EXCISELABEL).toBe(11111111);
  });

  it('should write Decimal2Column SUM values without thousands separators', () => {
    const taxOrder: ITaxOrder = {
      orderNumber: 1,
      tin: '1211324343',
      organizationName: 'ФОП Морозенко',
      pointName: '',
      pointAddress: '',
      cashDeskNum: 1,
      cashRegisterNum: '',
      cashRegisterName: '',
      cashier: '',
      CHECKTOTAL: 1200,
      CHECKPAY: [
        {
          PAYFORMCD: 1,
          PAYFORMNM: 'БЕЗГОТІВКОВА',
          SUM: 1200,
          PAYSYS: [
            {
              NAME: 'VISA CREDIT',
              ACQUIRENM: 'ПриватБанк',
              POSTRANSDATE: '24082026120000',
              POSTRANSNUM: '1,200.00',
              DEVICEID: 'S1K10Y6X',
              EPZDETAILS: '4326********0284',
              AUTHCD: '432355',
              SUM: '1,200.00',
            },
          ],
        },
      ],
      CHECKTAX: [
        {
          TYPE: 0,
          NAME: 'ПДВ',
          LETTER: 'А',
          PRC: 20,
          TURNOVER: 1200,
          SOURCESUM: 1000,
          SUM: 200,
        },
      ],
    };

    const xml = TaxDocumentUtility.getCheck(taxOrder).xml;
    const sumValues = [...xml.matchAll(/<SUM>([^<]*)<\/SUM>/g)].map(
      (match) => match[1]
    );

    expect(xml).toContain('<CHECKTOTAL>');
    expect(sumValues.length).toBeGreaterThan(0);
    expect(sumValues.every((value) => value === '1200.00' || value === '200.00')).toBe(
      true
    );
    expect(sumValues).not.toContain('1,200.00');
    expect(xml).toMatch(
      /<PAYSYS>[\s\S]*<SUM>1200\.00<\/SUM>[\s\S]*<\/PAYSYS>/
    );
  });

  it('should accept localized CHECKTOTAL strings', () => {
    const taxOrder: ITaxOrder = {
      orderNumber: 1,
      tin: '1211324343',
      organizationName: 'ФОП Морозенко',
      pointName: '',
      pointAddress: '',
      cashDeskNum: 1,
      cashRegisterNum: '',
      cashRegisterName: '',
      cashier: '',
      CHECKTOTAL: '1,200.00' as unknown as number,
      CHECKPAY: [
        {
          PAYFORMCD: 0,
          PAYFORMNM: 'ГОТІВКА',
          SUM: '1200,00' as unknown as number,
        },
      ],
    };

    const xml = TaxDocumentUtility.getCheck(taxOrder).xml;

    expect(xml).toContain('<CHECKTOTAL>\r\n<SUM>1200.00</SUM>');
    expect(xml).toContain('<SUM>1200.00</SUM>');
    expect(xml).not.toContain('1,200.00');
    expect(xml).not.toContain('1200,00');
  });

  it('should omit empty Z-report payment and tax collections', () => {
    const report = {
      orderNumber: 1,
      tin: '1211324343',
      organizationName: 'Test',
      pointName: 'Point',
      pointAddress: 'Address',
      cashDeskNum: 1,
      cashRegisterNum: '4000000001',
      cashRegisterName: 'Register',
      cashier: 'Cashier',
      shiftTotals: {
        Real: {
          Sum: 0,
          OrdersCount: 0,
          PayForm: [],
          Tax: [],
        },
        Ret: {
          Sum: 0,
          OrdersCount: 0,
          PayForm: [],
          Tax: [],
        },
        ServiceInput: 0,
        ServiceOutput: 0,
      },
    } as ITaxOrder;

    const xml = TaxDocumentUtility.getZRepo(report).xml;

    expect(xml).not.toContain('<PAYFORMS>');
    expect(xml).not.toContain('<TAXES>');
  });

  it('builds a header-only check with the exact text that is signed and hashed', () => {
    const xml = TaxDocumentUtility.getChekDoc({
      DOCTYPE: 102,
      UID: 'u2',
      TIN: '1234567890',
      IPN: '123456789012',
      ORGNM: 'ТОВ "Ромашка"',
      POINTNM: 'Point',
      POINTADDR: 'Addr',
      ORDERDATE: '01102026',
      ORDERTIME: '093005',
      ORDERNUM: 2,
      CASHDESKNUM: 1,
      CASHREGISTERNUM: '4000123456',
      REVOKELASTONLINEDOC: true,
      CASHIER: "Мар'яна",
      VER: 1,
      ORDERTAXNUM: '1234.1.4321',
      OFFLINE: true,
      TESTING: true,
      PREVDOCHASH: 'ab',
    });

    expect(xml).toBe(
      [
        '<?xml version="1.0" encoding="windows-1251"?>',
        '<CHECK xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="check01.xsd">',
        '<CHECKHEAD>',
        '<DOCTYPE>102</DOCTYPE>',
        '<UID>u2</UID>',
        '<TIN>1234567890</TIN>',
        '<IPN>123456789012</IPN>',
        '<ORGNM>ТОВ &quot;Ромашка&quot;</ORGNM>',
        '<POINTNM>Point</POINTNM>',
        '<POINTADDR>Addr</POINTADDR>',
        '<ORDERDATE>01102026</ORDERDATE>',
        '<ORDERTIME>093005</ORDERTIME>',
        '<ORDERNUM>2</ORDERNUM>',
        '<CASHDESKNUM>1</CASHDESKNUM>',
        '<CASHREGISTERNUM>4000123456</CASHREGISTERNUM>',
        '<REVOKELASTONLINEDOC>true</REVOKELASTONLINEDOC>',
        '<CASHIER>Мар&apos;яна</CASHIER>',
        '<VER>1</VER>',
        '<ORDERTAXNUM>1234.1.4321</ORDERTAXNUM>',
        '<OFFLINE>true</OFFLINE>',
        '<PREVDOCHASH>ab</PREVDOCHASH>',
        '<TESTING>true</TESTING>',
        '</CHECKHEAD>',
        '</CHECK>',
      ].join('\r\n'),
    );
  });

  it('builds Z-report sections from the shift totals', () => {
    const doc = parseXml<any>(
      TaxDocumentUtility.getZRepo({
        uid: 'z1',
        orderNumber: 40,
        tin: '1234567890',
        organizationName: 'Org',
        pointName: 'Point',
        pointAddress: 'Addr',
        cashDeskNum: 1,
        cashRegisterNum: '4000123456',
        cashRegisterName: 'Register',
        cashier: 'Cashier',
        ORDERDATE: '01102026',
        ORDERTIME: '235900',
        shiftTotals: {
          Real: {
            Sum: 150.5,
            OrdersCount: 2,
            PayForm: [{ PayFormCode: 0, PayFormName: 'ГОТІВКА', Sum: 150.5 }],
            Tax: [
              { Type: 0, Name: 'ПДВ', Letter: 'А', Prc: 20, Sign: false, Turnover: 150.5, SourceSum: 125.42, Sum: 25.08 },
            ],
          },
          Ret: { Sum: 0, OrdersCount: 0, PayForm: [], Tax: [] },
          ServiceInput: 100,
          ServiceOutput: 50,
        } as any,
      }).xml,
    );

    expect(doc.ZREP.ZREPHEAD.ORDERNUM).toBe(40);
    expect(doc.ZREP.ZREPREALIZ.SUM).toBe(150.5);
    expect(doc.ZREP.ZREPREALIZ.ORDERSCNT).toBe(2);
    expect(doc.ZREP.ZREPREALIZ.PAYFORMS.ROW.PAYFORMNM).toBe('ГОТІВКА');
    expect(doc.ZREP.ZREPREALIZ.TAXES.ROW.SUM).toBe(25.08);
    expect(doc.ZREP.ZREPRETURN.ORDERSCNT).toBe(0);
    expect(doc.ZREP.ZREPBODY).toEqual({ SERVICEINPUT: 100, SERVICEOUTPUT: 50 });
  });
});
