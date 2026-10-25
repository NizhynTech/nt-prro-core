import {
  formatOrderDate,
  formatOrderTime,
  parseOrderDateTime,
} from './documents/document-date.js';
import { hashTaxDocument } from './documents/document-hash.js';
import {
  DocumentIssuer,
  OfflineDocumentNumbering,
  createDocumentHead,
} from './documents/document-head.js';
import {
  createOfflineFiscalNumber,
  getOfflineControlNumber,
  getOfflineControlString,
  isPreviousDocumentHashRequired,
} from './documents/offline-fiscal-number.js';
import { CHECKHEAD } from './documents/tax-document.model.js';
import { TaxDocumentUtility } from './documents/tax-document.utility.js';
import {
  TaxTicket,
  getTaxTicketError,
  parseTaxTicket,
  setDocumentFiscalNumber,
} from './documents/tax-ticket.js';
import {
  TaxOfflineSettings,
  normalizeTaxOfflineSettings,
} from './models/tax-offline-settings.js';
import {
  DocumentItem,
  ITaxConfig,
  LastShiftTotalsResponse,
  ShiftTotals,
  ShiftTotalsOrderType,
  TaxDocumentSubType,
  TaxDocumentType,
  TaxRegisterConfig,
  TransactionsRegistrarStateResponse,
  isOfflineSequenceActive,
} from './models/tax.model.js';
import { validateOfflineSessionStart } from './offline/offline-session-start.js';
import { TaxContextStorage } from './storage/tax-context-storage.js';
import { parseXml } from './utils/xml-parser.js';

const TAX_REGISTER_CONTEXT_KEY_PREFIX = 'TAX_REGISTER_CONTEXT__';
const TAX_REGISTER_DOCUMENTS_KEY_PREFIX = 'TAX_REGISTER_DOCUMENTS__';
const TAX_DOCUMENT_STAGE_KEY_PREFIX = 'TAX_DOCUMENT_STAGE__';
const OFFLINE_PACKAGE_CHUNK_SIZE = 50;
// Fiscal numbers are identifiers, read as written: as numbers they would lose leading zeros
// and, above 2^53, digits.
const FISCAL_NUMBER_ELEMENTS = ['ORDERTAXNUM', 'ORDERSTORNUM'];

export type TaxRegisterContextId = string | number;

export interface TaxServerState {
  UID: string;
  Timestamp: string;
}

export interface StoredTaxServerState {
  response: TaxServerState;
  currentTime: string;
}

export interface OfflineSessionState {
  OfflineSessionId: string | number;
  OfflineSeed: string | number;
}

export interface TaxRegisterContext<
  TConfig extends TaxRegisterConfig = ITaxConfig,
> {
  taxConfig: TConfig;
  registerState: TransactionsRegistrarStateResponse;
  lastShiftTotals: LastShiftTotalsResponse;
  serverState: StoredTaxServerState;
  disabled?: boolean;
}

export interface TaxRegisterState
  extends TransactionsRegistrarStateResponse {
  OfflineSession: boolean;
  Offline: boolean;
}

// A document in the local journal: the document and what its registration put in force.
// Entries saved before these fields existed simply lack them.
export interface TaxJournalDocument extends DocumentItem {
  // The server's receipt for a document registered online.
  ticketXml?: string;
  // The offline credentials this document put in force: from the receipt of an online shift
  // opening, or from the end-session response saved with OfflineEnd.
  offlineCredentials?: OfflineSessionState;
}

export interface TaxRegisterContextSettings extends TaxOfflineSettings {
  // Document times follow the server-time estimate instead of the device clock.
  useServerTimeCorrection: boolean;
}

// Fixed settings, or a function the service calls each time it needs them, for settings that
// can change while the application runs (remote configuration).
export type TaxRegisterContextSettingsSource =
  | Partial<TaxRegisterContextSettings>
  | (() => Partial<TaxRegisterContextSettings> | null | undefined);

export interface TaxRegisterServiceOptions {
  // UID of new documents. Default: crypto.randomUUID(), where the platform provides it.
  createUid?: () => string;
}

// What only the caller knows about the next document; createDocumentHead takes the rest from
// the register's context.
export interface TaxDocumentHeadRequest {
  docType?: number; // DOCTYPE; omitted for a Z-report
  docSubType?: number;
  cashier: string; // CASHIER: the operator whose key signs the document
  // CHECKTOTAL/SUM formatted 0.00, as written in the body of a check that has one: part of an
  // offline document's control number.
  checkTotal?: string | null;
  // TESTING of a shift opening, which starts a test or a fiscal shift. Other documents take
  // the flag of the current shift.
  testing?: boolean;
  // Values replacing those of the register's TaxObject in the snapshot.
  issuer?: Partial<DocumentIssuer>;
}

interface TaxDocumentHead {
  UID?: string;
  TIN?: number | string;
  IPN?: number | string;
  ORGNM?: string;
  POINTNM?: string;
  POINTADDR?: string;
  CASHDESKNUM?: number | string;
  CASHREGISTERNUM?: number | string;
  ORDERNUM: number | string;
  ORDERTAXNUM?: number | string;
  DOCTYPE?: number | string;
  DOCSUBTYPE?: number | string;
  ORDERDATE?: number | string;
  ORDERTIME?: number | string;
  REVOKED?: boolean | string;
  REVOKELASTONLINEDOC?: boolean | string;
  ORDERSTORNUM?: number | string;
  CASHIER?: string;
  TESTING?: boolean | string;
  OFFLINE?: boolean | string;
  PREVDOCHASH?: string;
}

interface ParsedTaxDocument {
  CHECK?: {
    CHECKHEAD?: TaxDocumentHead;
    CHECKTOTAL?: Record<string, number | string>;
    CHECKPAY?: {
      ROW?: Record<string, number | string> | Record<string, number | string>[];
    };
    CHECKTAX?: {
      ROW?: Record<string, number | string> | Record<string, number | string>[];
    };
  };
  ZREP?: {
    ZREPHEAD?: TaxDocumentHead;
  };
}

// Local state of tax registers: the context received from the server, the journal of
// documents created since, and the state and shift totals derived from both. Create one
// instance per storage and keep it for the application's lifetime: it caches contexts.
//
// Registers are identified by fiscal number only. TConfig is the application's register
// configuration; the service reads its fiscal number and otherwise stores and returns it
// unchanged, so links to the application's own entities (stores, points of sale) stay in
// the application.
export class TaxRegisterService<TConfig extends TaxRegisterConfig = ITaxConfig> {
  private _contexts = new Map<string, TaxRegisterContext<TConfig>>();

  constructor(
    private _storage: TaxContextStorage,
    private _settings: TaxRegisterContextSettingsSource = {},
    private _options: TaxRegisterServiceOptions = {},
  ) {
    if (!_storage) {
      throw new Error('Tax context storage is required.');
    }
  }

  get offlineSettings(): TaxOfflineSettings {
    return normalizeTaxOfflineSettings(this._readSettings());
  }

  private _readSettings(): Partial<TaxRegisterContextSettings> {
    const settings =
      typeof this._settings === 'function' ? this._settings() : this._settings;
    return settings || {};
  }

  // Replaces the snapshot with the server's data and clears the journal. Returns false and
  // updates only the server time when that would lose documents:
  // - the journal holds a document the server does not have: its last document is numbered at
  //   or after the state's NextLocalNum; force does not skip this check;
  // - without force, the stored snapshot has an active offline sequence.
  async initContext(
    taxConfig: TConfig,
    registerState: TransactionsRegistrarStateResponse,
    lastShiftTotals: LastShiftTotalsResponse | null,
    serverState: TaxServerState,
    force = false,
  ): Promise<boolean> {
    const id = this._getTaxRegisterId(taxConfig);

    if (!registerState) {
      throw new Error('Tax register state is required.');
    }

    this._getTimestamp(serverState?.Timestamp, 'Server timestamp');

    const currentContext = await this._getContext(id);
    const storedServerState: StoredTaxServerState = {
      response: serverState,
      currentTime: new Date(Date.now()).toISOString(),
    };

    if (currentContext) {
      await this._saveContext(id, {
        ...currentContext,
        serverState: storedServerState,
      });

      if (!force && this._isOffline(currentContext.registerState)) {
        return false;
      }
    }

    const documents = await this._getDocuments(id);
    if (this._hasDocumentsMissingOnServer(documents, registerState)) {
      return false;
    }

    const registrationCancelled = this._toBoolean(
      registerState.Closed as boolean | string,
    );
    const context: TaxRegisterContext<TConfig> = {
      taxConfig,
      registerState,
      lastShiftTotals:
        lastShiftTotals || this._createEmptyLastShiftTotals(registerState),
      serverState: storedServerState,
      // A new context starts disabled; an existing one keeps the application's setting unless
      // the registration is cancelled.
      disabled: registrationCancelled
        ? true
        : currentContext
          ? currentContext.disabled
          : true,
    };

    await this._saveContext(id, context);
    await this._saveDocuments(id, []);
    return true;
  }

  async saveTaxConfig(taxConfig: TConfig): Promise<void> {
    const id = this._getTaxRegisterId(taxConfig);
    const context = await this._getContext(id);
    if (!context) {
      throw new Error(
        `Tax register context not found. TaxRegister fiscal number ${id}`,
      );
    }

    await this._saveContext(id, { ...context, taxConfig });
  }

  // Saves the accepted end-session document together with the next session's credentials from
  // the end-package response, in one journal write. Call it only after that response.
  async completeOfflineSession(
    taxRegisterId: TaxRegisterContextId,
    endSessionXml: string,
    nextSession: OfflineSessionState,
  ): Promise<void> {
    this._assertOfflineSessionState(nextSession);
    const document = this._parseDocument(endSessionXml);
    if (document.CheckDocType !== 'OfflineEnd') {
      throw new Error('Tax document is not an offline session end.');
    }

    const id = this._normalizeTaxRegisterId(taxRegisterId);
    const offlineCredentials = this._toOfflineCredentials(nextSession);
    await this._appendDocuments(id, [{ xml: endSessionXml, offlineCredentials }]);
  }

  async getTaxConfig(taxRegisterId: TaxRegisterContextId): Promise<TConfig> {
    const id = this._normalizeTaxRegisterId(taxRegisterId);
    const context = await this._getContext(id);
    if (!context) {
      throw new Error(
        `Tax register context not found. TaxRegister fiscal number ${id}`,
      );
    }

    return context.taxConfig;
  }

  async getServerTime(taxRegisterId: TaxRegisterContextId): Promise<Date> {
    const id = this._normalizeTaxRegisterId(taxRegisterId);
    const context = await this._getContext(id);
    if (!context?.serverState) {
      throw new Error(`ServerState not found. TaxRegister fiscal number ${id}`);
    }

    const serverResponseTime = this._getTimestamp(
      context.serverState.response?.Timestamp,
      'Stored server timestamp',
    );
    const storedCurrentTime = this._getTimestamp(
      context.serverState.currentTime,
      'Stored current time',
    );
    return new Date(Date.now() + serverResponseTime - storedCurrentTime);
  }

  async getTaxContext(
    taxRegisterId: TaxRegisterContextId,
  ): Promise<TaxRegisterContext<TConfig> | null> {
    const id = this._normalizeTaxRegisterId(taxRegisterId);
    return await this._getContext(id);
  }

  async getState(
    taxRegisterId: TaxRegisterContextId,
  ): Promise<TaxRegisterState> {
    const id = this._normalizeTaxRegisterId(taxRegisterId);
    const context = await this._getContext(id);
    if (!context) {
      throw new Error(
        `Tax register context not found. TaxRegister fiscal number ${id}`,
      );
    }

    const state = JSON.parse(
      JSON.stringify(context.registerState),
    ) as TaxRegisterState;
    state.ShiftState = context.lastShiftTotals?.ShiftState ?? state.ShiftState;
    state.ZRepPresent =
      context.lastShiftTotals?.ZRepPresent ?? state.ZRepPresent;
    state.Testing = context.lastShiftTotals?.Testing ?? state.Testing;
    state.OfflineSession = false;
    state.Offline = false;

    const documents = await this._getDocuments(id);
    if (!documents.length) {
      return state;
    }

    this._applyOfflineCredentials(state, documents);

    const lastDocument = documents[documents.length - 1];
    const parsedDocument = parseXml<ParsedTaxDocument>(lastDocument.xmlCheck);
    const head =
      parsedDocument?.CHECK?.CHECKHEAD || parsedDocument?.ZREP?.ZREPHEAD;
    if (!head) {
      return state;
    }

    state.NextLocalNum = Math.max(
      Number(state.NextLocalNum) || 0,
      Number(lastDocument.NumLocal) + 1,
    );
    const offlineNextLocalNumber = this._getOfflineNextLocalNumber(
      lastDocument.NumFiscal,
    );
    if (offlineNextLocalNumber) {
      state.OfflineNextLocalNum = offlineNextLocalNumber;
    }
    // A shift holds only fiscal or only test documents: take TESTING from the latest shift
    // opening. OfflineBegin/OfflineEnd never carry it, so the last document is not a source.
    const shiftOpening = this._getLastShiftOpening(documents);
    if (shiftOpening) {
      state.Testing = this._toBoolean(shiftOpening.head.TESTING);
    }

    if (head.OFFLINE !== undefined) {
      const isOffline = this._toBoolean(head.OFFLINE);
      state.Offline = isOffline;
      state.OfflineSession = isOffline;
    }

    if (
      lastDocument.CheckDocType === 'OfflineBegin' ||
      lastDocument.CheckDocType === 'OfflineEnd'
    ) {
      const previousDocument = documents[documents.length - 2];
      if (previousDocument) {
        this._applyShiftState(state, previousDocument);
      }
      if (lastDocument.CheckDocType === 'OfflineBegin') {
        state.OfflineSession = true;
        state.Offline = true;
      } else {
        // A saved OfflineEnd was accepted by the server: the next session starts at 1.
        state.OfflineSession = false;
        state.Offline = false;
        state.OfflineNextLocalNum = '1';
      }
      return state;
    }

    this._applyShiftState(state, lastDocument);
    return state;
  }

  async getLastTotals(
    taxRegisterId: TaxRegisterContextId,
  ): Promise<LastShiftTotalsResponse> {
    const id = this._normalizeTaxRegisterId(taxRegisterId);
    const context = await this._getContext(id);
    if (!context) {
      throw new Error(
        `Tax register context not found. TaxRegister fiscal number ${id}`,
      );
    }

    const documents = await this._getDocuments(id);
    return documents.length
      ? this._calculateLastTotals(context.lastShiftTotals, documents)
      : context.lastShiftTotals;
  }

  async hasContext(taxRegisterId: TaxRegisterContextId): Promise<boolean> {
    return !!(await this._getContext(taxRegisterId));
  }

  // Disabled by the application, or because the register's registration is cancelled.
  async isDisabled(taxRegisterId: TaxRegisterContextId): Promise<boolean> {
    const context = await this._getContext(taxRegisterId);
    return !!context?.disabled || this._isRegistrationCancelled(context);
  }

  // A register whose registration is cancelled cannot be enabled.
  async setDisabled(
    taxRegisterId: TaxRegisterContextId,
    disabled: boolean,
  ): Promise<void> {
    const id = this._normalizeTaxRegisterId(taxRegisterId);
    const context = await this._getContext(id);
    if (!context) {
      throw new Error(
        `Tax register context not found. TaxRegister fiscal number ${id}`,
      );
    }
    if (!disabled && this._isRegistrationCancelled(context)) {
      throw new Error('Реєстрацію ПРРО скасовано: касу не можна увімкнути.');
    }

    await this._saveContext(id, { ...context, disabled });
  }

  async removeContext(taxRegisterId: TaxRegisterContextId): Promise<void> {
    const id = this._normalizeTaxRegisterId(taxRegisterId);
    if (!id) {
      return;
    }

    await this._storage.remove(this._getStorageKey(id));
    await this._storage.remove(this._getDocumentsStorageKey(id));

    this._contexts.delete(id);
  }

  async getAllTaxConfigs(): Promise<TConfig[]> {
    const storageKeys =
      (await this._storage.keys().catch(() => [] as string[])) || [];
    const fiscalNumbers = storageKeys
      .filter((key) => key?.startsWith(TAX_REGISTER_CONTEXT_KEY_PREFIX))
      .map((key) => key.slice(TAX_REGISTER_CONTEXT_KEY_PREFIX.length))
      .filter((id) => !!id);

    const configs: TConfig[] = [];
    const seen = new Set<string>();
    for (const fiscalNumber of fiscalNumbers) {
      if (seen.has(fiscalNumber)) {
        continue;
      }
      seen.add(fiscalNumber);
      const context = await this._getContext(fiscalNumber);
      if (
        context?.taxConfig &&
        !context.disabled &&
        !this._isRegistrationCancelled(context)
      ) {
        configs.push(context.taxConfig);
      }
    }

    return configs;
  }

  // Saves a document at the next local number and returns its XML as saved.
  //
  // For a document registered online, pass the server's receipt as received (its XML, see
  // extractTicketXml); the service parses it. It must belong to the document (same UID and
  // ORDERNUM). In the same journal write:
  // - the receipt's fiscal number (ORDERTAXNUM) is written into the document, replacing a value
  //   already there;
  // - the receipt is kept with the document;
  // - the receipt of a shift opening puts its offline credentials in force. A receipt without
  //   both credentials leaves the credentials in force unchanged.
  // The receipt is a generic structure: its ERRORCODE is ignored when it carries the fiscal
  // number. Without one, a non-zero ERRORCODE is the server's rejection: nothing is saved and
  // the error is thrown in the server's error format.
  async saveDocument(
    taxRegisterId: TaxRegisterContextId,
    rawXml: string,
    ticketXml?: string | null,
  ): Promise<string> {
    const id = this._normalizeTaxRegisterId(taxRegisterId);
    if (!ticketXml) {
      await this._appendDocuments(id, [{ xml: rawXml }]);
      return rawXml;
    }

    const receipt = parseTaxTicket(ticketXml);
    if (!receipt) {
      throw new Error('Квитанція сервера не містить даних.');
    }
    const head = this._getDocumentHead(rawXml);
    // Offline documents are sent in packages and have no receipt of their own; their fiscal
    // number is the locally generated one.
    if (this._toBoolean(head.OFFLINE)) {
      throw new Error('Офлайн документ не має квитанції сервера.');
    }
    this._assertTicketMatches(receipt, head);

    const rejection = getTaxTicketError(receipt);
    if (rejection) {
      throw new Error(rejection);
    }

    const xml = setDocumentFiscalNumber(rawXml, receipt.ORDERTAXNUM);
    const offlineCredentials =
      Number(head.DOCTYPE) === TaxDocumentType.OPEN_SHIFT &&
      this._hasValue(receipt.OFFLINESESSIONID) &&
      this._hasValue(receipt.OFFLINESEED)
        ? this._toOfflineCredentials({
            OfflineSessionId: receipt.OFFLINESESSIONID,
            OfflineSeed: receipt.OFFLINESEED,
          })
        : undefined;

    await this._appendDocuments(id, [{ xml, ticketXml, offlineCredentials }]);
    return xml;
  }

  // Continues a document offline after its online attempt failed. originalXml is that document,
  // unsaved, at the next local number. One journal write stores:
  // - the original, marked as revoked (REVOKED): the totals and the systems that receive the
  //   documents ignore it, and if the server registered it, the upload revokes it there;
  // - OfflineBegin with the original's issuer data and UID, offline number 1;
  // - the original converted to an offline document, offline number 2: in its header only the
  //   local number, the time, the offline fiscal number and OFFLINE change; its body stays
  //   byte-identical.
  // Offline readiness is checked before anything is saved. Returns the offline copy's XML.
  async startOfflineSession(
    taxRegisterId: TaxRegisterContextId,
    originalXml: string,
  ): Promise<string> {
    const id = this._normalizeTaxRegisterId(taxRegisterId);
    await this.validateNextDocument(id, TaxDocumentType.OOFFLINE_BEGIN);
    const state = await this.getState(id);
    validateOfflineSessionStart(state);

    if (!originalXml?.trim().startsWith('<')) {
      throw new Error('Tax document must be raw XML.');
    }
    const head = this._getDocumentHead(originalXml, true);
    const docType = Number(head.DOCTYPE);
    if (
      this._toBoolean(head.OFFLINE) ||
      docType === TaxDocumentType.OOFFLINE_BEGIN ||
      docType === TaxDocumentType.OFFLINE_END
    ) {
      throw new Error(
        'Офлайн сесію починає лише документ, який надсилали онлайн.',
      );
    }

    const now = await this._getDocumentClock(id);
    const orderDate = formatOrderDate(now);
    const orderTime = formatOrderTime(now);
    const originalNumLocal = Number(head.ORDERNUM);
    const offlineBeginXml = TaxDocumentUtility.getChekDoc(
      createDocumentHead({
        docType: TaxDocumentType.OOFFLINE_BEGIN,
        uid: this._text(head.UID),
        orderDate,
        orderTime,
        orderNumber: originalNumLocal + 1,
        issuer: this._getHeadIssuer(head),
        offline: {
          sessionId: state.OfflineSessionId,
          seed: state.OfflineSeed,
          localNum: 1,
        },
      }),
    );

    const copyNumLocal = originalNumLocal + 2;
    const copyFiscalNumber = createOfflineFiscalNumber(
      state.OfflineSessionId,
      2,
      getOfflineControlNumber(
        getOfflineControlString({
          seed: state.OfflineSeed,
          orderDate,
          orderTime,
          orderNumber: copyNumLocal,
          cashRegisterNum: this._text(head.CASHREGISTERNUM),
          cashDeskNum: this._text(head.CASHDESKNUM),
          checkTotal: this._getCheckTotal(originalXml),
        }),
      ),
    );
    const offlineCopyXml = this._toOfflineCopy(originalXml, {
      orderDate,
      orderTime,
      orderNumber: copyNumLocal,
      fiscalNumber: copyFiscalNumber,
    });

    await this._appendDocuments(id, [
      { xml: this._markRevoked(originalXml) },
      { xml: offlineBeginXml },
      { xml: offlineCopyXml },
    ]);
    return offlineCopyXml;
  }

  // Header of the next document, after the checks of validateNextDocument. The context gives:
  // - UID (options.createUid), ORDERDATE/ORDERTIME (with the server time correction when it is
  //   on), ORDERNUM, and TESTING of the current shift;
  // - the issuer: the register's TaxObject in the snapshot, with request.issuer replacing its
  //   values, and the register's fiscal number;
  // - in an open offline session: OFFLINE, the offline fiscal number and, from the third
  //   document of the session, PREVDOCHASH.
  // The session start and end have their own methods. The header is valid until the next
  // document is saved, so create, build and save one document at a time per register.
  async createDocumentHead(
    taxRegisterId: TaxRegisterContextId,
    request: TaxDocumentHeadRequest,
  ): Promise<CHECKHEAD> {
    const id = this._normalizeTaxRegisterId(taxRegisterId);
    const docType = request?.docType;
    if (Number(docType) === TaxDocumentType.OOFFLINE_BEGIN) {
      throw new Error('Початок офлайн сесії створює startOfflineSession.');
    }
    if (Number(docType) === TaxDocumentType.OFFLINE_END) {
      throw new Error('Завершення офлайн сесії створює createOfflineSessionEnd.');
    }
    if (
      this._hasValue(request.checkTotal) &&
      !/^-?\d+\.\d{2}$/.test(String(request.checkTotal))
    ) {
      throw new Error(
        `Сума чека для контрольного числа має формат 0.00: ${request.checkTotal}`,
      );
    }

    await this.validateNextDocument(id, docType, request.docSubType);
    const context = await this._getContext(id);
    const state = await this.getState(id);
    return this._createHead(id, state, {
      docType,
      docSubType: request.docSubType,
      issuer: this._getDocumentIssuer(id, context, request.issuer, request.cashier),
      checkTotal: request.checkTotal,
      testing:
        Number(docType) === TaxDocumentType.OPEN_SHIFT
          ? !!request.testing
          : state.Testing,
    });
  }

  // The end-session document (OfflineEnd) of the open session. It is not saved: send it in the
  // final package and save it with completeOfflineSession once the server accepts it. It takes
  // the issuer data of the session's OfflineBegin, as written, so both ends of the session
  // agree, and carries the hash of the session's last document.
  async createOfflineSessionEnd(
    taxRegisterId: TaxRegisterContextId,
    cashier: string,
  ): Promise<string> {
    const id = this._normalizeTaxRegisterId(taxRegisterId);
    await this.validateNextDocument(id, TaxDocumentType.OFFLINE_END);
    const context = await this._getContext(id);
    const state = await this.getState(id);

    const documents = await this._getDocuments(id);
    const offlineBegin = [...documents]
      .reverse()
      .find((document) => document.CheckDocType === 'OfflineBegin');
    const issuer = offlineBegin
      ? {
          ...this._getHeadIssuer(this._getDocumentHead(offlineBegin.xmlCheck, true)),
          cashier: this._toCashier(cashier),
        }
      : this._getDocumentIssuer(id, context, undefined, cashier);

    return TaxDocumentUtility.getChekDoc(
      await this._createHead(id, state, {
        docType: TaxDocumentType.OFFLINE_END,
        issuer,
      }),
    );
  }

  private async _createHead(
    id: string,
    state: TaxRegisterState,
    values: {
      docType?: number;
      docSubType?: number;
      issuer: DocumentIssuer;
      checkTotal?: string | null;
      testing?: boolean;
    },
  ): Promise<CHECKHEAD> {
    const now = await this._getDocumentClock(id);
    return createDocumentHead({
      docType: values.docType,
      docSubType: values.docSubType,
      uid: this._createUid(),
      orderDate: formatOrderDate(now),
      orderTime: formatOrderTime(now),
      orderNumber: Number(state.NextLocalNum),
      issuer: values.issuer,
      testing: values.testing,
      offline: state.OfflineSession
        ? await this._getOfflineNumbering(id, state, values.checkTotal)
        : null,
    });
  }

  // Numbering of the next document of the open session, from the credentials in force.
  private async _getOfflineNumbering(
    id: string,
    state: TaxRegisterState,
    checkTotal?: string | null,
  ): Promise<OfflineDocumentNumbering> {
    const localNum = Number(state.OfflineNextLocalNum);
    if (
      !this._hasValue(state.OfflineSessionId) ||
      !this._hasValue(state.OfflineSeed) ||
      !Number.isInteger(localNum) ||
      localNum < 1
    ) {
      throw new Error(
        'Дані офлайн сесії відсутні або некоректні: офлайн документ не створюється.',
      );
    }

    let previousDocumentHash: string | null = null;
    if (isPreviousDocumentHashRequired(localNum)) {
      previousDocumentHash = await this.getLastDocHash(id);
      if (!previousDocumentHash) {
        throw new Error(
          'Немає попереднього документа офлайн сесії для PREVDOCHASH.',
        );
      }
    }

    return {
      sessionId: String(state.OfflineSessionId),
      seed: String(state.OfflineSeed),
      localNum,
      previousDocumentHash,
      checkTotal: this._hasValue(checkTotal) ? String(checkTotal) : null,
    };
  }

  // Issuer of new documents: the register's TaxObject in the snapshot, overridden by the
  // caller's values; the register number is always the register's fiscal number. Throws when a
  // value the schema requires is missing.
  private _getDocumentIssuer(
    id: string,
    context: TaxRegisterContext<TConfig>,
    override: Partial<DocumentIssuer> | undefined,
    cashier: string,
  ): DocumentIssuer {
    const taxObject = context?.registerState?.TaxObject;
    const registrar = taxObject?.TransactionsRegistrars?.find(
      (item) => String(item?.NumFiscal ?? '').trim() === id,
    );
    const replaced = Object.fromEntries(
      Object.entries(override || {}).filter(([, value]) => this._hasValue(value)),
    ) as Partial<DocumentIssuer>;
    const issuer: DocumentIssuer = {
      tin: this._text(taxObject?.Tin),
      ipn: this._text(taxObject?.Ipn) || undefined,
      organizationName: this._text(taxObject?.OrgName),
      pointName: this._text(taxObject?.Name),
      pointAddress: this._text(taxObject?.Address),
      cashDeskNum: Number(registrar?.NumLocal),
      ...replaced,
      cashRegisterNum: id,
      cashier: this._toCashier(cashier),
    };

    const missing = [
      !this._hasValue(issuer.tin) && 'TIN',
      !this._hasValue(issuer.organizationName) && 'ORGNM',
      !this._hasValue(issuer.pointName) && 'POINTNM',
      !(Number.isInteger(Number(issuer.cashDeskNum)) && Number(issuer.cashDeskNum) > 0) &&
        'CASHDESKNUM',
    ].filter(Boolean);
    if (missing.length) {
      throw new Error(
        `Немає даних ПРРО для документа: ${missing.join(', ')}. ` +
          'Ініціалізуйте контекст зі станом, що містить TaxObject, або передайте issuer.',
      );
    }
    return issuer;
  }

  // Issuer data of a document, as written in its header (parsed with keepText).
  private _getHeadIssuer(head: TaxDocumentHead): DocumentIssuer {
    return {
      tin: this._text(head.TIN),
      ipn: this._text(head.IPN) || undefined,
      organizationName: this._text(head.ORGNM),
      pointName: this._text(head.POINTNM),
      pointAddress: this._text(head.POINTADDR),
      cashRegisterNum: this._text(head.CASHREGISTERNUM),
      cashDeskNum: Number(head.CASHDESKNUM),
      cashier: this._text(head.CASHIER),
    };
  }

  private _toCashier(cashier: string): string {
    const name = cashier == null ? '' : String(cashier).trim();
    if (!name) {
      throw new Error('Не вказано касира документа.');
    }
    return name;
  }

  private _createUid(): string {
    const createUid =
      this._options.createUid ??
      (() =>
        (
          globalThis as { crypto?: { randomUUID?: () => string } }
        ).crypto?.randomUUID?.());
    const uid = createUid();
    if (!uid) {
      throw new Error(
        'Немає генератора UID документів: передайте createUid в опціях сервісу.',
      );
    }
    return uid;
  }

  // The original as an offline document. In the header, ORDERDATE, ORDERTIME and ORDERNUM get
  // the new values and the offline ORDERTAXNUM and OFFLINE go after VER, their schema position;
  // elements of a registered or revoked document are dropped. The body is not touched.
  private _toOfflineCopy(
    xml: string,
    values: {
      orderDate: string;
      orderTime: string;
      orderNumber: number;
      fiscalNumber: string;
    },
  ): string {
    const headEnd = Math.max(
      xml.indexOf('</CHECKHEAD>'),
      xml.indexOf('</ZREPHEAD>'),
    );
    if (headEnd < 0) {
      throw new Error('Tax document CHECKHEAD or ZREPHEAD is missing.');
    }

    let head = xml.slice(0, headEnd);
    head = this._setElement(head, 'ORDERDATE', values.orderDate);
    head = this._setElement(head, 'ORDERTIME', values.orderTime);
    head = this._setElement(head, 'ORDERNUM', String(values.orderNumber));
    for (const name of ['ORDERTAXNUM', 'OFFLINE', 'PREVDOCHASH', 'REVOKED']) {
      head = head.replace(new RegExp(`<${name}>[^<]*</${name}>\\s*`), '');
    }

    const ver = head.indexOf('</VER>');
    if (ver < 0) {
      throw new Error('Tax document VER is missing.');
    }
    const at = ver + '</VER>'.length;
    const offlineElements =
      `<ORDERTAXNUM>${values.fiscalNumber}</ORDERTAXNUM>` +
      '<OFFLINE>true</OFFLINE>';
    return `${head.slice(0, at)}${offlineElements}${head.slice(at)}${xml.slice(headEnd)}`;
  }

  private _setElement(xml: string, name: string, value: string): string {
    const element = new RegExp(`<${name}>[^<]*</${name}>`);
    if (!element.test(xml)) {
      throw new Error(`Tax document ${name} is missing.`);
    }
    return xml.replace(element, () => `<${name}>${value}</${name}>`);
  }

  // CHECKTOTAL/SUM formatted 0.00 for the control number; null for documents without one.
  private _getCheckTotal(xml: string): string | null {
    const sum = parseXml<ParsedTaxDocument>(xml, { keepText: true }).CHECK
      ?.CHECKTOTAL?.SUM;
    if (!this._hasValue(sum)) {
      return null;
    }

    const text = String(sum).trim();
    if (/^-?\d+\.\d{2}$/.test(text)) {
      return text;
    }
    const number = Number(text);
    return Number.isFinite(number) ? number.toFixed(2) : null;
  }

  private _text(value: unknown): string {
    return this._hasValue(value) ? String(value) : '';
  }

  // Sets <REVOKED>true</REVOKED> at its schema position: after VER, ORDERTAXNUM, OFFLINE and
  // PREVDOCHASH, before STORNED and TESTING.
  private _markRevoked(xml: string): string {
    const element = '<REVOKED>true</REVOKED>';
    const existing = /<REVOKED>[^<]*<\/REVOKED>/;
    if (existing.test(xml)) {
      return xml.replace(existing, () => element);
    }

    for (const previous of ['PREVDOCHASH', 'OFFLINE', 'ORDERTAXNUM', 'VER']) {
      const closing = `</${previous}>`;
      const at = xml.indexOf(closing);
      if (at >= 0) {
        const end = at + closing.length;
        return `${xml.slice(0, end)}${element}${xml.slice(end)}`;
      }
    }
    for (const next of ['<STORNED>', '<TESTING>', '</CHECKHEAD>', '</ZREPHEAD>']) {
      const at = xml.indexOf(next);
      if (at >= 0) {
        return `${xml.slice(0, at)}${element}${xml.slice(at)}`;
      }
    }
    return xml;
  }

  // Checks the numbering of new documents and saves them with one journal write; the queue of
  // documents for other systems gets each XML as well.
  private async _appendDocuments(
    id: string,
    entries: Array<{
      xml: string;
      ticketXml?: string;
      offlineCredentials?: OfflineSessionState;
    }>,
  ): Promise<void> {
    const newDocuments = entries.map((entry) =>
      this._withJournalData(this._parseDocument(entry.xml), entry),
    );
    const context = await this._getContext(id);
    if (!context) {
      throw new Error(
        `Tax register context not found. TaxRegister fiscal number ${id}`,
      );
    }

    const documents = await this._getDocuments(id);
    let expectedLocalNumber = this._getCurrentNextOrderNumber(
      context,
      documents,
    );
    for (const document of newDocuments) {
      if (document.NumLocal !== expectedLocalNumber) {
        throw new Error(
          `Tax document local number ${document.NumLocal} is invalid. Expected ${expectedLocalNumber}.`,
        );
      }
      expectedLocalNumber++;
    }

    for (const entry of entries) {
      await this._stageDocument(id, entry.xml);
    }
    await this._saveDocuments(id, [...documents, ...newDocuments]);
  }

  // Adds the receipt and the credentials the document put in force; absent values are not
  // written, so entries stay as they were for documents without them.
  private _withJournalData(
    document: DocumentItem,
    data: { ticketXml?: string; offlineCredentials?: OfflineSessionState },
  ): TaxJournalDocument {
    const entry = document as TaxJournalDocument;
    if (data.ticketXml) {
      entry.ticketXml = data.ticketXml;
    }
    if (data.offlineCredentials) {
      entry.offlineCredentials = data.offlineCredentials;
    }
    return entry;
  }

  // keepText: values as written, for copying them into another document.
  private _getDocumentHead(rawXml: string, keepText = false): TaxDocumentHead {
    const parsedDocument = parseXml<ParsedTaxDocument>(rawXml, { keepText });
    const head =
      parsedDocument?.CHECK?.CHECKHEAD || parsedDocument?.ZREP?.ZREPHEAD;
    if (!head) {
      throw new Error('Tax document CHECKHEAD or ZREPHEAD is missing.');
    }
    return head;
  }

  private _assertTicketMatches(ticket: TaxTicket, head: TaxDocumentHead): void {
    const ticketUid = (ticket.UID || '').toString().trim().toLowerCase();
    const documentUid = (head.UID || '').toString().trim().toLowerCase();
    if (ticketUid && documentUid && ticketUid !== documentUid) {
      throw new Error(
        `Квитанція сервера належить іншому документу (UID ${ticket.UID}).`,
      );
    }
    if (
      this._hasValue(ticket.ORDERNUM) &&
      Number(ticket.ORDERNUM) !== Number(head.ORDERNUM)
    ) {
      throw new Error(
        `Квитанція сервера належить іншому документу (номер ${ticket.ORDERNUM}, очікується ${head.ORDERNUM}).`,
      );
    }
  }

  // The server state reports Closed for a register whose registration was cancelled while its
  // shift is still open. The context is disabled while its stored state reports it.
  private _isRegistrationCancelled(
    context: TaxRegisterContext<TConfig> | null,
  ): boolean {
    return this._toBoolean(context?.registerState?.Closed as boolean | string);
  }

  private _toOfflineCredentials(
    state: OfflineSessionState,
  ): OfflineSessionState {
    return {
      OfflineSessionId: String(state.OfflineSessionId),
      OfflineSeed: String(state.OfflineSeed),
    };
  }

  private _hasValue(value: unknown): boolean {
    return value !== null && value !== undefined && value !== '';
  }

  async getStagedDocumentBatch(
    limit = OFFLINE_PACKAGE_CHUNK_SIZE,
  ): Promise<string[]> {
    const normalizedLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
    const keys = (await this._storage.keys()).filter((key) =>
      key.startsWith(TAX_DOCUMENT_STAGE_KEY_PREFIX),
    );
    const stagedDocuments: string[] = [];
    for (const key of keys) {
      const documents = await this._storage.get<string[]>(key);
      stagedDocuments.push(...(documents || []));
    }

    return stagedDocuments.slice(0, normalizedLimit);
  }

  async acknowledgeStagedDocuments(xmlDocuments: string[]): Promise<void> {
    const documentsToRemove = (xmlDocuments || []).filter(Boolean);
    if (!documentsToRemove.length) {
      return;
    }

    const keys = (await this._storage.keys()).filter((key) =>
      key.startsWith(TAX_DOCUMENT_STAGE_KEY_PREFIX),
    );
    for (const key of keys) {
      const documents =
        (await this._storage.get<string[]>(key)) || [];
      const remainingDocuments = documents.filter((document) => {
        const index = documentsToRemove.indexOf(document);
        if (index < 0) {
          return true;
        }
        documentsToRemove.splice(index, 1);
        return false;
      });
      if (remainingDocuments.length !== documents.length) {
        await this._storage.set(key, remainingDocuments);
      }
      if (!documentsToRemove.length) {
        break;
      }
    }
  }

  async validateNextDocument(
    taxRegisterId: TaxRegisterContextId,
    docType?: number | string,
    docSubType?: number | string,
  ): Promise<void> {
    // A cancelled registration disables the register for every document, Z-reports included.
    if (this._isRegistrationCancelled(await this._getContext(taxRegisterId))) {
      throw new Error('Реєстрацію ПРРО скасовано: нові документи не створюються.');
    }

    // Z-reports do not have DOCTYPE or DOCSUBTYPE in ZREPHEAD.
    if (
      (docType === null || docType === undefined) &&
      (docSubType === null || docSubType === undefined)
    ) {
      return;
    }

    const normalizedDocType = Number(docType);
    const validDocTypes = [
      TaxDocumentType.SALE_GOODS,
      TaxDocumentType.OPEN_SHIFT,
      TaxDocumentType.CLOSE_SHIFT,
      TaxDocumentType.OOFFLINE_BEGIN,
      TaxDocumentType.OFFLINE_END,
    ];
    if (!validDocTypes.includes(normalizedDocType)) {
      throw new Error(`Tax document DOCTYPE ${docType} is invalid.`);
    }

    const normalizedDocSubType =
      docSubType === null || docSubType === undefined ? 0 : Number(docSubType);
    const validSaleSubTypes = [
      0,
      TaxDocumentSubType.CHECK_RETURN,
      TaxDocumentSubType.SERVICE_DEPOSIT,
      TaxDocumentSubType.ADDITIONAL_DEPOSIT,
      TaxDocumentSubType.SERVICE_ISSUE,
      TaxDocumentSubType.CHECK_STORNO,
    ];
    if (
      normalizedDocType === TaxDocumentType.SALE_GOODS
        ? !validSaleSubTypes.includes(normalizedDocSubType)
        : normalizedDocSubType !== 0
    ) {
      throw new Error(
        `Tax document DOCSUBTYPE ${docSubType} is invalid for DOCTYPE ${docType}.`,
      );
    }

    const state = await this.getState(taxRegisterId);
    const shiftOpened = Number(state.ShiftState) === 1;
    const offlineSessionOpened = state.OfflineSession;

    // A new document in an open session is created offline: apply the session limits. The
    // end-session document is exempt, so the session can always be closed.
    if (
      offlineSessionOpened &&
      normalizedDocType !== TaxDocumentType.OOFFLINE_BEGIN &&
      normalizedDocType !== TaxDocumentType.OFFLINE_END
    ) {
      await this._validateOfflineSessionLimits(taxRegisterId, state);
    }

    if (normalizedDocType === TaxDocumentType.SALE_GOODS) {
      if (!shiftOpened) {
        throw new Error(
          'Код помилки: 5 ShiftNotOpened\r\nЗміну для ПРРО наразі не відкрито',
        );
      }
      if (state.ZRepPresent) {
        throw new Error(
          'Код помилки: 8 ZRepAlreadyRegistered\r\nZ-звіт наразі зареєстрований для поточної зміни',
        );
      }
      return;
    }

    if (normalizedDocType === TaxDocumentType.OOFFLINE_BEGIN) {
      if (!this.offlineSettings.offlineEnabled) {
        throw new Error('Роботу ПРРО в режимі офлайн вимкнено в налаштуваннях.');
      }
      if (offlineSessionOpened) {
        throw new Error(
          'Код помилки: 14 OfflineSessionAlreadyOpened\r\nОфлайн сесія вже відкрита',
        );
      }
      if (this._isOffline(state)) {
        throw new Error(
          'Неможливо почати нову офлайн сесію, поки не надіслано попередній офлайн пакет.',
        );
      }
      return;
    }

    if (normalizedDocType === TaxDocumentType.OFFLINE_END) {
      if (!offlineSessionOpened) {
        throw new Error(
          'Код помилки: 15 OfflineSessionNotOpened\r\nОфлайн сесія наразі не відкрита',
        );
      }
      return;
    }

    if (normalizedDocType === TaxDocumentType.OPEN_SHIFT) {
      if (shiftOpened && Number(state.OfflineNextLocalNum) !== 2) {
        throw new Error(
          'Код помилки: 4 ShiftAlreadyOpened\r\nЗміну для ПРРО наразі відкрито',
        );
      }
      return;
    }

    if (normalizedDocType === TaxDocumentType.CLOSE_SHIFT && !shiftOpened) {
      throw new Error(
        'Код помилки: 5 ShiftNotOpened\r\nЗміну для ПРРО наразі не відкрито',
      );
    }
  }

  // Throws when the open offline session has reached the configured number of documents or
  // duration. The duration is counted from OfflineBegin with the clock used for document time.
  private async _validateOfflineSessionLimits(
    taxRegisterId: TaxRegisterContextId,
    state: TaxRegisterState,
  ): Promise<void> {
    const settings = this.offlineSettings;

    const nextOfflineNum = Number(state.OfflineNextLocalNum);
    if (
      Number.isInteger(nextOfflineNum) &&
      nextOfflineNum > settings.maxOfflineDocuments
    ) {
      throw new Error(
        `Досягнуто максимальну кількість документів офлайн сесії (${settings.maxOfflineDocuments}). ` +
          'Нові документи можна створити після надсилання офлайн пакета на сервер.',
      );
    }

    const documents = await this._getDocuments(taxRegisterId);
    const offlineBegin = [...documents]
      .reverse()
      .find((document) => document.CheckDocType === 'OfflineBegin');
    const startedAt = offlineBegin?.DocDateTime
      ? new Date(offlineBegin.DocDateTime).getTime()
      : NaN;
    if (!Number.isFinite(startedAt)) {
      return;
    }

    const now = await this._getDocumentClock(taxRegisterId);
    const elapsedMinutes = (now.getTime() - startedAt) / 60_000;
    if (elapsedMinutes >= settings.maxOfflineSessionDurationMinutes) {
      throw new Error(
        `Перевищено максимальну тривалість офлайн сесії (${settings.maxOfflineSessionDurationMinutes / 60} год). ` +
          'Нові документи можна створити після надсилання офлайн пакета на сервер.',
      );
    }
  }

  // Document times use the server-time estimate when that correction is enabled; without a
  // stored server time, the device clock.
  private async _getDocumentClock(
    taxRegisterId: TaxRegisterContextId,
  ): Promise<Date> {
    if (this._readSettings().useServerTimeCorrection) {
      return this.getServerTime(taxRegisterId).catch(() => new Date());
    }
    return new Date();
  }

  async getDocuments(
    taxRegisterId: TaxRegisterContextId,
  ): Promise<TaxJournalDocument[]> {
    const id = this._normalizeTaxRegisterId(taxRegisterId);
    const context = await this._getContext(id);
    if (!context) {
      throw new Error(
        `Tax register context not found. TaxRegister fiscal number ${id}`,
      );
    }

    return this._getDocuments(id);
  }

  async getLastDocHash(
    taxRegisterId: TaxRegisterContextId,
  ): Promise<string | null> {
    const documents = await this.getDocuments(taxRegisterId);
    const lastDocument = documents[documents.length - 1];
    if (!lastDocument) {
      return null;
    }

    return hashTaxDocument(lastDocument.xmlCheck);
  }

  async clearOfflineDocuments(
    taxRegisterId: TaxRegisterContextId,
  ): Promise<void> {
    const id = this._normalizeTaxRegisterId(taxRegisterId);
    const context = await this._getContext(id);
    if (!context) {
      throw new Error(
        `Tax register context not found. TaxRegister fiscal number ${id}`,
      );
    }

    const documents = await this._getDocuments(id);
    const remainingDocuments = documents.filter(
      (document) => this._getOfflineLocalNumber(document.NumFiscal) === null,
    );
    await this._saveDocuments(id, remainingDocuments);
    await this._saveContext(id, {
      ...context,
      registerState: {
        ...context.registerState,
        OfflineNextLocalNum: '1',
      },
    });
  }

  // The latest session's offline documents in journal order, starting inclusively at the
  // server's next offline number. Empty when the server already has all of them.
  async getOfflineDocuments(
    taxRegisterId: TaxRegisterContextId,
    offlineNextLocalNum: number,
  ): Promise<string[]> {
    const id = this._normalizeTaxRegisterId(taxRegisterId);
    const context = await this._getContext(id);
    if (!context) {
      throw new Error(
        `Tax register context not found. TaxRegister fiscal number ${id}`,
      );
    }

    const documents = await this._getDocuments(id);
    const docs: string[] = [];
    let sessionId: string | null = null;
    let localNextOfflineNum: number | null = null;
    for (let index = documents.length - 1; index >= 0; index--) {
      const offlineLocalNum = this._getOfflineLocalNumber(
        documents[index].NumFiscal,
      );
      if (offlineLocalNum === null) {
        break;
      }

      // Only the documents of the latest offline session belong to the package.
      const documentSessionId = this._getOfflineSessionId(
        documents[index].NumFiscal,
      );
      if (sessionId === null) {
        sessionId = documentSessionId;
        localNextOfflineNum = offlineLocalNum + 1;
      } else if (documentSessionId !== sessionId) {
        break;
      }

      docs.unshift(documents[index].xmlCheck);
      if (offlineLocalNum === offlineNextLocalNum) {
        return docs;
      }
    }

    // The server already has every document of the session.
    if (localNextOfflineNum !== null && offlineNextLocalNum === localNextOfflineNum) {
      return [];
    }

    // A gap or an unknown server position is not permission to skip documents.
    throw new Error(
      `Офлайн документ №${offlineNextLocalNum}, який очікує сервер, не знайдено в локальних документах.`,
    );
  }

  // Marks the current session's OfflineBegin to revoke the original online document. Allowed
  // only while the server has accepted nothing from this session (offline counter 1) and
  // expects OfflineBegin's number next, which means it accepted the original.
  async revokeLastOnline(
    taxRegisterId: TaxRegisterContextId,
    NextLocalNum: number,
    OfflineNextLocalNum: string | number,
  ): Promise<boolean> {
    const id = this._normalizeTaxRegisterId(taxRegisterId);
    if (String(OfflineNextLocalNum) !== '1') {
      return false;
    }

    const documents = await this.getDocuments(id);
    let offlineBeginIndex = -1;

    for (let index = documents.length - 1; index >= 0; index--) {
      if (documents[index].CheckDocType === 'OfflineBegin') {
        offlineBeginIndex = index;
        break;
      }
    }

    const offlineBegin = documents[offlineBeginIndex];
    const firstOfflineDocument = documents[offlineBeginIndex + 1];
    if (
      !offlineBegin ||
      !firstOfflineDocument ||
      offlineBegin.NumLocal !== Number(NextLocalNum)
    ) {
      return false;
    }

    if (
      firstOfflineDocument.CheckDocType &&
      firstOfflineDocument.CheckDocType !== 'SaleGoods'
    ) {
      return false;
    }

    const xmlWithoutRevoke = offlineBegin.xmlCheck.replace(
      '<REVOKELASTONLINEDOC>true</REVOKELASTONLINEDOC>',
      '',
    );
    const updatedXml = xmlWithoutRevoke.replace(
      '</CASHREGISTERNUM>',
      `</CASHREGISTERNUM>
<REVOKELASTONLINEDOC>true</REVOKELASTONLINEDOC>`,
    );
    documents[offlineBeginIndex] = this._withJournalData(
      this._parseDocument(updatedXml),
      offlineBegin,
    );
    await this._saveDocuments(id, documents);
    return true;
  }

  private async _getContext(
    taxRegisterId: TaxRegisterContextId,
  ): Promise<TaxRegisterContext<TConfig> | null> {
    const id = this._normalizeTaxRegisterId(taxRegisterId);
    const cachedContext = this._contexts.get(id);
    if (cachedContext) {
      return cachedContext;
    }

    const context = await this._storage.get<TaxRegisterContext<TConfig>>(
      this._getStorageKey(id),
    );
    if (context) {
      this._contexts.set(id, context);
    }

    return context || null;
  }

  private async _saveContext(
    taxRegisterId: TaxRegisterContextId,
    context: TaxRegisterContext<TConfig>,
  ): Promise<void> {
    const id = this._normalizeTaxRegisterId(taxRegisterId);
    await this._storage.set(this._getStorageKey(id), context);
    this._contexts.set(id, context);
  }

  private _getTaxRegisterId(taxConfig: TConfig): string {
    return this._normalizeTaxRegisterId(taxConfig?.taxRegister?.fiscalNumber);
  }

  private _getStorageKey(taxRegisterId: TaxRegisterContextId): string {
    const id = this._normalizeTaxRegisterId(taxRegisterId);
    return `${TAX_REGISTER_CONTEXT_KEY_PREFIX}${id}`;
  }

  private async _getDocuments(
    taxRegisterId: TaxRegisterContextId,
  ): Promise<TaxJournalDocument[]> {
    const id = this._normalizeTaxRegisterId(taxRegisterId);
    return (
      (await this._storage.get<TaxJournalDocument[]>(
        this._getDocumentsStorageKey(id),
      )) || []
    );
  }

  private async _saveDocuments(
    taxRegisterId: TaxRegisterContextId,
    documents: TaxJournalDocument[],
  ): Promise<void> {
    const id = this._normalizeTaxRegisterId(taxRegisterId);
    await this._storage.set(this._getDocumentsStorageKey(id), documents);
  }

  private async _stageDocument(
    taxRegisterId: string,
    xmlDocument: string,
  ): Promise<void> {
    const storageKey = this._getStageStorageKey(taxRegisterId);
    const documents =
      (await this._storage.get<string[]>(storageKey)) || [];
    await this._storage.set(storageKey, [...documents, xmlDocument]);
  }

  private _getDocumentsStorageKey(taxRegisterId: TaxRegisterContextId): string {
    const id = this._normalizeTaxRegisterId(taxRegisterId);
    return `${TAX_REGISTER_DOCUMENTS_KEY_PREFIX}${id}`;
  }

  private _getStageStorageKey(taxRegisterId: TaxRegisterContextId): string {
    const id = this._normalizeTaxRegisterId(taxRegisterId);
    return `${TAX_DOCUMENT_STAGE_KEY_PREFIX}${id}`;
  }

  private _parseDocument(rawXml: string): DocumentItem {
    if (!rawXml?.trim().startsWith('<')) {
      throw new Error('Tax document must be raw XML.');
    }

    const parsedDocument = parseXml<ParsedTaxDocument>(rawXml, {
      keepText: FISCAL_NUMBER_ELEMENTS,
    });
    const head =
      parsedDocument?.CHECK?.CHECKHEAD || parsedDocument?.ZREP?.ZREPHEAD;
    if (!head) {
      throw new Error('Tax document CHECKHEAD or ZREPHEAD is missing.');
    }

    const orderNumber = Number(head.ORDERNUM);
    if (!Number.isInteger(orderNumber) || orderNumber < 0) {
      throw new Error('Tax document ORDERNUM is invalid.');
    }

    const document = new DocumentItem();
    document.NumFiscal = head.ORDERTAXNUM?.toString().trim();
    document.NumLocal = orderNumber;
    document.DocDateTime = this._getDocumentDateTime(head);
    document.DocClass = parsedDocument.CHECK ? 'Check' : 'ZRep';
    document.CheckDocType = this._getDocumentType(head);
    document.CheckDocSubType = this._getDocumentSubType(head);
    document.Revoked = this._toBoolean(head.REVOKED);
    document.Storned = this._toBoolean(head.REVOKELASTONLINEDOC);
    document.xmlCheck = rawXml;
    return document;
  }

  private _getDocumentType(head: TaxDocumentHead): string {
    const documentType = Number(head.DOCTYPE);
    if (documentType === TaxDocumentType.SALE_GOODS) {
      return 'SaleGoods';
    }
    if (documentType === TaxDocumentType.OPEN_SHIFT) {
      return 'OpenShift';
    }
    if (documentType === TaxDocumentType.CLOSE_SHIFT) {
      return 'CloseShift';
    }
    if (documentType === TaxDocumentType.OOFFLINE_BEGIN) {
      return 'OfflineBegin';
    }
    if (documentType === TaxDocumentType.OFFLINE_END) {
      return 'OfflineEnd';
    }
    return '';
  }

  private _getDocumentSubType(head: TaxDocumentHead): string {
    const documentSubType = Number(head.DOCSUBTYPE);
    if (documentSubType === TaxDocumentSubType.SERVICE_DEPOSIT) {
      return 'ServiceDeposit';
    }
    if (documentSubType === TaxDocumentSubType.SERVICE_ISSUE) {
      return 'ServiceIssue';
    }
    if (documentSubType === TaxDocumentSubType.ADDITIONAL_DEPOSIT) {
      return 'AdditionalDeposit';
    }
    if (documentSubType === TaxDocumentSubType.CHECK_RETURN) {
      return 'CheckReturn';
    }
    if (documentSubType === TaxDocumentSubType.CHECK_STORNO) {
      return 'CheckStorno';
    }
    return 'CheckGoods';
  }

  private _getDocumentDateTime(head: TaxDocumentHead): string {
    if (head.ORDERDATE === undefined || head.ORDERTIME === undefined) {
      return '';
    }

    const { year, month, day, hours, minutes, seconds } = parseOrderDateTime(
      head.ORDERDATE,
      head.ORDERTIME,
    );
    return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}`;
  }

  private _calculateLastTotals(
    storedTotals: LastShiftTotalsResponse,
    documents: DocumentItem[],
  ): LastShiftTotalsResponse {
    const documentsInShift: Array<{
      item: DocumentItem;
      parsed: ParsedTaxDocument;
    }> = [];
    let shiftStart: {
      item: DocumentItem;
      parsed: ParsedTaxDocument;
    } = null;

    for (let index = documents.length - 1; index >= 0; index--) {
      const item = documents[index];
      if (item.CheckDocType === 'OfflineBegin') {
        index--;
        continue;
      }
      const parsed = parseXml<ParsedTaxDocument>(item.xmlCheck, {
        keepText: FISCAL_NUMBER_ELEMENTS,
      });
      if (item.CheckDocType === 'OpenShift') {
        shiftStart = { item, parsed };
        break;
      }
      documentsInShift.push({ item, parsed });
    }

    const result = JSON.parse(
      JSON.stringify(storedTotals || this._createEmptyLastShiftTotals()),
    ) as LastShiftTotalsResponse;
    if (shiftStart) {
      result.ShiftState = 1;
      result.ZRepPresent = false;
      result.Testing = this._toBoolean(
        shiftStart.parsed.CHECK?.CHECKHEAD?.TESTING,
      );
      result.Opened = shiftStart.item.DocDateTime;
      result.OpenName =
        shiftStart.parsed.CHECK?.CHECKHEAD?.CASHIER || result.OpenName;
      result.Closed = null;
      result.CloseName = null;
      result.ZRepFiscalNum = null;
      result.Totals = this._createEmptyShiftTotals();
    } else {
      result.Totals = this._ensureShiftTotals(result.Totals);
    }

    // The server registers a storno with a zero storned amount: the storned check is left out
    // along with the storno itself. A check stored only in the baseline cannot be removed.
    const stornedFiscalNumbers = new Set(
      documentsInShift
        .map((document) => document.parsed.CHECK?.CHECKHEAD)
        .filter(
          (head) =>
            Number(head?.DOCSUBTYPE) === TaxDocumentSubType.CHECK_STORNO &&
            this._hasValue(head.ORDERSTORNUM),
        )
        .map((head) => String(head.ORDERSTORNUM).trim()),
    );

    for (const document of documentsInShift) {
      if (
        this._hasValue(document.item.NumFiscal) &&
        stornedFiscalNumbers.has(String(document.item.NumFiscal).trim())
      ) {
        continue;
      }
      if (document.item.DocClass === 'ZRep') {
        result.ZRepPresent = true;
        result.ZRepFiscalNum = document.item.NumFiscal;
        continue;
      }
      if (document.item.CheckDocType === 'CloseShift') {
        result.ShiftState = 0;
        result.Closed = document.item.DocDateTime;
        result.CloseName =
          document.parsed.CHECK?.CHECKHEAD?.CASHIER || result.CloseName;
        continue;
      }
      if (document.item.Revoked || document.item.Storned) {
        continue;
      }

      this._addCheckTotals(result.Totals, document.parsed);
    }

    return result;
  }

  private _addCheckTotals(
    totals: ShiftTotals,
    document: ParsedTaxDocument,
  ): void {
    const check = document.CHECK;
    if (
      !check ||
      Number(check.CHECKHEAD?.DOCTYPE) !== TaxDocumentType.SALE_GOODS
    ) {
      return;
    }

    const subType = Number(check.CHECKHEAD?.DOCSUBTYPE || 0);
    const sum = this._toNumber(check.CHECKTOTAL?.SUM);
    if (
      subType === TaxDocumentSubType.SERVICE_DEPOSIT ||
      subType === TaxDocumentSubType.ADDITIONAL_DEPOSIT
    ) {
      totals.ServiceInput = this._sum(totals.ServiceInput, sum);
      return;
    }
    // How a storno changes the storned check's contribution is not defined; never count it as a sale.
    if (subType === TaxDocumentSubType.CHECK_STORNO) {
      return;
    }
    if (subType === TaxDocumentSubType.SERVICE_ISSUE) {
      totals.ServiceOutput = this._sum(totals.ServiceOutput, sum);
      return;
    }

    const orderTotals =
      subType === TaxDocumentSubType.CHECK_RETURN ? totals.Ret : totals.Real;
    orderTotals.Sum = this._sum(orderTotals.Sum, sum);
    orderTotals.RndSum = this._sum(
      orderTotals.RndSum,
      this._toNumber(check.CHECKTOTAL?.RNDSUM),
    );
    orderTotals.NoRndSum = this._sum(
      orderTotals.NoRndSum,
      this._toNumber(check.CHECKTOTAL?.NORNDSUM),
    );
    orderTotals.OrdersCount = Number(orderTotals.OrdersCount || 0) + 1;

    for (const payment of this._toRows(check.CHECKPAY?.ROW)) {
      const code = Number(payment.PAYFORMCD);
      const current = orderTotals.PayForm.find(
        (item) => Number(item.PayFormCode) === code,
      );
      if (current) {
        current.Sum = this._sum(current.Sum, this._toNumber(payment.SUM));
      } else {
        orderTotals.PayForm.push({
          PayFormCode: code,
          PayFormName: payment.PAYFORMNM?.toString() || '',
          Sum: this._toNumber(payment.SUM),
        });
      }
    }

    for (const tax of this._toRows(check.CHECKTAX?.ROW)) {
      const type = Number(tax.TYPE);
      const letter = tax.LETTER?.toString() || '';
      const prc = this._toNumber(tax.PRC);
      const sign = this._toBoolean(tax.SIGN as boolean | string);
      const current = orderTotals.Tax.find(
        (item) =>
          Number(item.Type) === type &&
          item.Letter === letter &&
          this._toNumber(item.Prc) === prc &&
          !!item.Sign === sign,
      );
      if (current) {
        current.Turnover = this._sum(
          current.Turnover,
          this._toNumber(tax.TURNOVER),
        );
        current.SourceSum = this._sum(
          current.SourceSum,
          this._toNumber(tax.SOURCESUM),
        );
        current.Sum = this._sum(current.Sum, this._toNumber(tax.SUM));
      } else {
        orderTotals.Tax.push({
          Type: type,
          Name: tax.NAME?.toString() || '',
          Letter: letter,
          Prc: prc,
          Sign: sign,
          Turnover: this._toNumber(tax.TURNOVER),
          SourceSum: this._toNumber(tax.SOURCESUM),
          Sum: this._toNumber(tax.SUM),
        });
      }
    }
  }

  private _ensureShiftTotals(totals: ShiftTotals): ShiftTotals {
    const result = totals || this._createEmptyShiftTotals();
    result.Real = this._ensureOrderTotals(result.Real);
    result.Ret = this._ensureOrderTotals(result.Ret);
    result.ServiceInput = this._toNumber(result.ServiceInput);
    result.ServiceOutput = this._toNumber(result.ServiceOutput);
    return result;
  }

  private _ensureOrderTotals(
    orderTotals: ShiftTotalsOrderType,
  ): ShiftTotalsOrderType {
    const result = orderTotals || this._createEmptyOrderTotals();
    result.PayForm = result.PayForm || [];
    result.Tax = result.Tax || [];
    return result;
  }

  private _createEmptyLastShiftTotals(
    registerState?: TransactionsRegistrarStateResponse,
  ): LastShiftTotalsResponse {
    return {
      UID: null,
      ShiftState: Number(registerState?.ShiftState) === 1 ? 1 : 0,
      ZRepPresent: !!registerState?.ZRepPresent,
      Testing: !!registerState?.Testing,
      Totals: this._createEmptyShiftTotals(),
      Opened: null,
      OpenName: registerState?.Name || null,
      OpenSubjectKeyId: registerState?.SubjectKeyId || null,
      Closed: null,
      CloseName: null,
      CloseSubjectKeyId: null,
      ZRepFiscalNum: null,
    };
  }

  private _createEmptyShiftTotals(): ShiftTotals {
    return {
      Real: this._createEmptyOrderTotals(),
      Ret: this._createEmptyOrderTotals(),
      Cash: null,
      Currency: null,
      ServiceInput: 0,
      ServiceOutput: 0,
    };
  }

  private _createEmptyOrderTotals(): ShiftTotalsOrderType {
    return {
      Sum: 0,
      PwnSumIssued: 0,
      PwnSumReceived: 0,
      RndSum: 0,
      NoRndSum: 0,
      TotalCurrencySum: 0,
      TotalCurrencyCommission: 0,
      OrdersCount: 0,
      TotalCurrencyCost: 0,
      PayForm: [],
      Tax: [],
    };
  }

  private _toRows(
    rows: Record<string, number | string> | Record<string, number | string>[],
  ): Record<string, number | string>[] {
    if (!rows) {
      return [];
    }
    return Array.isArray(rows) ? rows : [rows];
  }

  private _toNumber(value: number | string): number {
    const number = Number(value || 0);
    return Number.isFinite(number) ? number : 0;
  }

  private _sum(first: number, second: number): number {
    return Math.round((Number(first || 0) + Number(second || 0)) * 100) / 100;
  }

  private _applyShiftState(
    state: TaxRegisterState,
    document: DocumentItem,
  ): void {
    if (document.DocClass === 'ZRep') {
      state.ZRepPresent = true;
      state.ShiftState = 1;
    } else if (document.CheckDocType === 'CloseShift') {
      state.ZRepPresent = true;
      state.ShiftState = 0;
    } else {
      state.ZRepPresent = false;
      state.ShiftState = 1;
    }
  }

  // The offline credentials in force come from the newest journal entry that put them in force
  // (an online shift-opening receipt or an end-session response); without one, from the server
  // state the context was initialized with. Until an offline document follows that entry, the
  // next offline session starts at 1.
  private _applyOfflineCredentials(
    state: TaxRegisterState,
    documents: TaxJournalDocument[],
  ): void {
    for (let index = documents.length - 1; index >= 0; index--) {
      const credentials = documents[index].offlineCredentials;
      if (!credentials) {
        continue;
      }

      state.OfflineSessionId = String(credentials.OfflineSessionId);
      state.OfflineSeed = String(credentials.OfflineSeed);
      const offlineDocumentFollows = documents
        .slice(index + 1)
        .some((document) => this._getOfflineLocalNumber(document.NumFiscal) !== null);
      if (!offlineDocumentFollows) {
        state.OfflineNextLocalNum = '1';
      }
      return;
    }
  }

  private _getLastShiftOpening(
    documents: DocumentItem[],
  ): { item: DocumentItem; head: TaxDocumentHead } | null {
    for (let index = documents.length - 1; index >= 0; index--) {
      if (documents[index].CheckDocType !== 'OpenShift') {
        continue;
      }

      const parsed = parseXml<ParsedTaxDocument>(documents[index].xmlCheck);
      const head = parsed?.CHECK?.CHECKHEAD;
      return head ? { item: documents[index], head } : null;
    }

    return null;
  }

  private _getOfflineSessionId(fiscalNumber: number | string): string | null {
    if (fiscalNumber === null || fiscalNumber === undefined) {
      return null;
    }

    const parts = fiscalNumber.toString().split('.');
    return parts.length === 3 ? parts[0] : null;
  }

  private _assertOfflineSessionState(
    offlineSessionState: OfflineSessionState,
  ): void {
    if (
      offlineSessionState?.OfflineSessionId === null ||
      offlineSessionState?.OfflineSessionId === undefined ||
      offlineSessionState?.OfflineSessionId === '' ||
      offlineSessionState?.OfflineSeed === null ||
      offlineSessionState?.OfflineSeed === undefined ||
      offlineSessionState?.OfflineSeed === ''
    ) {
      throw new Error('Offline session state is invalid.');
    }
  }

  private _getOfflineLocalNumber(fiscalNumber: number | string): number | null {
    if (fiscalNumber === null || fiscalNumber === undefined) {
      return null;
    }

    const parts = fiscalNumber.toString().split('.');
    if (parts.length !== 3) {
      return null;
    }

    const currentNumber = Number(parts[1]);
    return Number.isInteger(currentNumber) ? currentNumber : null;
  }

  private _getOfflineNextLocalNumber(
    fiscalNumber: number | string,
  ): string | null {
    const currentNumber = this._getOfflineLocalNumber(fiscalNumber);
    return currentNumber === null ? null : (currentNumber + 1).toString();
  }

  // The journal is saved in local-number order, so the server has all of it when its next
  // local number is past the last document's. An unreadable number proves nothing.
  private _hasDocumentsMissingOnServer(
    documents: DocumentItem[],
    registerState: TransactionsRegistrarStateResponse,
  ): boolean {
    const lastDocument = documents[documents.length - 1];
    return (
      !!lastDocument &&
      !(Number(lastDocument.NumLocal) < Number(registerState.NextLocalNum))
    );
  }

  private _isOffline(
    state: TransactionsRegistrarStateResponse & { Offline?: boolean },
  ): boolean {
    return (
      !!state?.Offline || isOfflineSequenceActive(state?.OfflineNextLocalNum)
    );
  }

  private _getCurrentNextOrderNumber(
    context: TaxRegisterContext<TConfig>,
    documents: DocumentItem[],
  ): number {
    const stateNextOrderNumber = Number(context.registerState.NextLocalNum);
    const lastDocument = documents[documents.length - 1];
    const documentNextOrderNumber = lastDocument
      ? Number(lastDocument.NumLocal) + 1
      : 0;

    return Math.max(stateNextOrderNumber || 0, documentNextOrderNumber);
  }

  private _toBoolean(value: boolean | string): boolean {
    return value === true || value === 'true';
  }

  private _normalizeTaxRegisterId(taxRegisterId: TaxRegisterContextId): string {
    if (taxRegisterId === null || taxRegisterId === undefined) {
      throw new Error('Tax register id is required.');
    }

    const id = taxRegisterId.toString().trim();
    if (!id) {
      throw new Error('Tax register id is required.');
    }

    return id;
  }

  private _getTimestamp(
    value: Date | string | number,
    valueName: string,
  ): number {
    const timestamp =
      value instanceof Date ? value.getTime() : new Date(value).getTime();
    if (Number.isNaN(timestamp)) {
      throw new Error(`${valueName} is invalid.`);
    }

    return timestamp;
  }
}
