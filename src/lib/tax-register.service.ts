import { sha256 } from 'js-sha256';
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
  TransactionsRegistrarStateResponse,
  isOfflineSequenceActive,
} from './models/tax.model.js';
import { TaxContextStorage } from './storage/tax-context-storage.js';
import { TaxContextEventEmitter } from './utils/event-emitter.js';
import { encodeWin1251 } from './utils/win1251.js';
import { parseXml } from './utils/xml-parser.js';

const TAX_REGISTER_CONTEXT_KEY_PREFIX = 'TAX_REGISTER_CONTEXT__';
const TAX_REGISTER_DOCUMENTS_KEY_PREFIX = 'TAX_REGISTER_DOCUMENTS__';
const TAX_REGISTER_STORE_KEY_PREFIX = 'TAX_REGISTER_STORE__';
const TAX_DOCUMENT_STAGE_KEY_PREFIX = 'TAX_DOCUMENT_STAGE__';
const OFFLINE_PACKAGE_CHUNK_SIZE = 50;

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

export interface TaxOfflineSessionError {
  message: string;
  occurredAt: string;
  operation?: string;
}

export interface TaxRegisterContext {
  storeId: number;
  taxConfig: ITaxConfig;
  registerState: TransactionsRegistrarStateResponse;
  lastShiftTotals: LastShiftTotalsResponse;
  serverState: StoredTaxServerState;
  disabled?: boolean;
  offlineSessionErrors?: TaxOfflineSessionError[];
}

export interface TaxRegisterState
  extends TransactionsRegistrarStateResponse {
  OfflineSession: boolean;
  Offline: boolean;
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

interface TaxDocumentHead {
  UID?: string;
  ORDERNUM: number | string;
  ORDERTAXNUM?: number | string;
  DOCTYPE?: number | string;
  DOCSUBTYPE?: number | string;
  ORDERDATE?: number | string;
  ORDERTIME?: number | string;
  REVOKED?: boolean | string;
  REVOKELASTONLINEDOC?: boolean | string;
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
export class TaxRegisterService {
  // Emits the tax register fiscal number whenever its state changes.
  stateChanged = new TaxContextEventEmitter<string>();
  private _contexts = new Map<string, TaxRegisterContext>();

  constructor(
    private _storage: TaxContextStorage,
    private _settings: TaxRegisterContextSettingsSource = {},
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

  async initContext(
    taxConfig: ITaxConfig,
    registerState: TransactionsRegistrarStateResponse,
    lastShiftTotals: LastShiftTotalsResponse | null,
    serverState: TaxServerState,
    force = false,
  ): Promise<boolean> {
    const id = this._getTaxRegisterId(taxConfig);
    const storeId = this._getStoreId(taxConfig);

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

    const context: TaxRegisterContext = {
      storeId,
      taxConfig,
      registerState,
      lastShiftTotals:
        lastShiftTotals || this._createEmptyLastShiftTotals(registerState),
      serverState: storedServerState,
      disabled: currentContext ? currentContext.disabled : true,
    };

    await this._saveContext(id, context);
    await this._storage.set(this._getStoreStorageKey(storeId), id);
    await this._saveDocuments(id, []);
    this.stateChanged.emit(id);
    return true;
  }

  async saveTaxConfig(taxConfig: ITaxConfig): Promise<void> {
    const id = this._getTaxRegisterId(taxConfig);
    const context = await this._getContext(id);
    if (!context) {
      throw new Error(
        `Tax register context not found. TaxRegister fiscal number ${id}`,
      );
    }

    await this._saveContext(id, { ...context, taxConfig });
  }

  async updateServerState(
    taxRegisterId: TaxRegisterContextId,
    state: TransactionsRegistrarStateResponse,
  ): Promise<void> {
    const id = this._normalizeTaxRegisterId(taxRegisterId);
    const context = await this._getContext(id);
    if (!context) {
      throw new Error(
        `Tax register context not found. TaxRegister fiscal number ${id}`,
      );
    }
    if (!state) {
      throw new Error('Tax register state is required.');
    }

    const nextLocalNum = Number(state.NextLocalNum);
    if (!Number.isInteger(nextLocalNum) || nextLocalNum < 0) {
      throw new Error('Tax register state NextLocalNum is invalid.');
    }

    await this._saveContext(id, {
      ...context,
      registerState: state,
    });

    const documents = await this._getDocuments(id);
    await this._saveDocuments(
      id,
      documents.filter((document) => Number(document.NumLocal) >= nextLocalNum),
    );
  }

  async finishOfflineSession(
    taxRegisterId: TaxRegisterContextId,
    offlineSessionState: OfflineSessionState,
  ): Promise<void> {
    await this.setOfflineCredentials(taxRegisterId, offlineSessionState);
  }

  // Replaces the offline credentials in force: from an online shift-opening receipt or an
  // end-session response. The session ID and seed always change together.
  async setOfflineCredentials(
    taxRegisterId: TaxRegisterContextId,
    offlineSessionState: OfflineSessionState,
  ): Promise<void> {
    const id = this._normalizeTaxRegisterId(taxRegisterId);
    const context = await this._getContext(id);
    if (!context) {
      throw new Error(
        `Tax register context not found. TaxRegister fiscal number ${id}`,
      );
    }
    this._assertOfflineSessionState(offlineSessionState);

    await this._saveContext(id, {
      ...context,
      registerState: {
        ...context.registerState,
        OfflineSessionId: offlineSessionState.OfflineSessionId.toString(),
        OfflineSeed: offlineSessionState.OfflineSeed.toString(),
        OfflineNextLocalNum: '1',
      },
    });
    this.stateChanged.emit(id);
  }

  // Saves the accepted end-session document and the next session's credentials. Called only
  // after a successful end-package response; the journal is written first, so an interrupted
  // call leaves a closed session that the next full sync refreshes from the server.
  async completeOfflineSession(
    taxRegisterId: TaxRegisterContextId,
    endSessionXml: string,
    offlineSessionState: OfflineSessionState,
  ): Promise<void> {
    this._assertOfflineSessionState(offlineSessionState);
    await this.saveDocument(taxRegisterId, endSessionXml);
    await this.setOfflineCredentials(taxRegisterId, offlineSessionState);
  }

  async getTaxConfig(taxRegisterId: TaxRegisterContextId): Promise<ITaxConfig> {
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

  async getTaxRegisterIdByStoreId(
    storeId: number,
  ): Promise<string | null> {
    const normalizedStoreId = this._normalizeStoreId(storeId);
    const taxRegisterId = await this._storage.get<TaxRegisterContextId>(
      this._getStoreStorageKey(normalizedStoreId),
    );
    if (!taxRegisterId) {
      return null;
    }

    return this._normalizeTaxRegisterId(taxRegisterId);
  }

  async getTaxRegisterByStoreId(
    storeId: number,
  ): Promise<ITaxConfig['taxRegister'] | null> {
    const taxRegisterId = await this.getTaxRegisterIdByStoreId(storeId);
    if (!taxRegisterId) {
      return null;
    }

    const context = await this._getContext(taxRegisterId);
    return context?.taxConfig?.taxRegister || null;
  }

  async getTaxContextByStoreId(
    storeId: number,
  ): Promise<TaxRegisterContext | null> {
    const normalizedStoreId = this._normalizeStoreId(storeId);
    const taxRegisterId = await this._storage.get<TaxRegisterContextId>(
      this._getStoreStorageKey(normalizedStoreId),
    );
    if (!taxRegisterId) {
      return null;
    }

    return await this._getContext(taxRegisterId);
  }

  async getTaxContext(
    taxRegisterId: TaxRegisterContextId,
  ): Promise<TaxRegisterContext | null> {
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

  async isDisabled(taxRegisterId: TaxRegisterContextId): Promise<boolean> {
    const context = await this._getContext(taxRegisterId);
    return !!context?.disabled;
  }

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

    await this._saveContext(id, { ...context, disabled });
    this.stateChanged.emit(id);
  }

  async removeContext(taxRegisterId: TaxRegisterContextId): Promise<void> {
    const id = this._normalizeTaxRegisterId(taxRegisterId);
    if (!id) {
      return;
    }

    const context = await this._getContext(id);
    await this._storage.remove(this._getStorageKey(id));
    await this._storage.remove(this._getDocumentsStorageKey(id));
    if (context?.storeId != null) {
      const storeKey = this._getStoreStorageKey(context.storeId);
      const mappedId = await this._storage.get<TaxRegisterContextId>(storeKey);
      if (this._normalizeTaxRegisterId(mappedId) === id) {
        await this._storage.remove(storeKey);
      }
    }

    this._contexts.delete(id);
    this.stateChanged.emit(id);
  }

  async getAllTaxConfigs(): Promise<ITaxConfig[]> {
    const storageKeys =
      (await this._storage.keys().catch(() => [])) || [];
    const fiscalNumbers = storageKeys
      .filter((key) => key?.startsWith(TAX_REGISTER_CONTEXT_KEY_PREFIX))
      .map((key) => key.slice(TAX_REGISTER_CONTEXT_KEY_PREFIX.length))
      .filter((id) => !!id);

    const configs: ITaxConfig[] = [];
    const seen = new Set<string>();
    for (const fiscalNumber of fiscalNumbers) {
      if (seen.has(fiscalNumber)) {
        continue;
      }
      seen.add(fiscalNumber);
      const context = await this._getContext(fiscalNumber);
      if (context?.taxConfig && !context.disabled) {
        configs.push(context.taxConfig);
      }
    }

    return configs;
  }

  async getOfflineSessionErrors(
    taxRegisterId: TaxRegisterContextId,
  ): Promise<TaxOfflineSessionError[]> {
    const context = await this._getContext(taxRegisterId);
    return [...(context?.offlineSessionErrors || [])];
  }

  async saveOfflineSessionError(
    taxRegisterId: TaxRegisterContextId,
    error: unknown,
    operation?: string,
  ): Promise<void> {
    const id = this._normalizeTaxRegisterId(taxRegisterId);
    const context = await this._getContext(id);
    if (!context) {
      return;
    }

    const nextError: TaxOfflineSessionError = {
      message: this._stringifyError(error),
      occurredAt: new Date().toISOString(),
      operation,
    };
    await this._saveContext(id, {
      ...context,
      offlineSessionErrors: [
        ...(context.offlineSessionErrors || []),
        nextError,
      ].slice(-20),
    });
    this.stateChanged.emit(id);
  }

  async saveDocument(
    taxRegisterId: TaxRegisterContextId,
    rawXml: string,
  ): Promise<void> {
    const id = this._normalizeTaxRegisterId(taxRegisterId);
    const document = this._parseDocument(rawXml);
    const parsedDocument = parseXml<ParsedTaxDocument>(rawXml);
    const head =
      parsedDocument?.CHECK?.CHECKHEAD || parsedDocument?.ZREP?.ZREPHEAD;
    const context = await this._getContext(id);
    if (!context) {
      throw new Error(
        `Tax register context not found. TaxRegister fiscal number ${id}`,
      );
    }

    const documents = await this._getDocuments(id);
    const expectedLocalNumber = this._getCurrentNextOrderNumber(
      context,
      documents,
    );
    if (document.NumLocal !== expectedLocalNumber) {
      throw new Error(
        `Tax document local number ${document.NumLocal} is invalid. Expected ${expectedLocalNumber}.`,
      );
    }
    if (parsedDocument.CHECK) {
      // await this.validateNextDocument(id, head?.DOCTYPE, head?.DOCSUBTYPE);
    }
    await this._stageDocument(id, rawXml);
    await this._saveDocuments(id, [...documents, document]);
  }

  // Appends consecutive documents in one journal write, so that a partially saved group
  // (for example OfflineBegin without its recreated document) is never stored.
  async saveDocuments(
    taxRegisterId: TaxRegisterContextId,
    rawXmls: string[],
  ): Promise<void> {
    const id = this._normalizeTaxRegisterId(taxRegisterId);
    const context = await this._getContext(id);
    if (!context) {
      throw new Error(
        `Tax register context not found. TaxRegister fiscal number ${id}`,
      );
    }

    const newDocuments = (rawXmls || []).map((rawXml) =>
      this._parseDocument(rawXml),
    );
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

    for (const rawXml of rawXmls) {
      await this._stageDocument(id, rawXml);
    }
    await this._saveDocuments(id, [...documents, ...newDocuments]);
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

  // Document times use the server-time estimate when that correction is enabled.
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
  ): Promise<DocumentItem[]> {
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

    return sha256(encodeWin1251(lastDocument.xmlCheck));
  }

  async hasOfflineDocs(taxRegisterId: TaxRegisterContextId): Promise<boolean> {
    const documents = await this.getDocuments(taxRegisterId);
    return documents.some(
      (document) =>
        this._getOfflineNextLocalNumber(document.NumFiscal) !== null,
    );
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
    await this._saveDocuments(
      id,
      documents.filter(
        (document) => this._getOfflineLocalNumber(document.NumFiscal) === null,
      ),
    );
    await this._saveContext(id, {
      ...context,
      registerState: {
        ...context.registerState,
        OfflineNextLocalNum: '1',
      },
    });
    this.stateChanged.emit(id);
  }

  async getOfflineParts(
    taxRegisterId: TaxRegisterContextId,
    offlineNextLocalNum: number,
  ): Promise<string[][]> {
    const docs = await this.getOfflineDocuments(
      taxRegisterId,
      offlineNextLocalNum,
    );
    return this._chunkOfflineParts(docs);
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

  private _chunkOfflineParts(docs: string[]): string[][] {
    const chunkSize = this.offlineSettings.offlinePackageDocumentLimit;
    const parts: string[][] = [];
    for (let index = 0; index < docs.length; index += chunkSize) {
      parts.push(docs.slice(index, index + chunkSize));
    }

    return parts;
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
    documents[offlineBeginIndex] = this._parseDocument(updatedXml);
    await this._saveDocuments(id, documents);
    return true;
  }

  private async _getContext(
    taxRegisterId: TaxRegisterContextId,
  ): Promise<TaxRegisterContext | null> {
    const id = this._normalizeTaxRegisterId(taxRegisterId);
    const cachedContext = this._contexts.get(id);
    if (cachedContext) {
      return cachedContext;
    }

    const context = await this._storage.get<TaxRegisterContext>(
      this._getStorageKey(id),
    );
    if (context) {
      this._contexts.set(id, context);
    }

    return context || null;
  }

  private async _saveContext(
    taxRegisterId: TaxRegisterContextId,
    context: TaxRegisterContext,
  ): Promise<void> {
    const id = this._normalizeTaxRegisterId(taxRegisterId);
    await this._storage.set(this._getStorageKey(id), context);
    this._contexts.set(id, context);
  }

  private _getTaxRegisterId(taxConfig: ITaxConfig): string {
    return this._normalizeTaxRegisterId(taxConfig?.taxRegister?.fiscalNumber);
  }

  private _getStoreId(taxConfig: ITaxConfig): number {
    return this._normalizeStoreId(taxConfig?.store?.erpStoreId);
  }

  private _getStorageKey(taxRegisterId: TaxRegisterContextId): string {
    const id = this._normalizeTaxRegisterId(taxRegisterId);
    return `${TAX_REGISTER_CONTEXT_KEY_PREFIX}${id}`;
  }

  private _getStoreStorageKey(storeId: number): string {
    return `${TAX_REGISTER_STORE_KEY_PREFIX}${this._normalizeStoreId(storeId)}`;
  }

  private async _getDocuments(
    taxRegisterId: TaxRegisterContextId,
  ): Promise<DocumentItem[]> {
    const id = this._normalizeTaxRegisterId(taxRegisterId);
    return (
      (await this._storage.get<DocumentItem[]>(
        this._getDocumentsStorageKey(id),
      )) || []
    );
  }

  private async _saveDocuments(
    taxRegisterId: TaxRegisterContextId,
    documents: DocumentItem[],
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

    const parsedDocument = parseXml<ParsedTaxDocument>(rawXml);
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
    document.NumFiscal = head.ORDERTAXNUM?.toString();
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

    const date = head.ORDERDATE.toString();
    const time = head.ORDERTIME.toString().padStart(6, '0');
    const year = date.slice(-4);
    const month = date.slice(-6, -4);
    const day = date.slice(0, -6).padStart(2, '0');
    const hours = time.slice(0, -4);
    const minutes = time.slice(-4, -2);
    const seconds = time.slice(-2);
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
      const parsed = parseXml<ParsedTaxDocument>(item.xmlCheck);
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

    for (const document of documentsInShift) {
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

  private _isOffline(
    state: TransactionsRegistrarStateResponse & { Offline?: boolean },
  ): boolean {
    return (
      !!state?.Offline || isOfflineSequenceActive(state?.OfflineNextLocalNum)
    );
  }

  private _stringifyError(error: unknown): string {
    if (error == null) {
      return String(error);
    }
    if (typeof error === 'string') {
      return error;
    }
    if (error instanceof Error) {
      return error.message || error.name;
    }
    if (typeof error === 'object') {
      const details = error as {
        message?: string;
        error?: string;
        ResultText?: string;
        text?: string;
      };
      return (
        details.message ||
        details.error ||
        details.ResultText ||
        details.text ||
        JSON.stringify(error)
      );
    }

    return String(error);
  }

  private _getCurrentNextOrderNumber(
    context: TaxRegisterContext,
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

  private _normalizeStoreId(storeId: number): number {
    const id = Number(storeId);
    if (!Number.isInteger(id) || id < 0) {
      throw new Error('Store id is required.');
    }

    return id;
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
