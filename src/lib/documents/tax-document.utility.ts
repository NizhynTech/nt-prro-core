// Builds fiscal document XML: checks (check01.xsd), Z-reports (zrep01.xsd), and header-only
// checks (shift opening and closing, offline session begin and end). The output is the text
// that is encoded in Windows-1251, signed and sent; it must not change without a reason.

import {
  CHECKHEAD,
  ICheckDocument,
  ICheckPay,
  ICheckProduct,
  ICheckTax,
  ITaxOrder,
} from './tax-document.model.js';
import { ShiftTotals } from '../models/tax.model.js';

class CheckModel {
  private _xmlDeclaration = '<?xml version="1.0" encoding="windows-1251"?>';

  constructor() {}

  getCheck(check: ITaxOrder): ICheckDocument {
    let xml = '';
    xml += this._xmlDeclaration + '\r\n';
    xml +=
      '<CHECK xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="check01.xsd">' +
      '\r\n';
    xml +=
      this._getCheckHead(
        check.documentType,
        check.documentSubType,
        check.uid,
        check.orderNumber,
        check.tin,
        check.ipn,
        check.organizationName,
        check.pointName,
        check.pointAddress,
        check.cashDeskNum,
        check.cashRegisterNum,
        check.ORDERSTORNUM,
        check.cashier,
        check.ORDERDATE,
        check.ORDERTIME,
        check.ORDERTAXNUM,
        check.ORDERRETNUM,
        check.REVOKELASTONLINEDOC,
        check.PREVDOCHASH,
        check.testing,
        check.offline
      ) + '\r\n';

    xml +=
      this._getCheckTotalXml(
        check.CHECKTOTAL,
        check.DISCOUNTSUM,
        check.RNDSUM,
        check.NORNDSUM
      ) + '\r\n';

    if (check.PROVIDED > 0 && check.REMAINS > 0) {
      const checkPay = check.CHECKPAY[0];
      checkPay.PROVIDED = check.PROVIDED;
      checkPay.REMAINS = check.REMAINS;
    }

    xml += this._getCheckPayXml(check.CHECKPAY) + '\r\n';
    xml += this._getCheckTaxXml(check.CHECKTAX) + '\r\n';
    xml += this._getCheckBodyXml(check.CHECKBODY) + '\r\n';

    xml += '</CHECK>';
    return {
      uid: check.uid,
      orderNumber: check.orderNumber,
      xml,
    };
  }

  getZRepoDocument(report: ITaxOrder): ICheckDocument {
    const xml = `${this._xmlDeclaration}
<ZREP xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="zrep01.xsd">
    ${this._getZRepoHead(
      report.uid,
      report.orderNumber,
      report.tin,
      report.ipn,
      report.organizationName,
      report.pointName,
      report.pointAddress,
      report.cashDeskNum,
      report.cashRegisterNum,
      report.cashier,
      report.ORDERDATE,
      report.ORDERTIME,
      report.ORDERTAXNUM,
      report.PREVDOCHASH,
      report.testing,
      report.offline
    )}
    ${this._getZRepoRealizXml(report.shiftTotals)}   
    ${this._getZRepoReturnXml(report.shiftTotals)}    
    ${this._getZRepoBodyXml(report.shiftTotals)}
</ZREP>`;

    return {
      uid: report.uid,
      orderNumber: report.orderNumber,
      xml,
    };
  }

  private _getCheckHead(
    docType: number,
    documentSubType: number,
    uid: string,
    orderNumber: number,
    tin: string,
    ipn: string,
    organizationName: string,
    pointName: string,
    pointAddress: string,
    cashDeskNum: number,
    cashRegisterNum: string,
    ORDERSTORNUM: string,
    cashier: string,
    ORDERDATE: string,
    ORDERTIME: string,
    ORDERTAXNUM: string,
    ORDERRETNUM: string,
    REVOKELASTONLINEDOC: boolean,
    PREVDOCHASH: string,
    testing: boolean,
    offline: boolean
  ) {
    let checkHead = '<CHECKHEAD>' + '\r\n';

    checkHead += this._getDocTypeXml(docType);
    checkHead += this._getDocSubTypeXml(documentSubType);
    checkHead += this._getUidXml(uid);
    checkHead += this._getTinXml(tin);
    checkHead += this._getIpnXml(ipn);
    checkHead += this._getOrgmnXml(organizationName);
    checkHead += this._getPointnmXml(pointName);
    checkHead += this._getPointAddrXml(pointAddress);
    checkHead += this._getOrderDateXml(ORDERDATE);
    checkHead += this._getOrderTimeXml(ORDERTIME);
    checkHead += this._getOrderNumberXml(orderNumber);
    checkHead += this._getCashDeskNumXml(cashDeskNum);
    checkHead += this._getCashRegisterNumXml(cashRegisterNum);

    if (ORDERSTORNUM) {
      checkHead += `<ORDERSTORNUM>${ORDERSTORNUM}</ORDERSTORNUM>`;
    }

    checkHead += this._getOrderRetNumXml(ORDERRETNUM);
    checkHead += this._getRevokeLastOnlineDocXml(REVOKELASTONLINEDOC);
    checkHead += this._getCashierXml(cashier);
    checkHead += this._getVerXml();
    checkHead += this._getOrderTaxNumXml(ORDERTAXNUM);
    checkHead += this._getOfflineXml(offline);
    checkHead += this._getPrevDocHashXml(PREVDOCHASH);
    checkHead += this._getTestingXml(testing);
    checkHead += '</CHECKHEAD>';
    return checkHead;
  }

  private _getZRepoHead(
    uid: string,
    orderNumber: number,
    tin: string,
    ipn: string,
    organizationName: string,
    pointName: string,
    pointAddress: string,
    cashDeskNum: number,
    cashRegisterNum: string,
    cashier: string,
    ORDERDATE: string,
    ORDERTIME: string,
    ORDERTAXNUM: string,
    PREVDOCHASH: string,
    testing: boolean,
    offline: boolean
  ) {
    return `<ZREPHEAD>
    ${this._getUidXml(uid)}
    ${this._getTinXml(tin)}
    ${this._getIpnXml(ipn)}
    ${this._getOrgmnXml(organizationName)}
    ${this._getPointnmXml(pointName)}
    ${this._getPointAddrXml(pointAddress)}
    ${this._getOrderDateXml(ORDERDATE)}
    ${this._getOrderTimeXml(ORDERTIME)}
    ${this._getOrderNumberXml(orderNumber)}
    ${this._getCashDeskNumXml(cashDeskNum)}
    ${this._getCashRegisterNumXml(cashRegisterNum)}
    ${this._getCashierXml(cashier)}
    ${this._getVerXml()}
    ${this._getOrderTaxNumXml(ORDERTAXNUM)}
    ${this._getOfflineXml(offline)}
    ${this._getPrevDocHashXml(PREVDOCHASH)}
    ${this._getTestingXml(testing)}
</ZREPHEAD>`;
  }

  private _getCheckTotalXml(
    total: number,
    discount: number,
    RNDSUM: number,
    NORNDSUM: number
  ) {
    let totalXml = '';
    if (total === null || total === undefined) {
      return totalXml;
    }

    const totalAmount = this._parseDecimal(total);
    if (!(totalAmount == 0 || totalAmount > 0)) {
      return totalXml;
    }

    totalXml += '<CHECKTOTAL>\r\n';
    totalXml += `<SUM>${this._toDecimal(totalAmount)}</SUM>`;

    if (!(RNDSUM == null || isNaN(RNDSUM))) {
      totalXml += `<RNDSUM>${this._toDecimal(RNDSUM)}</RNDSUM>`;
    }
    if (!(NORNDSUM == null || isNaN(NORNDSUM))) {
      totalXml += `<NORNDSUM>${this._toDecimal(NORNDSUM)}</NORNDSUM>`;
    }

    if (discount > 0) {
      totalXml += `<DISCOUNTSUM>${this._toDecimal(discount)}</DISCOUNTSUM>`;
    }

    totalXml += '\r\n';
    totalXml += '</CHECKTOTAL>';
    return totalXml;
  }

  private _getCheckPayXml(checkPay: ICheckPay[]) {
    if (!checkPay) {
      return ``;
    }

    let checkpay = '<CHECKPAY>\r\n';
    const rows = `${checkPay
      .map((cp, i) => {
        let row = `<ROW ROWNUM="${i + 1}">`;
        row += `<PAYFORMCD>${cp.PAYFORMCD}</PAYFORMCD>`;
        row += `<PAYFORMNM>${this._escapeCharacters(cp.PAYFORMNM)}</PAYFORMNM>`;
        row += `<SUM>${this._toDecimal(cp.SUM)}</SUM>`;

        if (cp.PROVIDED > 0) {
          row += `<PROVIDED>${this._toDecimal(cp.PROVIDED)}</PROVIDED>`;
        }

        if (cp.REMAINS > 0) {
          row += `<REMAINS>${this._toDecimal(cp.REMAINS)}</REMAINS>`;
        }

        if (cp.PAYSYS && cp.PAYSYS.length) {
          const paySys = `<PAYSYS>${cp.PAYSYS.map((ps, ii) => {
            let psRow = `<ROW ROWNUM="${ii + 1}">`;
            if (ps.NAME) {
              psRow += `<NAME>${ps.NAME}</NAME>`;
            }
            if (ps.ACQUIRENM) {
              psRow += `<ACQUIRENM>${ps.ACQUIRENM}</ACQUIRENM>`;
            }
            if (ps.POSTRANSDATE) {
              psRow += `<POSTRANSDATE>${ps.POSTRANSDATE}</POSTRANSDATE>`;
            }
            if (ps.POSTRANSNUM) {
              psRow += `<POSTRANSNUM>${ps.POSTRANSNUM}</POSTRANSNUM>`;
            }
            if (ps.DEVICEID) {
              psRow += `<DEVICEID>${ps.DEVICEID}</DEVICEID>`;
            }
            if (ps.EPZDETAILS) {
              psRow += `<EPZDETAILS>${ps.EPZDETAILS}</EPZDETAILS>`;
            }
            if (ps.AUTHCD) {
              psRow += `<AUTHCD>${ps.AUTHCD}</AUTHCD>`;
            }
            if (ps.SUM) {
              psRow += `<SUM>${this._toDecimal(ps.SUM)}</SUM>`;
            }

            psRow += '</ROW>';
            return psRow;
          })}</PAYSYS>`;

          row += paySys;
        }

        row += '</ROW>';
        return row;
      })
      .join('\r\n')}`;

    checkpay += rows + '\r\n';
    checkpay += `</CHECKPAY>`;
    return checkpay;
  }

  private _getCheckTaxXml(checkTax: ICheckTax[]) {
    if (!checkTax) {
      return ``;
    }

    if (checkTax.length == 0) {
      return ``;
    }

    let CHECKTAX = '<CHECKTAX>\r\n';
    const rows = `${checkTax
      .map((tax, i) => {
        let row = `<ROW ROWNUM="${i + 1}">`;
        row += `<TYPE>${tax.TYPE}</TYPE>`;
        row += `<NAME>${this._escapeCharacters(tax.NAME)}</NAME>`;
        row += `<LETTER>${tax.LETTER}</LETTER>`;
        row += `<PRC>${this._toDecimal(tax.PRC)}</PRC>`;
        if (tax.SIGN) {
          row += '<SIGN>true</SIGN>';
        }

        if (tax.TURNOVER) {
          row += `<TURNOVER>${this._toDecimal(tax.TURNOVER)}</TURNOVER>`;
        }

        if (tax.SOURCESUM) {
          row += `<SOURCESUM>${this._toDecimal(tax.SOURCESUM)}</SOURCESUM>`;
        }
        row += `<SUM>${this._toDecimal(tax.SUM)}</SUM>`;
        row += '</ROW>';
        return row;
      })
      .join('\r\n')}`;

    CHECKTAX += rows + '\r\n';
    CHECKTAX += '</CHECKTAX>';

    return CHECKTAX;
  }

  private _getCheckBodyXml(checkProduct: ICheckProduct[]) {
    if (!checkProduct) {
      return ``;
    }

    let CHECKBODY = '<CHECKBODY>\r\n';
    const rows = `${checkProduct
      .map((cp, i) => {
        let row = `<ROW ROWNUM="${i + 1}">`;
        row += `<CODE>${cp.CODE}</CODE>`;
        if (cp.UKTZED) {
          row += `<UKTZED>${cp.UKTZED}</UKTZED>`;
        }

        row += `<NAME>${this._escapeCharacters(cp.NAME)}</NAME>`;
        if (cp.UNITCD) {
          row += `<UNITCD>${cp.UNITCD}</UNITCD>`;
        }

        if (cp.UNITNM) {
          row += `<UNITNM>${cp.UNITNM}</UNITNM>`;
        }

        row += `<AMOUNT>${this._toDecimal3(cp.AMOUNT)}</AMOUNT>`;
        row += `<PRICE>${this._toDecimal(cp.PRICE)}</PRICE>`;

        if (cp.LETTERS) {
          row += `<LETTERS>${cp.LETTERS}</LETTERS>`;
        }

        row += `<COST>${this._toDecimal(cp.COST)}</COST>`;
        row += `${this._getExciseLabels(cp.EXCISELABELS)}`;
        if (cp.DISCOUNTTYPE !== null && cp.DISCOUNTTYPE !== undefined) {
          row += `<DISCOUNTTYPE>${cp.DISCOUNTTYPE}</DISCOUNTTYPE>`;
        }
        if (cp.DISCOUNTPERCENT) {
          row += `<DISCOUNTPERCENT>${this._toDecimal(
            cp.DISCOUNTPERCENT
          )}</DISCOUNTPERCENT>`;
        }
        if (cp.DISCOUNTSUM) {
          row += `<DISCOUNTSUM>${this._toDecimal(
            cp.DISCOUNTSUM
          )}</DISCOUNTSUM>`;
        }

        row += this._getCommentXml(cp.COMMENT);
        row += '</ROW>';
        return row;
      })
      .join('\r\n')}`;

    CHECKBODY += rows + '\r\n';
    CHECKBODY += '</CHECKBODY>';

    return CHECKBODY;
  }

  private _getZRepoBodyXml(shiftTotals: ShiftTotals) {
    if (!shiftTotals) {
      return ``;
    }

    return `<ZREPBODY>
		<SERVICEINPUT>${this._toDecimal(shiftTotals.ServiceInput)}</SERVICEINPUT>
		<SERVICEOUTPUT>${this._toDecimal(shiftTotals.ServiceOutput)}</SERVICEOUTPUT>
</ZREPBODY>`;
  }

  private _getZRepoRealizXml(shiftTotals: ShiftTotals) {
    if (!shiftTotals) {
      return ``;
    }

    if (!shiftTotals.Real) {
      return ``;
    }

    return `<ZREPREALIZ>
		<SUM>${this._toDecimal(shiftTotals.Real.Sum)}</SUM>
		<ORDERSCNT>${shiftTotals.Real.OrdersCount}</ORDERSCNT>
    ${
      !shiftTotals.Real.PayForm?.length
        ? ''
        : `<PAYFORMS>
        ${shiftTotals.Real.PayForm.map((pf, i) => {
          return `    <ROW ROWNUM="${i + 1}">
        <PAYFORMCD>${pf.PayFormCode}</PAYFORMCD>
        <PAYFORMNM>${this._escapeCharacters(pf.PayFormName)}</PAYFORMNM>
        <SUM>${this._toDecimal(pf.Sum)}</SUM>
    </ROW>`;
        }).join('\r\n')}
    </PAYFORMS>`
    }

    ${
      !shiftTotals.Real.Tax?.length
        ? ''
        : `<TAXES>
        ${shiftTotals.Real.Tax.map((tax, i) => {
          return `    <ROW ROWNUM="${i + 1}">
          <TYPE>${tax.Type}</TYPE>
          <NAME>${this._escapeCharacters(tax.Name)}</NAME>
          <LETTER>${tax.Letter}</LETTER>
          <PRC>${this._toDecimal(tax.Prc)}</PRC>
          ${tax.Sign ? '<SIGN>true</SIGN>' : ''}
          ${
            tax.Turnover
              ? `<TURNOVER>${this._toDecimal(tax.Turnover)}</TURNOVER>`
              : ''
          }
          ${
            tax.SourceSum
              ? `<SOURCESUM>${this._toDecimal(tax.SourceSum)}</SOURCESUM>`
              : ''
          }
          <SUM>${this._toDecimal(tax.Sum)}</SUM>
      </ROW>`;
        }).join('\r\n')}
    </TAXES>`
    }

</ZREPREALIZ>`;
  }

  private _getZRepoReturnXml(shiftTotals: ShiftTotals) {
    if (!shiftTotals) {
      return ``;
    }

    if (!shiftTotals.Ret) {
      return ``;
    }

    return `<ZREPRETURN>
		<SUM>${this._toDecimal(shiftTotals.Ret.Sum)}</SUM>
		<ORDERSCNT>${shiftTotals.Ret.OrdersCount}</ORDERSCNT>
    ${
      !shiftTotals.Ret.PayForm?.length
        ? ''
        : `<PAYFORMS>
        ${shiftTotals.Ret.PayForm.map((pf, i) => {
          return `    <ROW ROWNUM="${i + 1}">
        <PAYFORMCD>${pf.PayFormCode}</PAYFORMCD>
        <PAYFORMNM>${this._escapeCharacters(pf.PayFormName)}</PAYFORMNM>
        <SUM>${this._toDecimal(pf.Sum)}</SUM>
    </ROW>`;
        }).join('\r\n')}
    </PAYFORMS>`
    }

    ${
      !shiftTotals.Ret.Tax?.length
        ? ''
        : `<TAXES>
        ${shiftTotals.Ret.Tax.map((tax, i) => {
          return `    <ROW ROWNUM="${i + 1}">
          <TYPE>${tax.Type}</TYPE>
          <NAME>${this._escapeCharacters(tax.Name)}</NAME>
          <LETTER>${tax.Letter}</LETTER>
          <PRC>${this._toDecimal(tax.Prc)}</PRC>
          ${tax.Sign ? '<SIGN>true</SIGN>' : ''}
          ${
            tax.Turnover
              ? `<TURNOVER>${this._toDecimal(tax.Turnover)}</TURNOVER>`
              : ''
          }
          ${
            tax.SourceSum
              ? `<SOURCESUM>${this._toDecimal(tax.SourceSum)}</SOURCESUM>`
              : ''
          }
          <SUM>${this._toDecimal(tax.Sum)}</SUM>
      </ROW>`;
        }).join('\r\n')}
    </TAXES>`
    }

</ZREPRETURN>`;
  }

  private _getDocTypeXml(docType: number) {
    return `<DOCTYPE>${docType}</DOCTYPE>\r\n`;
  }

  private _getDocSubTypeXml(docSubType: number = 0) {
    if (docSubType > 0) {
      return `<DOCSUBTYPE>${docSubType}</DOCSUBTYPE>\r\n`;
    } else {
      return '';
    }
  }

  private _getUidXml(uid: string) {
    return `<UID>${uid}</UID>\r\n`;
  }

  private _getOrderNumberXml(orderNumber: number) {
    return `<ORDERNUM>${orderNumber}</ORDERNUM>\r\n`;
  }

  private _getTinXml(tin: string) {
    return `<TIN>${tin}</TIN>\r\n`;
  }

  private _getIpnXml(ipn: string) {
    return ipn ? `<IPN>${ipn}</IPN>\r\n` : '';
  }

  private _getOrgmnXml(organizationName: string) {
    return `<ORGNM>${this._escapeCharacters(organizationName)}</ORGNM>\r\n`;
  }

  private _getPointnmXml(pointName: string) {
    return `<POINTNM>${this._escapeCharacters(pointName)}</POINTNM>\r\n`;
  }

  private _getPointAddrXml(pointAddress: string) {
    return `<POINTADDR>${this._escapeCharacters(pointAddress)}</POINTADDR>\r\n`;
  }

  private _getOrderDateXml(ORDERDATE: string) {
    return `<ORDERDATE>${ORDERDATE}</ORDERDATE>\r\n`;
  }

  private _getOrderTimeXml(ORDERTIME: string) {
    return `<ORDERTIME>${ORDERTIME}</ORDERTIME>\r\n`;
  }

  private _getCashDeskNumXml(cashDeskNum: number) {
    return `<CASHDESKNUM>${cashDeskNum}</CASHDESKNUM>\r\n`;
  }

  private _getCashRegisterNumXml(cashRegisterNum: string) {
    return `<CASHREGISTERNUM>${cashRegisterNum}</CASHREGISTERNUM>\r\n`;
  }

  private _getCommentXml(comment: string) {
    if (!comment) {
      return '';
    }

    return `<COMMENT>${comment}</COMMENT>\r\n`;
  }

  private _getRevokeLastOnlineDocXml(REVOKELASTONLINEDOC: boolean) {
    if (!REVOKELASTONLINEDOC) {
      return '';
    }

    return `<REVOKELASTONLINEDOC>true</REVOKELASTONLINEDOC>\r\n`;
  }

  private _getCashierXml(cashier: string) {
    return `<CASHIER>${this._escapeCharacters(cashier)}</CASHIER>\r\n`;
  }

  private _getVerXml(ver: number = 1) {
    return `<VER>${ver}</VER>\r\n`;
  }

  private _getOrderTaxNumXml(orderTaxNum: string) {
    if (!orderTaxNum) {
      return '';
    }

    return `<ORDERTAXNUM>${orderTaxNum}</ORDERTAXNUM>\r\n`;
  }

  private _getOrderRetNumXml(orderRetNum: string) {
    if (!orderRetNum) {
      return '';
    }

    return `<ORDERRETNUM>${orderRetNum}</ORDERRETNUM>\r\n`;
  }

  private _getOfflineXml(offline: boolean) {
    if (!offline) {
      return '';
    }

    return `<OFFLINE>true</OFFLINE>`;
  }

  private _getPrevDocHashXml(PREVDOCHASH: string) {
    if (!PREVDOCHASH) {
      return '';
    }

    return `<PREVDOCHASH>${PREVDOCHASH}</PREVDOCHASH>`;
  }

  private _getTestingXml(testing = false) {
    if (!testing) {
      return '';
    }

    return `<TESTING>true</TESTING>`;
  }

  private _getExciseLabels(labels: string[]) {
    if (!labels || labels.length == 0) {
      return '';
    }

    return `<EXCISELABELS>
    ${labels
      .map((label, i) => {
        return `    <ROW ROWNUM="${i + 1}">
      <EXCISELABEL>${label}</EXCISELABEL>
    </ROW>`;
      })
      .join('\r\n')}
    </EXCISELABELS>`;
  }

  private _toDecimal(value: number | string): string {
    return this._parseDecimal(value).toFixed(2);
  }

  private _toDecimal3(value: number | string): string {
    return this._parseDecimal(value).toFixed(3);
  }

  /**
   * Decimal2Column / Decimal3Column require a plain decimal (e.g. 1200.00).
   * Bank terminals and locale-formatted strings may arrive as 1,200.00 or 1200,00.
   */
  private _parseDecimal(value: number | string): number {
    if (value === null || value === undefined || value === '') {
      return 0;
    }

    if (typeof value === 'number') {
      return Number.isFinite(value) ? value : 0;
    }

    let normalized = String(value).trim().replace(/[\s\u00A0\u202F]/g, '');
    normalized = normalized.replace(/[^\d,.\-]/g, '');
    if (!normalized || normalized === '-' || normalized === '.' || normalized === ',') {
      return 0;
    }

    const lastComma = normalized.lastIndexOf(',');
    const lastDot = normalized.lastIndexOf('.');
    if (lastComma !== -1 && lastDot !== -1) {
      if (lastComma > lastDot) {
        normalized = normalized.replace(/\./g, '').replace(',', '.');
      } else {
        normalized = normalized.replace(/,/g, '');
      }
    } else if (lastComma !== -1) {
      normalized = normalized.replace(',', '.');
    }

    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  private _escapeCharacters(text: string): string {
    if (!text) {
      return text;
    }

    const result: string[] = [];
    for (let char of text) {
      switch (char.charCodeAt(0)) {
        case 60: // <
          result.push('&lt;');
          break;

        case 62: // >
          result.push('&gt;');
          break;

        case 38: // &
          result.push('&amp;');
          break;

        case 39: // '
        case 700: // ʼ
          result.push('&apos;');
          break;

        case 34: // "
          result.push('&quot;');
          break;

        default:
          result.push(char);
      }
    }

    return result.join('');
  }
}

export class TaxDocumentUtility {
  private static _xmlDeclaration =
    '<?xml version="1.0" encoding="windows-1251"?>';

  public static getCheck(check: ITaxOrder): ICheckDocument {
    const checkModel = new CheckModel();
    return checkModel.getCheck(check);
  }

  public static getZRepo(report: ITaxOrder): ICheckDocument {
    const checkModel = new CheckModel();
    return checkModel.getZRepoDocument(report);
  }

  public static instanceOfCheck(object: any): boolean {
    return (
      'CHECKTOTAL' in object && 'CHECKPAY' in object && 'CHECKBODY' in object
    );
  }

  static getChekDoc(CHECKHEAD: CHECKHEAD): string {
    let xml = '';
    xml += this._xmlDeclaration + '\r\n';
    xml +=
      '<CHECK xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="check01.xsd">' +
      '\r\n';
    xml += this._getCheckHead(CHECKHEAD) + '\r\n';

    xml += '</CHECK>';
    return xml;
  }

  private static _getCheckHead(CHECKHEAD: CHECKHEAD) {
    let checkHead = '<CHECKHEAD>' + '\r\n';

    checkHead += this._getDocTypeXml(CHECKHEAD.DOCTYPE);
    checkHead += this._getDocSubTypeXml(CHECKHEAD.SUBDOCTYPE);
    checkHead += this._getUidXml(CHECKHEAD.UID);
    checkHead += this._getTinXml(CHECKHEAD.TIN);
    checkHead += this._getIpnXml(CHECKHEAD.IPN);
    checkHead += this._getOrgmnXml(CHECKHEAD.ORGNM);
    checkHead += this._getPointnmXml(CHECKHEAD.POINTNM);
    checkHead += this._getPointAddrXml(CHECKHEAD.POINTADDR);
    checkHead += this._getOrderDateXml(CHECKHEAD.ORDERDATE);
    checkHead += this._getOrderTimeXml(CHECKHEAD.ORDERTIME);
    checkHead += this._getOrderNumberXml(CHECKHEAD.ORDERNUM);
    checkHead += this._getCashDeskNumXml(CHECKHEAD.CASHDESKNUM);
    checkHead += this._getCashRegisterNumXml(CHECKHEAD.CASHREGISTERNUM);

    // if (ORDERSTORNUM) {
    //   checkHead += `<ORDERSTORNUM>${ORDERSTORNUM}</ORDERSTORNUM>`;
    // }

    // checkHead += this._getOrderRetNumXml(ORDERRETNUM);
    checkHead += this._getRevokeLastOnlineDocXml(CHECKHEAD.REVOKELASTONLINEDOC);
    checkHead += this._getCashierXml(CHECKHEAD.CASHIER);
    checkHead += this._getVerXml(CHECKHEAD.VER);
    checkHead += this._getOrderTaxNumXml(CHECKHEAD.ORDERTAXNUM);
    checkHead += this._getOfflineXml(CHECKHEAD.OFFLINE);
    checkHead += this._getPrevDocHashXml(CHECKHEAD.PREVDOCHASH);
    checkHead += this._getTestingXml(CHECKHEAD.TESTING);
    checkHead += '</CHECKHEAD>';
    return checkHead;
  }

  private static _getDocTypeXml(docType: number) {
    return `<DOCTYPE>${docType}</DOCTYPE>\r\n`;
  }

  private static _getDocSubTypeXml(docSubType: number = 0) {
    if (docSubType > 0) {
      return `<DOCSUBTYPE>${docSubType}</DOCSUBTYPE>\r\n`;
    } else {
      return '';
    }
  }

  private static _getUidXml(uid: string) {
    return `<UID>${uid}</UID>\r\n`;
  }

  private static _getOrderNumberXml(orderNumber: number) {
    return `<ORDERNUM>${orderNumber}</ORDERNUM>\r\n`;
  }

  private static _getTinXml(tin: string) {
    return `<TIN>${tin}</TIN>\r\n`;
  }

  private static _getIpnXml(ipn: string) {
    return ipn ? `<IPN>${ipn}</IPN>\r\n` : '';
  }

  private static _getOrgmnXml(organizationName: string) {
    return `<ORGNM>${this._escapeCharacters(organizationName)}</ORGNM>\r\n`;
  }

  private static _getPointnmXml(pointName: string) {
    return `<POINTNM>${this._escapeCharacters(pointName)}</POINTNM>\r\n`;
  }

  private static _getPointAddrXml(pointAddress: string) {
    return `<POINTADDR>${this._escapeCharacters(pointAddress)}</POINTADDR>\r\n`;
  }

  private static _getOrderDateXml(ORDERDATE: string) {
    return `<ORDERDATE>${ORDERDATE}</ORDERDATE>\r\n`;
  }

  private static _getOrderTimeXml(ORDERTIME: string) {
    return `<ORDERTIME>${ORDERTIME}</ORDERTIME>\r\n`;
  }

  private static _getCashDeskNumXml(cashDeskNum: number) {
    return `<CASHDESKNUM>${cashDeskNum}</CASHDESKNUM>\r\n`;
  }

  private static _getCashRegisterNumXml(cashRegisterNum: string) {
    return `<CASHREGISTERNUM>${cashRegisterNum}</CASHREGISTERNUM>\r\n`;
  }

  private static _getCommentXml(comment: string) {
    if (!comment) {
      return '';
    }

    return `<COMMENT>${comment}</COMMENT>\r\n`;
  }

  private static _getRevokeLastOnlineDocXml(REVOKELASTONLINEDOC: boolean) {
    if (!REVOKELASTONLINEDOC) {
      return '';
    }

    return `<REVOKELASTONLINEDOC>true</REVOKELASTONLINEDOC>\r\n`;
  }

  private static _getCashierXml(cashier: string) {
    return `<CASHIER>${this._escapeCharacters(cashier)}</CASHIER>\r\n`;
  }

  private static _getVerXml(ver: number = 1) {
    return `<VER>${ver}</VER>\r\n`;
  }

  private static _getOrderTaxNumXml(orderTaxNum: string) {
    if (!orderTaxNum) {
      return '';
    }

    return `<ORDERTAXNUM>${orderTaxNum}</ORDERTAXNUM>\r\n`;
  }

  private static _getOrderRetNumXml(orderRetNum: string) {
    if (!orderRetNum) {
      return '';
    }

    return `<ORDERRETNUM>${orderRetNum}</ORDERRETNUM>\r\n`;
  }

  private static _getOfflineXml(offline: boolean) {
    if (!offline) {
      return '';
    }

    return `<OFFLINE>true</OFFLINE>\r\n`;
  }

  private static _getPrevDocHashXml(PREVDOCHASH: string) {
    if (!PREVDOCHASH) {
      return '';
    }

    return `<PREVDOCHASH>${PREVDOCHASH}</PREVDOCHASH>\r\n`;
  }

  private static _getTestingXml(testing = false) {
    if (!testing) {
      return '';
    }

    return `<TESTING>true</TESTING>\r\n`;
  }

  private static _escapeCharacters(text: string): string {
    if (!text) {
      return text;
    }

    const result: string[] = [];
    for (let char of text) {
      switch (char.charCodeAt(0)) {
        case 60: // <
          result.push('&lt;');
          break;

        case 62: // >
          result.push('&gt;');
          break;

        case 38: // &
          result.push('&amp;');
          break;

        case 39: // '
          result.push('&apos;');
          break;

        case 34: // "
          result.push('&quot;');
          break;

        default:
          result.push(char);
      }
    }

    return result.join('');
  }
}
