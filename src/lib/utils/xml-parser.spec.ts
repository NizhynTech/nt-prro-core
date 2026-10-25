import { parseXml } from './xml-parser.js';

describe('parseXml', () => {
  it('reads a fiscal check into the usual object shape', () => {
    const xml =
      '<?xml version="1.0" encoding="windows-1251"?>\n' +
      '<CHECK xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="check01.xsd">\n' +
      '  <CHECKHEAD>\n' +
      '    <DOCTYPE>0</DOCTYPE>\n' +
      '    <UID>9a1c2a3b-0000-4000-8000-000000000001</UID>\n' +
      '    <ORDERDATE>01102026</ORDERDATE>\n' +
      '    <ORDERTIME>093005</ORDERTIME>\n' +
      '    <ORDERNUM>12</ORDERNUM>\n' +
      '    <ORDERTAXNUM>4321.3.5678</ORDERTAXNUM>\n' +
      '    <CASHIER>Іваненко Ґанна</CASHIER>\n' +
      '    <OFFLINE>true</OFFLINE>\n' +
      '    <REVOKED/>\n' +
      '  </CHECKHEAD>\n' +
      '  <CHECKTOTAL><SUM>10.50</SUM></CHECKTOTAL>\n' +
      '  <CHECKPAY>\n' +
      '    <ROW ROWNUM="1"><PAYFORMCD>0</PAYFORMCD><PAYFORMNM>ГОТІВКА</PAYFORMNM><SUM>10.50</SUM></ROW>\n' +
      '  </CHECKPAY>\n' +
      '  <CHECKBODY>\n' +
      '    <ROW ROWNUM="1"><NAME>Кава</NAME></ROW>\n' +
      '    <ROW ROWNUM="2"><NAME>Чай</NAME></ROW>\n' +
      '  </CHECKBODY>\n' +
      '</CHECK>';

    expect(parseXml(xml)).toEqual({
      CHECK: {
        '@xmlns:xsi': 'http://www.w3.org/2001/XMLSchema-instance',
        '@xsi:noNamespaceSchemaLocation': 'check01.xsd',
        CHECKHEAD: {
          DOCTYPE: 0,
          UID: '9a1c2a3b-0000-4000-8000-000000000001',
          ORDERDATE: 1102026,
          ORDERTIME: 93005,
          ORDERNUM: 12,
          ORDERTAXNUM: '4321.3.5678',
          CASHIER: 'Іваненко Ґанна',
          OFFLINE: 'true',
          REVOKED: null,
        },
        CHECKTOTAL: { SUM: 10.5 },
        CHECKPAY: {
          ROW: { '@ROWNUM': 1, PAYFORMCD: 0, PAYFORMNM: 'ГОТІВКА', SUM: 10.5 },
        },
        CHECKBODY: {
          ROW: [
            { '@ROWNUM': 1, NAME: 'Кава' },
            { '@ROWNUM': 2, NAME: 'Чай' },
          ],
        },
      },
    });
  });

  it('reads a Z-report root', () => {
    expect(
      parseXml('<ZREP><ZREPHEAD><ORDERNUM>5</ORDERNUM></ZREPHEAD></ZREP>'),
    ).toEqual({ ZREP: { ZREPHEAD: { ORDERNUM: 5 } } });
  });

  it('decodes entities, text with attributes and CDATA', () => {
    expect(
      parseXml(
        '<A><N>ТОВ &quot;Ромашка&quot; &amp; Co &#1040;&#x0411;</N>' +
          '<T kind="x">text</T><C><![CDATA[<raw>]]></C><E>   </E><!-- note --></A>',
      ),
    ).toEqual({
      A: {
        N: 'ТОВ "Ромашка" & Co АБ',
        T: { '@kind': 'x', '#text': 'text' },
        C: { '#cdata': '<raw>' },
        E: null,
      },
    });
  });

  it('keeps an empty first element when the element repeats', () => {
    expect(parseXml('<A><ROW/><ROW>1</ROW></A>')).toEqual({
      A: { ROW: [null, 1] },
    });
  });

  it('rejects malformed XML', () => {
    expect(() => parseXml('not xml')).toThrowError(/Invalid XML/);
    expect(() => parseXml('<A><B></A>')).toThrowError(/Invalid XML/);
    expect(() => parseXml('<A>1 & 2</A>')).toThrowError(/Invalid XML/);
    expect(() => parseXml('<A/><B/>')).toThrowError(/Invalid XML/);
  });
});
