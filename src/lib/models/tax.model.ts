// Fiscal Server API models used by the tax register context.

export class TaxDocumentType {
  static SALE_GOODS = 0;
  static OPEN_SHIFT = 100;
  static CLOSE_SHIFT = 101;
  static OOFFLINE_BEGIN = 102;
  static OFFLINE_END = 103;
}

export class TaxDocumentSubType {
  static CHECK_RETURN = 1;
  static SERVICE_DEPOSIT = 2;
  static ADDITIONAL_DEPOSIT = 3;
  static SERVICE_ISSUE = 4;
  static CHECK_STORNO = 5;
}

export interface TransactionsRegistrarStateResponse {
  UID: string; // <Унікальний ідентифікатор відповіді>,
  Timestamp: string;
  ShiftState: number; // <0-зміну не відкрито, 1-зміну відкрито>,
  ShiftId: number; // = <Ідентифікатор зміни>,
  OpenShiftFiscalNum: string; // = <Фіскальний номер документа “Відкриття зміни”>,
  ZRepPresent: boolean; // = <Ознака присутності Z-звіту (false/true)>,
  Testing: boolean;
  Name: string; // = <П.І.Б. оператора, що відкрив зміну>,
  SubjectKeyId: string; // = <Ідентифікатор ключа суб’єкта сертифікату оператора, що відкрив зміну>,
  FirstLocalNum: number; // = <Перший внутрішній номер документа у зміні>,
  NextLocalNum: number; // = <Наступний внутрішній номер документа>,
  LastFiscalNum: string; // = <Останній фіскальний номер документа>,

  OfflineSupported: boolean; // = <Для ПРРО може використовуватись режим офлайн>,
  ChiefCashier: boolean; // = <Користувач є старшим касиром>,

  OfflineSessionId: string; // = <Ідентифікатор офлайн сесії (null – режим офлайн заборонений для ПРРО)>,
  OfflineSeed: string; // = <"Секретне число" для обчислення фіскального номера офлайн документа (null – режим офлайн заборонений для ПРРО)>,
  OfflineNextLocalNum: string; // = <Наступний локальний номер документа в офлайн сесії (null – режим офлайн заборонений для ПРРО)>,
  OfflineSessionDuration: string; // = <Тривалість офлайн сесії (хвилин) (null – режим офлайн заборонений для ПРРО)>,
  OfflineSessionsMonthlyDuration: string; // = <Сумарна тривалість офлайн сесій за поточний місяць (хвилин) (null – режим офлайн заборонений для ПРРО)>,
  OfflineSessionRolledBack: boolean;
  OfflineSessionRollbackCmdUID: any;

  Closed: boolean; // = <Ознака скасованої реєстрації ПРРО, на якому наразі не закрито зміну>,

  TaxObject?: TaxObject; // = <Відомості об’єкту оподаткування (TaxObjectItem)>
}

export function isOfflineSequenceActive(
  offlineNextLocalNum?: string | number | null,
): boolean {
  const value = Number(offlineNextLocalNum);
  return Number.isFinite(value) && value > 1;
}

export interface TaxObject {
  Address: string;
  ChiefCashier: boolean;
  Entity: number;
  Ipn: string | null;
  Name: string;
  OrgName: string;
  SingleTax: boolean;
  TaxObjGuid: string;
  TaxObjId: number;
  Tin: string | null;
  TransactionsRegistrars: TransactionsRegistrar[];
}

export interface TransactionsRegistrar {
  Closed: boolean;
  Name: string;
  NumFiscal: number;
  NumLocal: number;
}

export class DocumentItem {
  NumFiscal: string; // <Фіскальний номер документа>
  NumLocal: number; // <Локальний номер документа>
  DocDateTime: string; // <Дата і час операції, зафіксованої документом>
  DocClass: 'Check' | 'ZRep'; // <Клас документа (“Check”, “ZRep”)>
  CheckDocType: string; // <Тип чека (“SaleGoods”, …)>
  CheckDocSubType: string; // <Розширений тип чека (“CheckGoods”, …)>
  Revoked: boolean; // <Ознака відкликаного документа>
  Storned: boolean; // <Ознака сторнованого документа>
  xmlCheck: string;
}

export interface LastShiftTotalsResponse {
  UID: string; // Унікальний ідентифікатор відповіді,
  ShiftState: 0 | 1; // 0-зміну не відкрито, 1-зміну відкрито,
  ZRepPresent: boolean; // = <Ознака присутності Z-звіту (false/true),
  Testing: boolean; // Ознака зміни, що містить тестові документи (false/true)
  Totals: ShiftTotals; // Підсумки зміни (якщо зміну відкрито)
  Opened: string; // Дата і час відкриття зміни
  OpenName: string; // П.І.Б. оператора, що відкрив зміну
  OpenSubjectKeyId: string; // Ідентифікатор ключа суб’єкта сертифікату оператора
  Closed: string; // Дата і час закриття зміни
  CloseName: string; // П.І.Б. оператора, що закрив зміну
  CloseSubjectKeyId: string; // Ідентифікатор ключа суб’єкта сертифікату оператора
  ZRepFiscalNum: string; // Фіскальний номер Z-звіту
}

// Підсумки по зміні
export interface ShiftTotals {
  Real: ShiftTotalsOrderType; // Підсумки реалізації
  Ret: ShiftTotalsOrderType; // Підсумки повернення
  Cash?: ShiftTotalsCash; // Підсумки видачі готівки
  Currency?: ShiftTotalsCurrency; // Підсумки операцій з іноземною валютою
  ServiceInput: number; // Службове внесення/Отримання авансу/Отримання підкріплення
  ServiceOutput: number; // Службова видача/Інкасація
}

// Підсумки по типу чека
export interface ShiftTotalsOrderType {
  Sum: number; // Загальна сума
  PwnSumIssued: number; // Загальна сума коштів, виданих клієнту ломбарда
  PwnSumReceived: number; // Загальна сума коштів, одержаних від клієнта ломбарда
  RndSum: number; // Заокруглення (наприклад, 0.71)
  NoRndSum: number; // Загальна сума без заокруглення (наприклад, 1000.71)
  TotalCurrencySum: number; // Загальна сума переказів коштів
  TotalCurrencyCommission: number; // Загальна сума комісії від переказів коштів
  OrdersCount: number; // Кількість чеків
  TotalCurrencyCost: number; // Кількість операції переказу коштів

  PayForm: ShiftTotalsPayForm[]; // Підсумки по формам оплати
  Tax: ShiftTotalsTax[]; // Податки/збори
}

// Підсумки по формам оплати
export interface ShiftTotalsPayForm {
  PayFormCode: number;
  PayFormName: string;
  Sum: number;
}

// Податки/збори
export interface ShiftTotalsTax {
  Type: number; // Код виду податку/збору
  Name: string; // Найменування виду податку/збору
  Letter: string; // Літерне позначення виду і ставки податку/збору
  Prc: number; // Відсоток податку/збору
  Sign: boolean; // Ознака податку/збору, не включеного у вартість
  Turnover: number; // Сума обсягів для розрахування податку/збору
  SourceSum: number; // Вихідна сума для розрахування податку/збору
  Sum: number; // Сума податку/збору
}

// Підсумки видачі готівки
export interface ShiftTotalsCash {
  Sum: number; // Загальна сума
  Commission: number; // Загальна сума комісії
  OrdersCount: number; // Кількість чеків
}

// Підсумки операцій з іноземною валютою
export interface ShiftTotalsCurrency {
  TotalInAdvance: number; // Отримано авансів національною валютою
  TotalInAttach: number; // Отримано підкріплень національною валютою
  TotalSurrCollection: number; // Здано по інкасації національною валютою
  Commission: number; // Отримано комісії конвертації
  CalcDocsCnt: number; // Кількість розрахункових документів за зміну
  AcceptedN: number; // Прийнято національної валюти для переказу
  IssuedN: number; // Видано національної валюти при виплаті переказу
  CommissionN: number; // Отримано комісії в національній валюті при здійсненні переказів
  TransfersCnt: number; // Кількість операцій (документів) переказів або виплат переказів
  Details: TotalsCurrencyDetails[]; // Підсумки по видам іноземної валюти
}

// Підсумки по виду іноземної валюти
export interface TotalsCurrencyDetails {
  ValCd: number; // Код валюти
  ValSymCd: string; // Символьний код валюти
  BuyValI: number; // Загальна сума придбаної іноземної валюти
  SellValI: number; // Загальна сума проданої іноземної валюти
  BuyValN: number; // Загальна сума придбаної національної валюти
  SellValN: number; // Загальна сума проданої національної валюти
  StorBuyValI: number; // Загальна сума поверненої клієнтами іноземної валюти за операціями «сторно»
  StorSellValI: number; // Загальна сума виданої клієнтам національної валюти за операціями «сторно»
  StorBuyValN: number; // Загальна сума поверненої клієнтами національної валюти за операціями «сторно»
  StorSellValN: number; // Загальна сума виданої клієнтам національної валюти за операціями «сторно»
  CInValI: number; // Загальна сума прийнятої іноземної валюти за операціями конвертації
  COutValI: number; // Загальна сума виданої іноземної валюти за операціями конвертації
  Commission: number; // Загальна сума комісії за операціями конвертації
  InAdvance: number; // Отримано авансів
  InAttach: number; // Отримано підкріплень
  SurrCollection: number; // Здано по інкасації
  StorCInValI: number; // Видано іноземної валюти по сторно конвертації
  StorCOutValI: number; // Повернуто іноземної валюти по сторно конвертації
  StorCommission: number; // Повернуто суму комісії з сторно конвертації
}

// What the tax register service needs from the application's register configuration: the
// register's fiscal number, which identifies its context. An application keeps any other
// data it needs in the same object (see ITaxConfig); the service stores it unchanged.
export interface TaxRegisterConfig {
  taxRegister?: { fiscalNumber?: string | number } | null;
}

// Application configuration of one tax register: the organization, the register and its
// cashiers. How a register relates to the application's own entities (points of sale,
// stores) is up to the application.
export interface ITaxConfig extends TaxRegisterConfig {
  tin: string;
  ipn: string;
  orgFullName: string;
  cashiers: Cashier[];

  active: boolean;
  taxRegister: TaxConfigRegister;
  cashier: Cashier;
  defaultTaxLetter: string;
  useDefaultTax: boolean;

  loading?: boolean;
  ready?: boolean;
  hasContext?: boolean;
  hasFeature?: boolean;
  editSettings?: boolean;
  editTaxObject?: boolean;
  editTaxRegister?: boolean;
  taxObjectsLoading?: boolean;
  taxObjectsError: boolean;
  isNewOrg: boolean;
  shiftView?: boolean;
  registerStateView?: boolean;
  privateLoaded?: boolean;
  error?: string;
}

export interface TaxConfigRegister {
  address: string;
  created: string;
  fiscalNumber: string;
  localNumber: number;
  name: string;
  objectName: string;
  status: string;
}

export interface Cashier {
  id: string;
  organizationId: string;
  chiefCashier: boolean;
  name: string;
  registerNumber: string;
  status: string;
  subjectKeyId: string;
  hasPrivateKey: boolean;
  privateKey: CashierPrivateKey;
}

export interface CashierPrivateKey {
  id?: string;
  expirationDate?: string;
  cashierId?: string;
  keyFileBase64: string;
  keyFileName: string;
  tin?: string;
  providerAddress?: string;
  providerCmpAddress?: string;
  providerName: string;
  providerOcspAccessPointAddress?: string;
  providerOcspAccessPointPort?: string;
  providerTspAddress?: string;
  providerTspAddressPort?: string;
  password?: string;
}
