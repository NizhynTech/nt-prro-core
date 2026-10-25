// Commands of the Fiscal Server `/cmd` endpoint. toString() returns the JSON text the
// application signs (or, for ServerState, sends unsigned) as the request body.

import { DocumentItem } from '../models/tax.model.js';

// Запит поточного часу сервера.
export class ServerStateCommand {
  readonly Command = 'ServerState';

  toString(): string {
    return JSON.stringify({ Command: this.Command });
  }
}

// Запит стану ПРРО.
export class TransactionsRegistrarStateCommand {
  private _command = 'TransactionsRegistrarState';
  get Command(): string {
    return this._command;
  }

  private _numFiscal: string; // <Фіскальний номер ПРРО>
  get NumFiscal(): string {
    return this._numFiscal;
  }

  private _offlineSessionId: string; // <Ідентифікатор офлайн сесії, для якої будуть надіслані пакети документів (не обов’язковий)>
  get OfflineSessionId(): string {
    return this._offlineSessionId;
  }

  private _offlineSeed: string; // <"Секретне число" для обчислення фіскального номера офлайн документа офлайн сесії, для якої будуть надіслані пакети документів (не обов’язковий)>
  get OfflineSeed(): string {
    return this._offlineSeed;
  }

  private _includeTaxObject: boolean; // <Ознака запиту відомостей об’єкту оподаткування (false/true) (не обов’язковий)>
  get IncludeTaxObject(): boolean {
    return this._includeTaxObject;
  }

  constructor(
    numFiscal: string,
    offlineSessionId?: string,
    offlineSeed?: string,
    includeTaxObject?: boolean,
  ) {
    this._numFiscal = numFiscal;
    this._offlineSessionId = offlineSessionId;
    this._offlineSeed = offlineSeed;
    this._includeTaxObject = includeTaxObject;
  }

  toString(): string {
    const commandJson = {
      Command: this.Command,
      NumFiscal: this.NumFiscal,
      OfflineSessionId: this.OfflineSessionId,
      OfflineSeed: this.OfflineSeed,
      IncludeTaxObject: this.IncludeTaxObject,
    };
    return JSON.stringify(commandJson);
  }
}

// Запит підсумків останньої зміни.
export class LastShiftTotalsCommand {
  private _command = 'LastShiftTotals';
  get Command(): string {
    return this._command;
  }

  private _numFiscal: string; // <Фіскальний номер ПРРО>
  get NumFiscal(): string {
    return this._numFiscal;
  }

  constructor(numFiscal: string) {
    this._numFiscal = numFiscal;
  }

  toString(): string {
    const commandJson = {
      Command: this.Command,
      NumFiscal: this.NumFiscal,
    };
    return JSON.stringify(commandJson);
  }
}

// Запит переліку змін за період. The period covers whole days: From is the start of the
// first day and To the end of the last day, both taken from the local calendar date.
export class ShiftsCommand {
  private _command = 'Shifts';
  get Command(): string {
    return this._command;
  }

  private _numFiscal: string; // <Фіскальний номер ПРРО>
  get NumFiscal(): string {
    return this._numFiscal;
  }

  private _from: Date; // <Дата і час початку періоду>
  get From(): Date {
    return new Date(
      Date.UTC(
        this._from.getFullYear(),
        this._from.getMonth(),
        this._from.getDate(),
      ),
    );
  }

  private _to: Date; // <Дата і час завершення періоду>
  get To(): Date {
    return new Date(
      Date.UTC(
        this._to.getFullYear(),
        this._to.getMonth(),
        this._to.getDate(),
        23,
        59,
        59,
      ),
    );
  }

  constructor(numFiscal: string, from: Date, to: Date) {
    this._numFiscal = numFiscal;
    this._from = from;
    this._to = to;
  }

  toString(): string {
    const _from = this.From.getTime();
    const _to = this.To.getTime();

    const commandJson = {
      Command: this.Command,
      NumFiscal: this.NumFiscal,
      From: `/Date(${_from})/`,
      To: `/Date(${_to})/`,
    };
    return JSON.stringify(commandJson);
  }
}

// Запит переліку документів зміни.
export class ShiftDocumentsCommand {
  private _command = 'Documents';
  get Command(): string {
    return this._command;
  }

  private _numFiscal: string; // <Фіскальний номер ПРРО>
  get NumFiscal(): string {
    return this._numFiscal;
  }

  private _shiftId: string; // <Ідентифікатор зміни>
  get ShiftId(): string {
    return this._shiftId;
  }

  private _openShiftFiscalNum: string; // <Фіскальний номер документа “Відкриття зміни>
  get OpenShiftFiscalNum(): string {
    return this._openShiftFiscalNum;
  }

  constructor(
    numFiscal: string,
    shiftId: number,
    openShiftFiscalNum: number,
  ) {
    this._numFiscal = numFiscal.toString();
    this._shiftId = shiftId.toString();
    this._openShiftFiscalNum = openShiftFiscalNum.toString();
  }

  toString(): string {
    const commandJson = {
      Command: this.Command,
      NumFiscal: this.NumFiscal,
      ShiftId: this.ShiftId,
      OpenShiftFiscalNum: this.OpenShiftFiscalNum,
    };
    return JSON.stringify(commandJson);
  }
}

// Тип даних запиту документа (DocumentRequestType) for CheckExt and ZRepExt.
export type TaxDocumentResponseType =
  | 'Availability' // Перевірка наявності документа
  | 'OriginalXml' // Оригінальний XML
  | 'SignedByServerXml' // XML засвідчений КЕП Фіскального Сервера
  | 'Visualization' // Документ в текстовому форматі для відображення (UTF-8)
  | 'SignedBySenderXml' // XML засвідчений КЕП відправника
  | 'SignedBySenderAndServerXml'; // XML засвідчений КЕП відправника і КЕП Фіскального Сервера

export interface CheckExtCommandOptions {
  // Фіскальний номер ПРРО.
  registrarNumFiscal: string;
  // The check is identified by its fiscal number or by its local number.
  numFiscal?: string;
  numLocal?: number;
  type: TaxDocumentResponseType;
  // Request the check's address in the Electronic Cabinet.
  acquireCabinetUrl?: boolean;
}

// Запит чека.
export class CheckExtCommand {
  readonly Command = 'CheckExt';

  constructor(private _options: CheckExtCommandOptions) {}

  toString(): string {
    const options = this._options;
    return JSON.stringify({
      Command: this.Command,
      RegistrarNumFiscal: options.registrarNumFiscal,
      NumFiscal: options.numFiscal,
      NumLocal: options.numLocal,
      Type: options.type,
      AcquireCabinetUrl: options.acquireCabinetUrl,
    });
  }
}

// Запит Z-звіту.
export class ZRepExtCommand {
  readonly Command = 'ZRepExt';

  constructor(
    private _registrarNumFiscal: string,
    private _numFiscal: string,
    private _type: TaxDocumentResponseType,
  ) {}

  toString(): string {
    return JSON.stringify({
      Command: this.Command,
      RegistrarNumFiscal: this._registrarNumFiscal,
      NumFiscal: this._numFiscal,
      Type: this._type,
    });
  }
}

// Запит переліку господарських об'єктів (ГО) і їхніх ПРРО.
export class ObjectsCommand {
  private _command = 'Objects';
  get Command(): string {
    return this._command;
  }

  toString(): string {
    const commandJson = {
      Command: this.Command,
    };
    return JSON.stringify(commandJson);
  }
}

// Запит надсилання пакета офлайн документів. Documents are the Base64 texts of the signed
// offline documents; UID identifies the request and is repeated in the response.
export class SendOflPackageCommand {
  readonly Command = 'SendOflPackage';

  constructor(
    private _documents: string[],
    private _uid: string,
  ) {}

  toString(): string {
    return JSON.stringify({
      Command: this.Command,
      Documents: this._documents,
      UID: this._uid,
    });
  }
}

// Запит переліку операторів (касирів) суб'єкта господарювання, реєстраційний номер якого
// міститься в сертифікаті КЕП, яким засвідчено запит.
export class OperatorsCommand {
  readonly Command = 'Operators';

  toString(): string {
    return JSON.stringify({ Command: this.Command });
  }
}

// Responses

export interface ResponseOperators {
  UID: string; // Унікальний ідентифікатор запиту
  Tin: string; // Реєстраційний номер суб'єкта господарювання (ЄДРПОУ,ДРФО,Картка платника податків)
  Operators: OperatorItem[]; // Перелік операторів
}

export interface OperatorItem {
  SubjectKeyId: string; // Ідентифікатор ключа суб’єкта
  RegNum: string; // Реєстраційний номер особи оператора (ЄДРПОУ,ДРФО,Картка платника податків)
  ChiefCashier: boolean; // Старший касир
}

export interface ServerStateResponse {
  UID: string;
  Timestamp: string;
}

// Response to CheckExt and ZRepExt.
export interface DocumentResponse {
  UID: string;
  Data: string; // Base64
  ResultCode: number;
  ResultText: string;
}

export interface ShiftsResponse {
  UID: string;
  Shifts: ShiftItem[];
}

export interface ShiftItem {
  ShiftId: number;
  OpenShiftFiscalNum: string;
  CloseShiftFiscalNum: string;
  Testing: boolean;
  Opened: string;
  OpenName: string;
  OpenSubjectKeyId: string;
  Closed: string;
  CloseName: string;
  CloseSubjectKeyId: string;
  ZRepFiscalNum: string;
}

export interface ShiftDocumentsResponse {
  UID: string;
  Documents: DocumentItem[];
}

export interface ObjectsResponse {
  UID: string;
  TaxObjects: TaxObjectItem[];
}

export interface TaxObjectItem {
  Entity: number; // Ідентифікатор запису ГО
  SingleTax: boolean; // Ознака ФОП – платника єдиного податку
  Name: string; // Найменування ГО
  Address: string; // Адреса ГО
  Tin: string; // Код ЄДРПОУ/ДРФО платника податків
  Ipn: string; // Податковий номер платника ПДВ
  OrgName: string; // Найменування суб’єкта господарювання

  TransactionsRegistrars: TransactionsRegistrarItem[]; // Перелік ПРРО, зареєстрованих для ГО
}

export interface TransactionsRegistrarItem {
  NumFiscal: number; // Фіскальний номер ПРРО
  NumLocal: number; // Локальний номер ПРРО
  Name: string; // Найменування ПРРО
  Closed: boolean; // Ознака скасованої реєстрації ПРРО, на якому наразі не закрито зміну
}
