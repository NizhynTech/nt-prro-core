// Input models for building fiscal document XML (check01.xsd, zrep01.xsd).

import { ShiftTotals } from '../models/tax.model.js';

// A check or a Z-report as the application describes it. The XML builder reads the fields
// it needs; the remaining ones belong to the application's document workflow.
export interface ITaxOrder {
  documentType?: 0 | 100 | 101 | 102 | 103 | null;
  documentSubType?: number;

  uid?: string;
  orderNumber: number;
  tin: string;
  ipn?: string;
  organizationName: string;
  pointName: string;
  pointAddress: string;
  cashDeskNum: number;
  cashRegisterNum: string;
  cashRegisterName: string;
  cashier: string;
  ORDERDATE?: string;
  ORDERTIME?: string;
  offline?: boolean;
  ORDERTAXNUM?: string;
  ORDERSTORNUM?: string;
  offlineLocalNum?: number;
  PREVDOCHASH?: string;
  offlineSessionId?: string;
  offlineSeed?: string;
  offlineNextLocalNum?: string;

  ticketXml?: string;
  signedTicket?: string;
  xmlDocument?: string;
  signedXmlDocument?: string;
  testing?: boolean;

  CHECKTOTAL?: number;
  PROVIDED?: number;
  REMAINS?: number;
  CHECKPAY?: ICheckPay[];
  CHECKTAX?: ICheckTax[];
  CHECKBODY?: ICheckProduct[];
  DISCOUNTSUM?: number;
  RNDSUM?: number;
  NORNDSUM?: number;

  ORDERRETNUM?: string;
  REVOKELASTONLINEDOC?: boolean;
  shiftTotals?: ShiftTotals;
  documentDate?: string;

  toString?: (width: number, currencyName?: string) => string;
  toHtml?: () => string;
}

export interface ICheckPay {
  // Код форми оплати (числовий):
  // 0–Готівка, 1–Банківська картка, 2-Попередня оплата, 3-Кредит, ...
  PAYFORMCD: number;
  // Найменування форми оплати (128 символів)
  PAYFORMNM: string;
  // Загальна сума (15.2 цифри)
  SUM: number;
  // Сума внесених коштів (15.2 цифри)
  PROVIDED?: number;
  // Решта (не зазначається, якщо решта відсутня) (15.2 цифри)
  REMAINS?: number;
  PAYSYS?: ICheckPaySys[];
}

export interface ICheckPaySys {
  NAME: string;
  ACQUIRENM: string;
  POSTRANSDATE: string;
  POSTRANSNUM: string;
  DEVICEID: string;
  EPZDETAILS: string;
  AUTHCD: string;
  SUM: string;
}

export interface ICheckTax {
  // Код виду податку/збору (числовий):
  // 0-ПДВ,1-Акциз,2-ПФ...
  TYPE: number;
  // Найменування виду податку/збору (64 символи)
  NAME: string;
  // Літерне позначення виду і ставки податку/збору (А,Б,В,Г,...) (1 символ)
  LETTER: string;
  // Відсоток податку/збору (15.2 цифри)
  PRC: number;
  // Ознака податку/збору, не включеного у вартість
  SIGN?: boolean;
  // Сума для розрахування податку/збору (15.2 цифри)
  TURNOVER: number;
  SOURCESUM: number;
  // Сума податку/збору (15.2 цифри)
  SUM: number;
}

export interface ICheckProduct {
  CODE: number;
  UKTZED?: string;
  NAME: string;
  UNITCD?: number;
  UNITNM?: string;
  AMOUNT: number;
  PRICE: number;
  LETTERS?: string;
  COST: number;
  DISCOUNTTYPE?: number;
  DISCOUNTPERCENT?: number;
  DISCOUNTSUM?: number;
  EXCISELABELS: string[];
  COMMENT?: string;
}

// Header of a check without a body: shift opening and closing, offline session begin and end.
export interface CHECKHEAD {
  DOCTYPE: number; // 0-Чек реалізації товарів/послуг, 1-Чек переказу коштів, 2–Чек операції обміну валюти, 3-Чек видачі готівки, 100-Відкриття зміни, 101-Закриття зміни, 102-Початок офлайн сесії, 103-Завершення офлайн сесії
  SUBDOCTYPE?: number;
  UID: string;
  TIN?: string;
  IPN?: string;
  ORGNM: string;
  POINTNM: string;
  POINTADDR: string;
  ORDERDATE: string;
  ORDERTIME: string;
  ORDERNUM: number;
  CASHDESKNUM: number;
  CASHREGISTERNUM: string;
  REVOKELASTONLINEDOC?: boolean;
  CASHIER: string;
  VER: number;
  ORDERTAXNUM: string;
  OFFLINE: boolean;
  TESTING: boolean;
  PREVDOCHASH?: string;
}

export interface ICheckDocument {
  uid: string;
  orderNumber: number;
  xml: string;
}
