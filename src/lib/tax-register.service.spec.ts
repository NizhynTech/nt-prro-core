import {
  DocumentItem,
  ITaxConfig,
  LastShiftTotalsResponse,
  TaxObject,
  TransactionsRegistrarStateResponse,
} from './models/tax.model.js';
import { TaxDocumentUtility } from './documents/tax-document.utility.js';
import { TaxOfflineSettings } from './models/tax-offline-settings.js';
import {
  InMemoryTaxContextStorage,
  TaxContextStorage,
} from './storage/tax-context-storage.js';
import {
  TaxRegisterContext,
  TaxRegisterService,
} from './tax-register.service.js';
import {
  getOfflineControlNumber,
  getOfflineControlString,
} from './documents/offline-fiscal-number.js';
import { renumberOfflineDocument } from './documents/offline-renumber.js';
import { parseXml } from './utils/xml-parser.js';

describe('TaxRegisterService', () => {
  let service: TaxRegisterService;
  let storedValues: Map<string, unknown>;
  let storage: jasmine.SpyObj<TaxContextStorage>;

  const createConfig = (fiscalNumber: string): ITaxConfig =>
    ({
      tin: '1234567890',
      taxRegister: { fiscalNumber },
    }) as ITaxConfig;

  const registerState = {
    UID: 'register-state',
    NextLocalNum: 10,
  } as TransactionsRegistrarStateResponse;

  const lastShiftTotals = {
    UID: 'last-shift-totals',
    ShiftState: 0,
  } as LastShiftTotalsResponse;
  const openedShiftTotals = {
    ...lastShiftTotals,
    ShiftState: 1,
    ZRepPresent: false,
  } as LastShiftTotalsResponse;

  const serverState = {
    UID: 'server-state',
    Timestamp: '2026-09-20T12:00:00Z',
  };

  beforeEach(() => {
    storedValues = new Map<string, unknown>();
    storage = jasmine.createSpyObj<TaxContextStorage>('TaxContextStorage', [
      'get',
      'set',
      'keys',
      'remove',
    ]);
    storage.get.and.callFake(
      async <T>(key: string) => storedValues.get(key) as T,
    );
    storage.set.and.callFake(async (key: string, value: unknown) => {
      storedValues.set(key, value);
      return value;
    });
    storage.keys.and.callFake(async () => Array.from(storedValues.keys()));
    storage.remove.and.callFake(async (key: string) => {
      storedValues.delete(key);
    });

    service = new TaxRegisterService(storage);
  });

  // Saves documents one by one, as a client does.
  const saveAll = async (target: TaxRegisterService, xmls: string[]) => {
    for (const xml of xmls) {
      await target.saveDocument('register-1', xml);
    }
  };

  it('initializes a persisted context from the supplied values', async () => {
    const taxConfig = createConfig('register-1');
    const currentTime = new Date('2026-09-20T12:00:01Z');
    spyOn(Date, 'now').and.returnValue(currentTime.getTime());

    await service.initContext(
      taxConfig,
      registerState,
      lastShiftTotals,
      serverState,
    );

    expect(
      storedValues.get('TAX_REGISTER_CONTEXT__register-1'),
    ).toEqual({
      taxConfig,
      registerState,
      lastShiftTotals,
      serverState: {
        response: serverState,
        currentTime: currentTime.toISOString(),
      },
      disabled: true,
    } as TaxRegisterContext);
    expect(storedValues.get('TAX_REGISTER_DOCUMENTS__register-1')).toEqual([]);
    expect(await service.isDisabled('register-1')).toBeTrue();
  });

  it('initializes a first-time register with missing offline fields and null totals', async () => {
    const taxConfig = createConfig('register-1');
    const firstTimeState = {
      UID: null,
      Timestamp: '2026-09-28T13:55:08.9973061+00:00',
      ShiftState: 0,
      NextLocalNum: 1,
      OfflineSupported: true,
      ChiefCashier: true,
    } as TransactionsRegistrarStateResponse;

    const initialized = await service.initContext(
      taxConfig,
      firstTimeState,
      null,
      serverState,
    );

    expect(initialized).toBeTrue();
    expect(await service.getState('register-1')).toEqual(
      jasmine.objectContaining({
        ...firstTimeState,
        ShiftState: 0,
        OfflineSession: false,
        Offline: false,
      }),
    );
    expect(await service.getLastTotals('register-1')).toEqual(
      jasmine.objectContaining({
        UID: null,
        ShiftState: 0,
        ZRepPresent: false,
        Testing: false,
      }),
    );
    expect((await service.getLastTotals('register-1')).Totals).toBeTruthy();
    await expectAsync(
      service.validateNextDocument('register-1', 100),
    ).toBeResolved();
    await expectAsync(
      service.validateNextDocument('register-1', 0),
    ).toBeRejectedWithError(
      'Код помилки: 5 ShiftNotOpened\r\nЗміну для ПРРО наразі не відкрито',
    );
  });

  it('returns tax configs for all persisted contexts', async () => {
    await service.initContext(
      createConfig('register-1'),
      registerState,
      lastShiftTotals,
      serverState,
    );
    await service.initContext(
      createConfig('register-2'),
      registerState,
      lastShiftTotals,
      serverState,
    );
    await service.setDisabled('register-1', false);
    await service.setDisabled('register-2', false);

    const configs = await service.getAllTaxConfigs();

    expect(configs.map((config) => config.taxRegister.fiscalNumber).sort()).toEqual([
      'register-1',
      'register-2',
    ]);
  });

  it('calculates current server time from initialized context state', async () => {
    const responseReceivedAt = new Date('2026-09-20T12:00:01Z');
    const dateNowSpy = spyOn(Date, 'now').and.returnValue(
      responseReceivedAt.getTime(),
    );
    await service.initContext(
      createConfig('register-1'),
      registerState,
      lastShiftTotals,
      {
        ...serverState,
        Timestamp: '2026-09-20T12:00:00Z',
      },
    );
    dateNowSpy.and.returnValue(
      new Date('2026-09-20T12:00:11Z').getTime(),
    );

    expect(
      (await service.getServerTime('register-1')).toISOString(),
    ).toBe('2026-09-20T12:00:10.000Z');
  });

  it('keeps contexts separate by fiscal number', async () => {
    await service.initContext(
      createConfig('register-1'),
      registerState,
      lastShiftTotals,
      serverState,
    );
    await service.initContext(
      createConfig('register-2'),
      { ...registerState, UID: 'second-register-state' },
      lastShiftTotals,
      serverState,
    );

    expect(storedValues.has('TAX_REGISTER_CONTEXT__register-1')).toBeTrue();
    expect(storedValues.has('TAX_REGISTER_CONTEXT__register-2')).toBeTrue();
  });

  it('keeps the application config unchanged and stores nothing besides it', async () => {
    interface AppConfig extends ITaxConfig {
      store: { erpStoreId: number };
    }
    const appService = new TaxRegisterService<AppConfig>(storage);
    const config = {
      ...createConfig('register-1'),
      store: { erpStoreId: 15 },
    } as AppConfig;

    await appService.initContext(
      config,
      registerState,
      lastShiftTotals,
      serverState,
    );

    const restored = await new TaxRegisterService<AppConfig>(
      storage,
    ).getTaxConfig('register-1');
    expect(restored.store.erpStoreId).toBe(15);
    expect(Array.from(storedValues.keys()).sort()).toEqual([
      'TAX_REGISTER_CONTEXT__register-1',
      'TAX_REGISTER_DOCUMENTS__register-1',
    ]);
  });

  it('does not overwrite newer offline state with an older incoming state', async () => {
    const currentState = {
      ...registerState,
      UID: 'current-offline-state',
      NextLocalNum: 20,
      OfflineNextLocalNum: '2',
    };
    await service.initContext(
      createConfig('register-1'),
      currentState,
      openedShiftTotals,
      serverState,
    );
    await service.saveDocument(
      'register-1',
      '<CHECK><CHECKHEAD><DOCTYPE>0</DOCTYPE><ORDERNUM>20</ORDERNUM>' +
        '<ORDERTAXNUM>77.2.100</ORDERTAXNUM><OFFLINE>true</OFFLINE>' +
        '</CHECKHEAD></CHECK>',
    );
    const olderIncomingState = {
      ...registerState,
      UID: 'older-server-state',
      NextLocalNum: 19,
      OfflineNextLocalNum: '1',
    };

    const initialized = await service.initContext(
      createConfig('register-1'),
      olderIncomingState,
      openedShiftTotals,
      serverState,
    );

    expect(initialized).toBeFalse();
    expect(await service.getDocuments('register-1')).toHaveSize(1);
    expect(await service.getState('register-1')).toEqual(
      jasmine.objectContaining({
        ...currentState,
        NextLocalNum: 21,
        OfflineNextLocalNum: '3',
        OfflineSession: true,
        Offline: true,
      }),
    );

    // force skips only the snapshot check: document 20 is still missing on the server.
    expect(
      await service.initContext(
        createConfig('register-1'),
        olderIncomingState,
        openedShiftTotals,
        serverState,
        true,
      ),
    ).toBeFalse();
    expect(await service.getDocuments('register-1')).toHaveSize(1);

    const forceInitialized = await service.initContext(
      createConfig('register-1'),
      { ...olderIncomingState, NextLocalNum: 21 },
      openedShiftTotals,
      serverState,
      true,
    );

    expect(forceInitialized).toBeTrue();
    expect(await service.getDocuments('register-1')).toEqual([]);
  });

  it('keeps journal documents the server does not have, even when forced', async () => {
    await service.initContext(
      createConfig('register-1'),
      registerState,
      openedShiftTotals,
      serverState,
    );
    // An offline session started after the last synchronization: the snapshot is online.
    await service.saveDocument(
      'register-1',
      '<CHECK><CHECKHEAD><DOCTYPE>0</DOCTYPE><ORDERNUM>10</ORDERNUM>' +
        '<ORDERTAXNUM>77.1.100</ORDERTAXNUM><OFFLINE>true</OFFLINE>' +
        '</CHECKHEAD></CHECK>',
    );
    const init = (state: TransactionsRegistrarStateResponse, force = false) =>
      service.initContext(
        createConfig('register-1'),
        state,
        openedShiftTotals,
        serverState,
        force,
      );

    expect(await init(registerState)).toBeFalse();
    expect(await init(registerState, true)).toBeFalse();
    expect(
      await init({ ...registerState, NextLocalNum: undefined }, true),
    ).toBeFalse();
    expect(await service.getDocuments('register-1')).toHaveSize(1);
    expect((await service.getState('register-1')).OfflineSession).toBeTrue();

    expect(await init({ ...registerState, NextLocalNum: 11 })).toBeTrue();
    expect(await service.getDocuments('register-1')).toEqual([]);
  });

  it('counts a revoked document like any other journal document', async () => {
    await service.initContext(
      createConfig('register-1'),
      registerState,
      openedShiftTotals,
      serverState,
    );
    await service.saveDocument(
      'register-1',
      '<CHECK><CHECKHEAD><DOCTYPE>0</DOCTYPE><ORDERNUM>10</ORDERNUM><VER>1</VER>' +
        '<REVOKED>true</REVOKED></CHECKHEAD></CHECK>',
    );
    const init = (nextLocalNum: number) =>
      service.initContext(
        createConfig('register-1'),
        { ...registerState, NextLocalNum: nextLocalNum },
        openedShiftTotals,
        serverState,
      );

    expect(await init(10)).toBeFalse();
    expect(await service.getDocuments('register-1')).toHaveSize(1);

    expect(await init(11)).toBeTrue();
    expect(await service.getDocuments('register-1')).toEqual([]);
  });

  it('returns the stored register state and last totals', async () => {
    await service.initContext(
      createConfig('register-1'),
      registerState,
      lastShiftTotals,
      serverState,
    );
    const restoredService = new TaxRegisterService(storage);

    expect(await restoredService.getState('register-1')).toEqual(
      jasmine.objectContaining({
        ...registerState,
        ShiftState: 0,
        OfflineSession: false,
        Offline: false,
      }),
    );
    expect(await restoredService.getLastTotals('register-1')).toEqual(
      lastShiftTotals,
    );
    expect(await restoredService.hasContext('register-1')).toBeTrue();
    expect(await restoredService.hasContext('missing-register')).toBeFalse();
  });

  it('disables a context without removing stored settings', async () => {
    const taxConfig = createConfig('register-1');
    await service.initContext(
      taxConfig,
      registerState,
      lastShiftTotals,
      serverState,
    );

    await service.setDisabled('register-1', true);

    expect(await service.hasContext('register-1')).toBeTrue();
    expect(await service.isDisabled('register-1')).toBeTrue();
    expect(await service.getTaxConfig('register-1')).toEqual(taxConfig);
    expect(await service.getAllTaxConfigs()).toEqual([]);

    await service.setDisabled('register-1', false);

    expect(await service.isDisabled('register-1')).toBeFalse();
    expect(await service.getAllTaxConfigs()).toEqual([taxConfig]);
  });

  it('finishes an offline session using the package response', async () => {
    await service.initContext(
      createConfig('register-1'),
      {
        ...registerState,
        OfflineSessionId: '100',
        OfflineSeed: '200',
        OfflineNextLocalNum: '1',
      },
      lastShiftTotals,
      serverState,
    );
    await service.saveDocument(
      'register-1',
      '<CHECK><CHECKHEAD><DOCTYPE>102</DOCTYPE><ORDERNUM>10</ORDERNUM>' +
        '<ORDERTAXNUM>100.1.1</ORDERTAXNUM><OFFLINE>true</OFFLINE>' +
        '</CHECKHEAD></CHECK>',
    );
    const totalsBeforeFinish = await service.getLastTotals('register-1');
    const contextBefore = storedValues.get('TAX_REGISTER_CONTEXT__register-1');

    await service.completeOfflineSession(
      'register-1',
      '<CHECK><CHECKHEAD><DOCTYPE>103</DOCTYPE><ORDERNUM>11</ORDERNUM>' +
        '<ORDERTAXNUM>100.2.2</ORDERTAXNUM><OFFLINE>true</OFFLINE>' +
        '</CHECKHEAD></CHECK>',
      { OfflineSessionId: 60259556, OfflineSeed: 668820867191246 },
    );

    // One journal write: the context itself is not written.
    const context = storedValues.get(
      'TAX_REGISTER_CONTEXT__register-1',
    ) as TaxRegisterContext;
    expect(context).toBe(contextBefore as TaxRegisterContext);
    expect(context.registerState.OfflineSessionId).toBe('100');
    expect(context.lastShiftTotals).toEqual(lastShiftTotals);
    const documents = await service.getDocuments('register-1');
    expect(documents[1].offlineCredentials).toEqual({
      OfflineSessionId: '60259556',
      OfflineSeed: '668820867191246',
    });
    const finished = await service.getState('register-1');
    expect(finished.OfflineSessionId).toBe('60259556');
    expect(finished.OfflineSeed).toBe('668820867191246');
    expect(finished.NextLocalNum).toBe(12);
    expect(await service.getLastTotals('register-1')).toEqual(
      totalsBeforeFinish,
    );
    expect(await service.getDocuments('register-1')).toHaveSize(2);
    expect((await service.getState('register-1')).Offline).toBeFalse();
    expect((await service.getState('register-1')).OfflineSession).toBeFalse();
    expect((await service.getState('register-1')).OfflineNextLocalNum).toBe(
      '1',
    );
    await expectAsync(
      service.validateNextDocument('register-1', 102),
    ).toBeResolved();
  });

  it('clears offline documents and resets OfflineNextLocalNum', async () => {
    await service.initContext(
      createConfig('register-1'),
      { ...registerState, NextLocalNum: 9, OfflineNextLocalNum: '1' },
      lastShiftTotals,
      serverState,
    );
    const onlineXml =
      '<CHECK><CHECKHEAD><DOCTYPE>0</DOCTYPE><ORDERNUM>9</ORDERNUM>' +
      '<ORDERTAXNUM>1009</ORDERTAXNUM></CHECKHEAD></CHECK>';
    await service.saveDocument(
      'register-1',
      onlineXml,
    );
    await service.saveDocument(
      'register-1',
      '<CHECK><CHECKHEAD><DOCTYPE>102</DOCTYPE><ORDERNUM>10</ORDERNUM>' +
        '<ORDERTAXNUM>100.1.1</ORDERTAXNUM><OFFLINE>true</OFFLINE>' +
        '</CHECKHEAD></CHECK>',
    );
    await service.saveDocument(
      'register-1',
      '<CHECK><CHECKHEAD><DOCTYPE>0</DOCTYPE><ORDERNUM>11</ORDERNUM>' +
        '<ORDERTAXNUM>100.2.2</ORDERTAXNUM><OFFLINE>true</OFFLINE>' +
        '</CHECKHEAD></CHECK>',
    );

    await service.clearOfflineDocuments('register-1');

    expect(await service.getDocuments('register-1')).toEqual([
      jasmine.objectContaining({ xmlCheck: onlineXml }),
    ]);
    expect((await service.getState('register-1')).OfflineNextLocalNum).toBe(
      '1',
    );
    expect((await service.getState('register-1')).Offline).toBeFalse();
  });

  it('updates the stored config without replacing context values', async () => {
    const initialConfig = createConfig('register-1');
    await service.initContext(
      initialConfig,
      registerState,
      lastShiftTotals,
      serverState,
    );
    const updatedConfig = {
      ...initialConfig,
      orgFullName: 'Updated organization',
    };

    await service.saveTaxConfig(updatedConfig);

    const context = storedValues.get(
      'TAX_REGISTER_CONTEXT__register-1',
    ) as TaxRegisterContext;
    expect(context.taxConfig).toEqual(updatedConfig);
    expect(context.registerState).toEqual(registerState);
    expect(context.lastShiftTotals).toEqual(lastShiftTotals);
  });

  it('calculates the last document hash from context XML', async () => {
    await service.initContext(
      createConfig('register-1'),
      registerState,
      openedShiftTotals,
      serverState,
    );
    const xml =
      '<CHECK><CHECKHEAD><DOCTYPE>0</DOCTYPE><ORDERNUM>10</ORDERNUM>' +
      '</CHECKHEAD></CHECK>';
    await service.saveDocument('register-1', xml);

    expect(await service.getLastDocHash('register-1')).toBe(
      'e0548bc6eab31fc3083c14e9f58f1952521de09b5237131be18cba6d80074bb2',
    );
  });

  it('stores parsed document wrappers sequentially', async () => {
    await service.initContext(
      createConfig('register-1'),
      registerState,
      openedShiftTotals,
      serverState,
    );
    const firstXml =
      '<CHECK><CHECKHEAD><DOCTYPE>0</DOCTYPE><DOCSUBTYPE>0</DOCSUBTYPE>' +
      '<ORDERNUM>10</ORDERNUM><ORDERDATE>20092026</ORDERDATE>' +
      '<ORDERTIME>215959</ORDERTIME>' +
      '<ORDERTAXNUM>1001</ORDERTAXNUM><OFFLINE>false</OFFLINE>' +
      '<TESTING>true</TESTING></CHECKHEAD></CHECK>';
    const secondXml =
      '<ZREP><ZREPHEAD><DOCTYPE>101</DOCTYPE><ORDERNUM>11</ORDERNUM>' +
      '<ORDERDATE>20092026</ORDERDATE><ORDERTIME>220001</ORDERTIME>' +
      '<ORDERTAXNUM>1002</ORDERTAXNUM><OFFLINE>true</OFFLINE>' +
      '</ZREPHEAD></ZREP>';

    await service.saveDocument('register-1', firstXml);
    await service.saveDocument('register-1', secondXml);

    const documents = await service.getDocuments('register-1');
    expect(documents[0] instanceof DocumentItem).toBeTrue();
    expect(documents[1] instanceof DocumentItem).toBeTrue();
    expect(documents.map((document) => ({ ...document }))).toEqual([
      {
        NumFiscal: '1001',
        NumLocal: 10,
        DocDateTime: '2026-09-20T21:59:59',
        DocClass: 'Check',
        CheckDocType: 'SaleGoods',
        CheckDocSubType: 'CheckGoods',
        Revoked: false,
        Storned: false,
        xmlCheck: firstXml,
      },
      {
        NumFiscal: '1002',
        NumLocal: 11,
        DocDateTime: '2026-09-20T22:00:01',
        DocClass: 'ZRep',
        CheckDocType: 'CloseShift',
        CheckDocSubType: 'CheckGoods',
        Revoked: false,
        Storned: false,
        xmlCheck: secondXml,
      },
    ]);
  });

  it('stages saved XML documents and acknowledges them', async () => {
    await service.initContext(
      createConfig('register-1'),
      registerState,
      openedShiftTotals,
      serverState,
    );
    const firstXml =
      '<CHECK><CHECKHEAD><UID>document-1</UID><DOCTYPE>0</DOCTYPE>' +
      '<DOCSUBTYPE>0</DOCSUBTYPE><ORDERNUM>10</ORDERNUM>' +
      '<ORDERDATE>20092026</ORDERDATE><ORDERTIME>215959</ORDERTIME>' +
      '<ORDERTAXNUM>1001</ORDERTAXNUM><OFFLINE>true</OFFLINE>' +
      '<TESTING>false</TESTING></CHECKHEAD></CHECK>';

    await service.saveDocument('register-1', firstXml);

    const stagedDocuments = await service.getStagedDocumentBatch();
    expect(stagedDocuments).toEqual([firstXml]);

    await service.acknowledgeStagedDocuments(stagedDocuments);
    expect(await service.getStagedDocumentBatch()).toEqual([]);
  });

  it('limits staged document batches', async () => {
    await service.initContext(
      createConfig('register-1'),
      registerState,
      openedShiftTotals,
      serverState,
    );
    await service.saveDocument(
      'register-1',
      '<CHECK><CHECKHEAD><UID>document-1</UID><DOCTYPE>0</DOCTYPE>' +
        '<ORDERNUM>10</ORDERNUM></CHECKHEAD></CHECK>',
    );
    await service.saveDocument(
      'register-1',
      '<CHECK><CHECKHEAD><UID>document-2</UID><DOCTYPE>0</DOCTYPE>' +
        '<ORDERNUM>11</ORDERNUM></CHECKHEAD></CHECK>',
    );

    expect((await service.getStagedDocumentBatch(1)).length).toBe(1);
  });

  it('calculates state from the initial state and latest documents', async () => {
    await service.initContext(
      createConfig('register-1'),
      {
        ...registerState,
        ShiftState: 0,
        ZRepPresent: true,
        Testing: false,
        OfflineNextLocalNum: '1',
      },
      {
        ...lastShiftTotals,
        ShiftState: 0,
        ZRepPresent: true,
        Testing: false,
      },
      serverState,
    );
    await service.saveDocument(
      'register-1',
      '<CHECK><CHECKHEAD><DOCTYPE>100</DOCTYPE><ORDERNUM>10</ORDERNUM>' +
        '<ORDERTAXNUM>77.1.100</ORDERTAXNUM><OFFLINE>true</OFFLINE>' +
        '<TESTING>true</TESTING></CHECKHEAD></CHECK>',
    );
    await service.saveDocument(
      'register-1',
      '<CHECK><CHECKHEAD><DOCTYPE>0</DOCTYPE><ORDERNUM>11</ORDERNUM>' +
        '<ORDERTAXNUM>77.2.101</ORDERTAXNUM><OFFLINE>true</OFFLINE>' +
        '<TESTING>true</TESTING></CHECKHEAD></CHECK>',
    );
    await service.saveDocument(
      'register-1',
      '<CHECK><CHECKHEAD><DOCTYPE>103</DOCTYPE><ORDERNUM>12</ORDERNUM>' +
        '<ORDERTAXNUM>77.3.102</ORDERTAXNUM><OFFLINE>true</OFFLINE>' +
        '<TESTING>true</TESTING></CHECKHEAD></CHECK>',
    );

    const state = await service.getState('register-1');

    expect(state.NextLocalNum).toBe(13);
    // A saved OfflineEnd was accepted by the server: the next session starts at 1.
    expect(state.OfflineNextLocalNum).toBe('1');
    expect(state.OfflineSession).toBeFalse();
    expect(state.Offline).toBeFalse();
    expect(state.ShiftState).toBe(1);
    expect(state.ZRepPresent).toBeFalse();
    expect(state.Testing).toBeTrue();
    await expectAsync(
      service.validateNextDocument('register-1', 102),
    ).toBeResolved();
  });

  describe('offline settings', () => {
    const withSettings = (settings: Partial<TaxOfflineSettings>) =>
      new TaxRegisterService(storage, () => ({
        ...settings,
        useServerTimeCorrection: false,
      }));
    const pad = (value: number) => value.toString().padStart(2, '0');
    const orderDateTime = (date: Date) =>
      `<ORDERDATE>${pad(date.getDate())}${pad(date.getMonth() + 1)}${date.getFullYear()}</ORDERDATE>` +
      `<ORDERTIME>${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}</ORDERTIME>`;
    const offlineXml = (
      docType: number,
      numLocal: number,
      offlineNum: number,
      date = new Date(),
    ) =>
      `<CHECK><CHECKHEAD><DOCTYPE>${docType}</DOCTYPE>${orderDateTime(date)}` +
      `<ORDERNUM>${numLocal}</ORDERNUM><ORDERTAXNUM>77.${offlineNum}.100</ORDERTAXNUM>` +
      '<OFFLINE>true</OFFLINE></CHECKHEAD></CHECK>';
    const initOpenShift = (target: TaxRegisterService) =>
      target.initContext(
        createConfig('register-1'),
        { ...registerState, OfflineSupported: true, OfflineNextLocalNum: '1' },
        openedShiftTotals,
        serverState,
      );

    it('rejects a new offline session when offline work is disabled', async () => {
      const target = withSettings({ offlineEnabled: false });
      await initOpenShift(target);

      await expectAsync(
        target.validateNextDocument('register-1', 102),
      ).toBeRejectedWithError(
        'Роботу ПРРО в режимі офлайн вимкнено в налаштуваннях.',
      );
      await expectAsync(
        withSettings({ offlineEnabled: true }).validateNextDocument('register-1', 102),
      ).toBeResolved();
    });

    it('rejects a new offline document once the session has the maximum number of documents', async () => {
      const target = withSettings({ maxOfflineDocuments: 3 });
      await initOpenShift(target);
      await saveAll(target, [
        offlineXml(102, 10, 1),
        offlineXml(0, 11, 2),
      ]);

      // Two documents: the third is still allowed.
      await expectAsync(target.validateNextDocument('register-1', 0)).toBeResolved();

      await target.saveDocument('register-1', offlineXml(0, 12, 3));
      await expectAsync(
        target.validateNextDocument('register-1', 0),
      ).toBeRejectedWithError(/максимальну кількість документів офлайн сесії \(3\)/);
      // The end-session document is always allowed.
      await expectAsync(target.validateNextDocument('register-1', 103)).toBeResolved();
    });

    it('rejects a new offline document after the maximum session duration', async () => {
      const target = withSettings({ maxOfflineSessionDurationMinutes: 30 * 60 });
      await initOpenShift(target);
      const startedAt = new Date(Date.now() - 31 * 60 * 60 * 1000);
      await saveAll(target, [
        offlineXml(102, 10, 1, startedAt),
        offlineXml(0, 11, 2, startedAt),
      ]);

      await expectAsync(
        target.validateNextDocument('register-1', 0),
      ).toBeRejectedWithError(/максимальну тривалість офлайн сесії \(30 год\)/);
      await expectAsync(target.validateNextDocument('register-1', 103)).toBeResolved();
    });

    it('allows offline documents within the session duration', async () => {
      const target = withSettings({ maxOfflineSessionDurationMinutes: 30 * 60 });
      await initOpenShift(target);
      const startedAt = new Date(Date.now() - 29 * 60 * 60 * 1000);
      await saveAll(target, [
        offlineXml(102, 10, 1, startedAt),
        offlineXml(0, 11, 2, startedAt),
      ]);

      await expectAsync(target.validateNextDocument('register-1', 0)).toBeResolved();
    });

    it('exposes the package size from the settings', () => {
      expect(
        withSettings({ offlinePackageDocumentLimit: 2 }).offlineSettings
          .offlinePackageDocumentLimit,
      ).toBe(2);
    });
  });

  it('takes TESTING from the latest shift opening, not from OfflineBegin', async () => {
    await service.initContext(
      createConfig('register-1'),
      { ...registerState, Testing: false, OfflineNextLocalNum: '1' },
      { ...openedShiftTotals, Testing: false },
      serverState,
    );
    await service.saveDocument(
      'register-1',
      '<CHECK><CHECKHEAD><DOCTYPE>100</DOCTYPE><ORDERNUM>10</ORDERNUM>' +
        '<TESTING>true</TESTING></CHECKHEAD></CHECK>',
    );
    await service.saveDocument(
      'register-1',
      '<CHECK><CHECKHEAD><DOCTYPE>0</DOCTYPE><ORDERNUM>11</ORDERNUM>' +
        '<TESTING>true</TESTING></CHECKHEAD></CHECK>',
    );
    await service.saveDocument(
      'register-1',
      '<CHECK><CHECKHEAD><DOCTYPE>102</DOCTYPE><ORDERNUM>12</ORDERNUM>' +
        '<ORDERTAXNUM>77.1.100</ORDERTAXNUM><OFFLINE>true</OFFLINE>' +
        '</CHECKHEAD></CHECK>',
    );

    const state = await service.getState('register-1');

    expect(state.Testing).toBeTrue();
    expect(state.OfflineSession).toBeTrue();
  });

  describe('creating document headers', () => {
    const id = '4000002411';
    const seed = '179625192271939';
    const taxObject = {
      Tin: '01234567',
      Ipn: '012345678901',
      OrgName: 'ТОВ "Тест"',
      Name: 'Кафе',
      Address: 'Київ',
      TransactionsRegistrars: [
        { NumFiscal: 4000002410, NumLocal: 18, Name: 'Інша каса', Closed: false },
        { NumFiscal: 4000002411, NumLocal: 19, Name: 'Каса', Closed: false },
      ],
    } as unknown as TaxObject;
    const state = {
      ...registerState,
      OfflineSupported: true,
      OfflineSessionId: '77',
      OfflineSeed: seed,
      OfflineNextLocalNum: '1',
      OfflineSessionDuration: '0',
      OfflineSessionsMonthlyDuration: '0',
      TaxObject: taxObject,
    } as TransactionsRegistrarStateResponse;
    // A sale registered online would have been 10; the session starts from it.
    const original =
      '<CHECK><CHECKHEAD><DOCTYPE>0</DOCTYPE><UID>u-1</UID><TIN>00000042</TIN>' +
      '<ORGNM>ТОВ "Перший"</ORGNM><POINTNM>Кафе</POINTNM><POINTADDR>Київ</POINTADDR>' +
      '<ORDERDATE>30092026</ORDERDATE><ORDERTIME>235959</ORDERTIME><ORDERNUM>10</ORDERNUM>' +
      '<CASHDESKNUM>19</CASHDESKNUM><CASHREGISTERNUM>4000002411</CASHREGISTERNUM>' +
      '<CASHIER>Касир</CASHIER><VER>1</VER></CHECKHEAD>' +
      '<CHECKTOTAL><SUM>100.00</SUM></CHECKTOTAL></CHECK>';
    const control = (
      orderNumber: number,
      checkTotal?: string,
      previousDocumentHash?: string,
    ) =>
      getOfflineControlNumber(
        getOfflineControlString({
          seed,
          orderDate: '01102026',
          orderTime: '093005',
          orderNumber,
          cashRegisterNum: id,
          cashDeskNum: 19,
          checkTotal,
          previousDocumentHash,
        }),
      );
    let uids: number;
    const createService = () =>
      new TaxRegisterService(storage, {}, { createUid: () => `uid-${++uids}` });
    const init = (
      target: TaxRegisterService,
      initState = state,
      totals = openedShiftTotals,
    ) => target.initContext(createConfig(id), initState, totals, serverState);
    const headOf = (xml: string) =>
      parseXml<{ CHECK: { CHECKHEAD: Record<string, string> } }>(xml, {
        keepText: true,
      }).CHECK.CHECKHEAD;

    beforeEach(() => {
      uids = 0;
      jasmine.clock().install();
      jasmine.clock().mockDate(new Date(2026, 9, 1, 9, 30, 5));
    });

    afterEach(() => jasmine.clock().uninstall());

    it('fills an online header from the context and the TaxObject', async () => {
      const target = createService();
      await init(target);

      const head = await target.createDocumentHead(id, {
        docType: 0,
        cashier: 'Касир',
      });

      expect(head).toEqual(
        jasmine.objectContaining({
          DOCTYPE: 0,
          UID: 'uid-1',
          TIN: '01234567',
          IPN: '012345678901',
          ORGNM: 'ТОВ "Тест"',
          POINTNM: 'Кафе',
          POINTADDR: 'Київ',
          ORDERDATE: '01102026',
          ORDERTIME: '093005',
          ORDERNUM: 10,
          CASHDESKNUM: 19,
          CASHREGISTERNUM: id,
          CASHIER: 'Касир',
          OFFLINE: false,
          ORDERTAXNUM: null,
          PREVDOCHASH: null,
        }),
      );
    });

    it('takes TESTING of a shift opening from the request', async () => {
      const target = createService();
      await init(target, state, lastShiftTotals);

      const head = await target.createDocumentHead(id, {
        docType: 100,
        cashier: 'Касир',
        testing: true,
      });

      expect(head.TESTING).toBeTrue();
    });

    it('numbers a document of the open offline session', async () => {
      const target = createService();
      await init(target);
      await target.startOfflineSession(id, original);
      const previousHash = await target.getLastDocHash(id);

      const head = await target.createDocumentHead(id, {
        docType: 0,
        cashier: 'Касир',
        checkTotal: '50.00',
      });

      expect(head.ORDERNUM).toBe(13);
      expect(head.OFFLINE).toBeTrue();
      expect(head.PREVDOCHASH).toBe(previousHash);
      expect(head.ORDERTAXNUM).toBe(`77.3.${control(13, '50.00', previousHash)}`);

      await target.saveDocument(id, TaxDocumentUtility.getChekDoc(head));
      const documents = await target.getDocuments(id);
      expect(documents[documents.length - 1].NumFiscal).toBe(head.ORDERTAXNUM);
    });

    it('replaces TaxObject values with the request issuer and requires the schema values', async () => {
      const target = createService();
      await init(target, { ...state, TaxObject: undefined });

      await expectAsync(
        target.createDocumentHead(id, { docType: 0, cashier: 'Касир' }),
      ).toBeRejectedWithError(/TIN, ORGNM, POINTNM, CASHDESKNUM/);

      const head = await target.createDocumentHead(id, {
        docType: 0,
        cashier: 'Касир',
        issuer: {
          tin: '1234567890',
          organizationName: 'ФОП Тест',
          pointName: 'Магазин',
          cashDeskNum: 3,
          cashRegisterNum: '1',
          pointAddress: undefined,
        },
      });
      expect(head.TIN).toBe('1234567890');
      expect(head.ORGNM).toBe('ФОП Тест');
      expect(head.CASHDESKNUM).toBe(3);
      expect(head.CASHREGISTERNUM).toBe(id);
    });

    it('refuses session documents, a malformed total, a missing cashier and invalid documents', async () => {
      const target = createService();
      await init(target);

      await expectAsync(
        target.createDocumentHead(id, { docType: 102, cashier: 'Касир' }),
      ).toBeRejectedWithError(/startOfflineSession/);
      await expectAsync(
        target.createDocumentHead(id, { docType: 103, cashier: 'Касир' }),
      ).toBeRejectedWithError(/createOfflineSessionEnd/);
      await expectAsync(
        target.createDocumentHead(id, { docType: 0, cashier: 'Касир', checkTotal: '50' }),
      ).toBeRejectedWithError(/0\.00/);
      await expectAsync(
        target.createDocumentHead(id, { docType: 0, cashier: '  ' }),
      ).toBeRejectedWithError('Не вказано касира документа.');
      await expectAsync(
        target.createDocumentHead(id, { docType: 100, cashier: 'Касир' }),
      ).toBeRejectedWithError(/ShiftAlreadyOpened/);
    });

    it('generates UIDs with crypto.randomUUID by default', async () => {
      const target = new TaxRegisterService(storage);
      await init(target);

      const head = await target.createDocumentHead(id, { docType: 0, cashier: 'Касир' });

      expect(head.UID).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    });

    it('builds the session end from the session start, without saving it', async () => {
      const target = createService();
      await init(target);
      await expectAsync(
        target.createOfflineSessionEnd(id, 'Касир'),
      ).toBeRejectedWithError(/OfflineSessionNotOpened/);
      await target.startOfflineSession(id, original);
      const previousHash = await target.getLastDocHash(id);

      const end = await target.createOfflineSessionEnd(id, 'Інший касир');

      const head = headOf(end);
      expect(head.DOCTYPE).toBe('103');
      // Issuer of OfflineBegin, which repeats the original as written, not the TaxObject.
      expect(head.TIN).toBe('00000042');
      expect(head.ORGNM).toBe('ТОВ "Перший"');
      expect(head.CASHIER).toBe('Інший касир');
      expect(head.ORDERNUM).toBe('13');
      expect(head.PREVDOCHASH).toBe(previousHash);
      expect(head.ORDERTAXNUM).toBe(`77.3.${control(13, undefined, previousHash)}`);
      expect(head.TESTING).toBeUndefined();
      expect(await target.getDocuments(id)).toHaveSize(3);

      await target.completeOfflineSession(id, end, {
        OfflineSessionId: '78',
        OfflineSeed: '1',
      });
      expect((await target.getState(id)).OfflineSession).toBeFalse();
    });
  });

  describe('unsafe operations', () => {
    const id = '4000002411';
    const seed = '179625192271939';
    const body = '<CHECKTOTAL><SUM>100.00</SUM></CHECKTOTAL>';
    // A sale sent online at 10 that got no answer.
    const original =
      '<CHECK><CHECKHEAD><DOCTYPE>0</DOCTYPE><UID>u-1</UID><TIN>01234567</TIN>' +
      '<ORGNM>ТОВ</ORGNM><POINTNM>Кафе</POINTNM><ORDERDATE>30092026</ORDERDATE>' +
      '<ORDERTIME>235959</ORDERTIME><ORDERNUM>10</ORDERNUM><CASHDESKNUM>19</CASHDESKNUM>' +
      '<CASHREGISTERNUM>4000002411</CASHREGISTERNUM><CASHIER>Касир</CASHIER><VER>1</VER>' +
      `</CHECKHEAD>${body}</CHECK>`;
    const sale = (numLocal: number, uid: string, fiscalNumber: string) =>
      `<CHECK><CHECKHEAD><DOCTYPE>0</DOCTYPE><DOCSUBTYPE>0</DOCSUBTYPE><UID>${uid}</UID>` +
      '<TIN>01234567</TIN><ORGNM>ТОВ</ORGNM><POINTNM>Кафе</POINTNM>' +
      `<ORDERDATE>01102026</ORDERDATE><ORDERTIME>093010</ORDERTIME><ORDERNUM>${numLocal}</ORDERNUM>` +
      '<CASHDESKNUM>19</CASHDESKNUM><CASHREGISTERNUM>4000002411</CASHREGISTERNUM>' +
      `<CASHIER>Касир</CASHIER><VER>1</VER><ORDERTAXNUM>${fiscalNumber}</ORDERTAXNUM>` +
      '<OFFLINE>true</OFFLINE></CHECKHEAD><CHECKTOTAL><SUM>50.00</SUM></CHECKTOTAL></CHECK>';
    // No credentials, an earlier sequence the server has not finished, offline not supported.
    const noCredentials = {
      ...registerState,
      OfflineSupported: false,
      OfflineSessionId: null,
      OfflineSeed: null,
      OfflineNextLocalNum: '3',
    } as TransactionsRegistrarStateResponse;
    const placeholder = { OfflineSessionId: '0', OfflineSeed: '0' };
    const control = (
      orderNumber: number,
      orderTime: string,
      checkTotal?: string,
      previousDocumentHash?: string,
      controlSeed = seed,
    ) =>
      getOfflineControlNumber(
        getOfflineControlString({
          seed: controlSeed,
          orderDate: '01102026',
          orderTime,
          orderNumber,
          cashRegisterNum: id,
          cashDeskNum: 19,
          checkTotal,
          previousDocumentHash,
        }),
      );
    const headOf = (xml: string) =>
      parseXml<{ CHECK: { CHECKHEAD: Record<string, string> } }>(xml, {
        keepText: true,
      }).CHECK.CHECKHEAD;
    const init = (target: TaxRegisterService) =>
      target.initContext(createConfig(id), noCredentials, openedShiftTotals, serverState);

    beforeEach(() => {
      jasmine.clock().install();
      jasmine.clock().mockDate(new Date(2026, 9, 1, 9, 30, 5));
    });

    afterEach(() => jasmine.clock().uninstall());

    it('starts an offline session without the readiness checks, with the given credentials', async () => {
      const target = new TaxRegisterService(storage, { offlineEnabled: false });
      await init(target);
      await expectAsync(target.startOfflineSession(id, original)).toBeRejected();
      await expectAsync(target.unsafeStartOfflineSession(id, original)).toBeRejectedWithError(
        'Каса не підтримує офлайн режим.',
      );

      await target.unsafeStartOfflineSession(id, original, placeholder);

      const [revoked, begin, copy] = await target.getDocuments(id);
      expect(revoked.Revoked).toBeTrue();
      expect(begin.NumFiscal).toBe(`0.1.${control(11, '093005', undefined, undefined, '0')}`);
      expect(begin.offlineCredentials).toEqual(placeholder);
      expect(copy.NumFiscal).toBe(`0.2.${control(12, '093005', '100.00', undefined, '0')}`);
      // The session's next documents use them.
      const state = await target.getState(id);
      expect(state.OfflineSessionId).toBe('0');
      expect(state.OfflineNextLocalNum).toBe('3');
    });

    it('builds a header without the document checks and offline limits', async () => {
      const target = new TaxRegisterService(
        storage,
        { maxOfflineDocuments: 2 },
        { createUid: () => 'uid-new' },
      );
      await init(target);
      await target.unsafeStartOfflineSession(id, original, placeholder);
      const request = {
        docType: 0,
        cashier: 'Касир',
        issuer: { tin: '01234567', organizationName: 'ТОВ', pointName: 'Кафе', cashDeskNum: 19 },
      };

      await expectAsync(target.createDocumentHead(id, request)).toBeRejectedWithError(
        /максимальну кількість документів/,
      );
      const head = await target.unsafeCreateDocumentHead(id, request);

      expect(head.ORDERNUM).toBe(13);
      expect(head.ORDERTAXNUM).toMatch(/^0\.3\.\d+$/);
      expect(head.PREVDOCHASH).toBe(await target.getLastDocHash(id));
    });

    it('replaces and removes journal documents without checks, in one write', async () => {
      const target = new TaxRegisterService(storage);
      await init(target);
      await target.unsafeStartOfflineSession(id, original, placeholder);
      await target.saveDocument(id, sale(13, 'sale-1', '0.3.1'));
      const [revoked, begin, copy, first] = await target.getDocuments(id);
      const renumbered = renumberOfflineDocument(copy.xmlCheck, {
        orderNumber: 11,
        sessionId: '77',
        seed,
        localNum: 2,
      });
      storage.set.calls.reset();

      await target.unsafeReplaceDocuments(id, [
        { xml: begin.xmlCheck, replacement: null },
        {
          xml: copy.xmlCheck,
          replacement: renumbered,
          offlineCredentials: { OfflineSessionId: '77', OfflineSeed: seed },
        },
      ]);

      expect(storage.set).toHaveBeenCalledTimes(1);
      const documents = await target.getDocuments(id);
      expect(documents.map((item) => item.xmlCheck)).toEqual([
        revoked.xmlCheck,
        renumbered,
        first.xmlCheck,
      ]);
      expect(documents[1].NumLocal).toBe(11);
      expect(documents[1].offlineCredentials).toEqual({
        OfflineSessionId: '77',
        OfflineSeed: seed,
      });
      await expectAsync(
        target.unsafeReplaceDocuments(id, [{ xml: begin.xmlCheck, replacement: null }]),
      ).toBeRejectedWithError('Tax document to replace is not in the journal.');

      // Without its own start, the session end takes the issuer of the session's first document.
      const end = await target.createOfflineSessionEnd(id, 'Касир');
      expect(headOf(end).TIN).toBe('01234567');
      expect(headOf(end).ORDERTAXNUM).toMatch(/^77\.4\.\d+$/);
    });

    it('renumbers an offline document', () => {
      const hash = 'ab'.repeat(32);
      const xml = sale(13, 'sale-1', '0.3.1').replace(
        '<OFFLINE>true</OFFLINE>',
        '<OFFLINE>true</OFFLINE><PREVDOCHASH>old</PREVDOCHASH>',
      );

      const renumbered = renumberOfflineDocument(xml, {
        orderNumber: 12,
        sessionId: '77',
        seed,
        localNum: 3,
        previousDocumentHash: hash,
      });

      expect(headOf(renumbered).ORDERNUM).toBe('12');
      expect(headOf(renumbered).PREVDOCHASH).toBe(hash);
      expect(headOf(renumbered).ORDERTAXNUM).toBe(
        `77.3.${control(12, '093010', '50.00', hash)}`,
      );
      expect(renumbered.split('</CHECKHEAD>')[1]).toBe(xml.split('</CHECKHEAD>')[1]);
      expect(() =>
        renumberOfflineDocument(xml, { orderNumber: 12, sessionId: '77', seed, localNum: 3 }),
      ).toThrowError(/PREVDOCHASH/);

      const begin =
        '<CHECK><CHECKHEAD><DOCTYPE>102</DOCTYPE><UID>u-1</UID><ORDERDATE>01102026</ORDERDATE>' +
        '<ORDERTIME>093005</ORDERTIME><ORDERNUM>11</ORDERNUM><CASHDESKNUM>19</CASHDESKNUM>' +
        '<CASHREGISTERNUM>4000002411</CASHREGISTERNUM>' +
        '<REVOKELASTONLINEDOC>true</REVOKELASTONLINEDOC><CASHIER>Касир</CASHIER><VER>1</VER>' +
        '<ORDERTAXNUM>0.1.5</ORDERTAXNUM><OFFLINE>true</OFFLINE></CHECKHEAD></CHECK>';
      const renumberedBegin = renumberOfflineDocument(begin, {
        orderNumber: 10,
        sessionId: '77',
        seed,
        localNum: 1,
      });
      expect(renumberedBegin).toContain('<REVOKELASTONLINEDOC>true</REVOKELASTONLINEDOC>');
      expect(renumberedBegin).toContain(
        `<VER>1</VER><ORDERTAXNUM>77.1.${control(10, '093005')}</ORDERTAXNUM><OFFLINE>true</OFFLINE></CHECKHEAD>`,
      );
    });
  });

  describe('starting an offline session', () => {
    const seed = '179625192271939';
    const offlineState = {
      ...registerState,
      OfflineSupported: true,
      OfflineSessionId: '77',
      OfflineSeed: seed,
      OfflineNextLocalNum: '1',
      OfflineSessionDuration: '0',
      OfflineSessionsMonthlyDuration: '0',
    } as TransactionsRegistrarStateResponse;
    const body =
      '<CHECKTOTAL><SUM>100.00</SUM></CHECKTOTAL>\r\n' +
      '<CHECKBODY><ROW ROWNUM="1"><NAME>Кава</NAME><COST>100.00</COST></ROW></CHECKBODY>\r\n';
    const original = (numLocal = 10) =>
      '<?xml version="1.0" encoding="windows-1251"?>\r\n<CHECK>\r\n<CHECKHEAD>\r\n' +
      '<DOCTYPE>0</DOCTYPE>\r\n<UID>u-1</UID>\r\n<TIN>01234567</TIN>\r\n' +
      '<ORGNM>ТОВ &quot;Тест&quot;</ORGNM>\r\n<POINTNM>Кафе</POINTNM>\r\n' +
      '<POINTADDR>Київ</POINTADDR>\r\n<ORDERDATE>30092026</ORDERDATE>\r\n' +
      `<ORDERTIME>235959</ORDERTIME>\r\n<ORDERNUM>${numLocal}</ORDERNUM>\r\n` +
      '<CASHDESKNUM>19</CASHDESKNUM>\r\n<CASHREGISTERNUM>4000002411</CASHREGISTERNUM>\r\n' +
      '<CASHIER>Касир</CASHIER>\r\n<VER>1</VER>\r\n<TESTING>true</TESTING>\r\n' +
      `</CHECKHEAD>\r\n${body}</CHECK>`;
    const control = (orderNumber: number, checkTotal?: string) =>
      getOfflineControlNumber(
        getOfflineControlString({
          seed,
          orderDate: '01102026',
          orderTime: '093005',
          orderNumber,
          cashRegisterNum: '4000002411',
          cashDeskNum: '19',
          checkTotal,
        }),
      );
    const init = (target = service, state = offlineState) =>
      target.initContext(createConfig('register-1'), state, openedShiftTotals, serverState);

    beforeEach(() => {
      jasmine.clock().install();
      jasmine.clock().mockDate(new Date(2026, 9, 1, 9, 30, 5));
    });

    afterEach(() => jasmine.clock().uninstall());

    it('stores the revoked original, OfflineBegin and the offline copy in one write', async () => {
      await init();

      const copy = await service.startOfflineSession('register-1', original());

      const [revoked, begin, offlineCopy] = await service.getDocuments('register-1');
      expect(revoked.xmlCheck).toBe(
        original().replace('<VER>1</VER>', '<VER>1</VER><REVOKED>true</REVOKED>'),
      );
      expect(revoked.Revoked).toBeTrue();

      expect(begin.CheckDocType).toBe('OfflineBegin');
      expect(begin.NumLocal).toBe(11);
      expect(begin.NumFiscal).toBe(`77.1.${control(11)}`);
      const beginHead = parseXml<{ CHECK: { CHECKHEAD: Record<string, string> } }>(
        begin.xmlCheck,
        { keepText: true },
      ).CHECK.CHECKHEAD;
      expect(beginHead.UID).toBe('u-1');
      expect(beginHead.TIN).toBe('01234567');
      expect(beginHead.ORGNM).toBe('ТОВ "Тест"');
      expect(beginHead.ORDERDATE).toBe('01102026');
      expect(beginHead.ORDERTIME).toBe('093005');
      expect(beginHead.TESTING).toBeUndefined();

      const header = offlineCopy.xmlCheck.slice(0, offlineCopy.xmlCheck.indexOf('</CHECKHEAD>'));
      expect(copy).toBe(offlineCopy.xmlCheck);
      expect(offlineCopy.NumLocal).toBe(12);
      expect(offlineCopy.NumFiscal).toBe(`77.2.${control(12, '100.00')}`);
      expect(header).toContain('<UID>u-1</UID>');
      expect(header).toContain('<ORDERDATE>01102026</ORDERDATE>');
      expect(header).toContain('<ORDERTIME>093005</ORDERTIME>');
      expect(header).toContain(
        `<VER>1</VER><ORDERTAXNUM>77.2.${control(12, '100.00')}</ORDERTAXNUM>` +
          '<OFFLINE>true</OFFLINE>\r\n<TESTING>true</TESTING>',
      );
      expect(offlineCopy.xmlCheck.endsWith(`</CHECKHEAD>\r\n${body}</CHECK>`)).toBeTrue();

      const state = await service.getState('register-1');
      expect(state.NextLocalNum).toBe(13);
      expect(state.OfflineNextLocalNum).toBe('3');
      expect(state.OfflineSession).toBeTrue();
      const totals = await service.getLastTotals('register-1');
      expect(totals.Totals.Real.Sum).toBe(100);
      expect(totals.Totals.Real.OrdersCount).toBe(1);
      expect((await service.getStagedDocumentBatch()).length).toBe(3);
    });

    it('converts a Z-report without a sum in the control number', async () => {
      await init();
      const zReport =
        '<ZREP><ZREPHEAD><UID>z-1</UID><TIN>01234567</TIN><ORGNM>ТОВ</ORGNM>' +
        '<POINTNM>Кафе</POINTNM><POINTADDR>Київ</POINTADDR><ORDERDATE>30092026</ORDERDATE>' +
        '<ORDERTIME>235959</ORDERTIME><ORDERNUM>10</ORDERNUM><CASHDESKNUM>19</CASHDESKNUM>' +
        '<CASHREGISTERNUM>4000002411</CASHREGISTERNUM><CASHIER>Касир</CASHIER><VER>1</VER>' +
        '</ZREPHEAD><ZREPBODY><SERVICEINPUT>0.00</SERVICEINPUT></ZREPBODY></ZREP>';

      const copy = await service.startOfflineSession('register-1', zReport);

      expect(copy).toContain(
        `<VER>1</VER><ORDERTAXNUM>77.2.${control(12)}</ORDERTAXNUM><OFFLINE>true</OFFLINE>`,
      );
      expect(copy).toContain('<ZREPBODY><SERVICEINPUT>0.00</SERVICEINPUT></ZREPBODY>');
      expect((await service.getDocuments('register-1'))[1].CheckDocType).toBe(
        'OfflineBegin',
      );
    });

    it('saves nothing when the register cannot start offline or the original does not fit', async () => {
      const disabled = new TaxRegisterService(storage, { offlineEnabled: false });
      await init(disabled);
      await expectAsync(
        disabled.startOfflineSession('register-1', original()),
      ).toBeRejectedWithError('Роботу ПРРО в режимі офлайн вимкнено в налаштуваннях.');

      await init(service, { ...offlineState, OfflineSeed: null });
      await expectAsync(
        service.startOfflineSession('register-1', original()),
      ).toBeRejectedWithError('Каса не підтримує офлайн режим.');

      await init();
      await expectAsync(
        service.startOfflineSession(
          'register-1',
          original().replace('<VER>1</VER>', '<VER>1</VER><OFFLINE>true</OFFLINE>'),
        ),
      ).toBeRejectedWithError(/Офлайн сесію починає лише документ/);
      await expectAsync(
        service.startOfflineSession('register-1', original(12)),
      ).toBeRejectedWithError('Tax document local number 12 is invalid. Expected 10.');
      expect(await service.getDocuments('register-1')).toEqual([]);
    });
  });

  it('completes an offline session with the end document and the next credentials', async () => {
    await service.initContext(
      createConfig('register-1'),
      { ...registerState, OfflineSessionId: '77', OfflineSeed: '1', OfflineNextLocalNum: '1' },
      openedShiftTotals,
      serverState,
    );
    await service.saveDocument(
      'register-1',
      '<CHECK><CHECKHEAD><DOCTYPE>102</DOCTYPE><ORDERNUM>10</ORDERNUM>' +
        '<ORDERTAXNUM>77.1.100</ORDERTAXNUM><OFFLINE>true</OFFLINE></CHECKHEAD></CHECK>',
    );

    await service.completeOfflineSession(
      'register-1',
      '<CHECK><CHECKHEAD><DOCTYPE>103</DOCTYPE><ORDERNUM>11</ORDERNUM>' +
        '<ORDERTAXNUM>77.2.101</ORDERTAXNUM><OFFLINE>true</OFFLINE></CHECKHEAD></CHECK>',
      { OfflineSessionId: '78', OfflineSeed: '2' },
    );

    const state = await service.getState('register-1');
    expect(state.OfflineSessionId).toBe('78');
    expect(state.OfflineSeed).toBe('2');
    expect(state.OfflineNextLocalNum).toBe('1');
    expect(state.Offline).toBeFalse();
    expect(state.NextLocalNum).toBe(12);
  });

  it('does not save the end document without both credentials', async () => {
    await service.initContext(
      createConfig('register-1'),
      registerState,
      openedShiftTotals,
      serverState,
    );

    await expectAsync(
      service.completeOfflineSession(
        'register-1',
        '<CHECK><CHECKHEAD><DOCTYPE>103</DOCTYPE><ORDERNUM>10</ORDERNUM></CHECKHEAD></CHECK>',
        { OfflineSessionId: '78', OfflineSeed: null },
      ),
    ).toBeRejectedWithError('Offline session state is invalid.');
    expect(await service.getDocuments('register-1')).toEqual([]);
  });

  it('clears documents when context is initialized from online data', async () => {
    await service.initContext(
      createConfig('register-1'),
      registerState,
      openedShiftTotals,
      serverState,
    );
    await service.saveDocument(
      'register-1',
      '<CHECK><CHECKHEAD><DOCTYPE>0</DOCTYPE><ORDERNUM>10</ORDERNUM>' +
        '</CHECKHEAD></CHECK>',
    );

    const initialized = await service.initContext(
      createConfig('register-1'),
      {
        ...registerState,
        NextLocalNum: 11,
        OfflineNextLocalNum: '1',
      },
      lastShiftTotals,
      serverState,
    );

    expect(initialized).toBeTrue();
    expect(await service.getDocuments('register-1')).toEqual([]);
  });

  it('counts additional deposits as service input, skips storno, and groups taxes by rate and sign', async () => {
    await service.initContext(
      createConfig('register-1'),
      registerState,
      openedShiftTotals,
      serverState,
    );
    await saveAll(service, [
      '<CHECK><CHECKHEAD><DOCTYPE>100</DOCTYPE><ORDERNUM>10</ORDERNUM></CHECKHEAD></CHECK>',
      '<CHECK><CHECKHEAD><DOCTYPE>0</DOCTYPE><DOCSUBTYPE>3</DOCSUBTYPE>' +
        '<ORDERNUM>11</ORDERNUM></CHECKHEAD>' +
        '<CHECKTOTAL><SUM>40</SUM></CHECKTOTAL></CHECK>',
      '<CHECK><CHECKHEAD><DOCTYPE>0</DOCTYPE><ORDERNUM>12</ORDERNUM></CHECKHEAD>' +
        '<CHECKTOTAL><SUM>100</SUM></CHECKTOTAL>' +
        '<CHECKTAX><ROW><TYPE>1</TYPE><LETTER>A</LETTER><PRC>20</PRC>' +
        '<TURNOVER>60</TURNOVER><SUM>10</SUM></ROW>' +
        '<ROW><TYPE>1</TYPE><LETTER>A</LETTER><PRC>7</PRC>' +
        '<TURNOVER>40</TURNOVER><SUM>2.62</SUM></ROW></CHECKTAX></CHECK>',
      '<CHECK><CHECKHEAD><DOCTYPE>0</DOCTYPE><DOCSUBTYPE>5</DOCSUBTYPE>' +
        '<ORDERNUM>13</ORDERNUM></CHECKHEAD>' +
        '<CHECKTOTAL><SUM>100</SUM></CHECKTOTAL></CHECK>',
    ]);

    const totals = (await service.getLastTotals('register-1')).Totals;

    expect(totals.ServiceInput).toBe(40);
    expect(totals.Real.Sum).toBe(100);
    expect(totals.Real.OrdersCount).toBe(1);
    expect(totals.Real.Tax.length).toBe(2);
  });

  it('calculates local shift totals from documents after the latest shift start', async () => {
    await service.initContext(
      createConfig('register-1'),
      { ...registerState, NextLocalNum: 9 },
      openedShiftTotals,
      serverState,
    );
    await service.saveDocument(
      'register-1',
      '<CHECK><CHECKHEAD><DOCTYPE>0</DOCTYPE><DOCSUBTYPE>0</DOCSUBTYPE>' +
        '<ORDERNUM>9</ORDERNUM></CHECKHEAD>' +
        '<CHECKTOTAL><SUM>999</SUM></CHECKTOTAL></CHECK>',
    );
    await service.saveDocument(
      'register-1',
      '<CHECK><CHECKHEAD><DOCTYPE>101</DOCTYPE><ORDERNUM>10</ORDERNUM>' +
        '</CHECKHEAD></CHECK>',
    );
    await service.saveDocument(
      'register-1',
      '<CHECK><CHECKHEAD><DOCTYPE>100</DOCTYPE><ORDERNUM>11</ORDERNUM>' +
        '<ORDERDATE>20092026</ORDERDATE><ORDERTIME>210000</ORDERTIME>' +
        '<CASHIER>Test cashier</CASHIER><TESTING>true</TESTING>' +
        '</CHECKHEAD></CHECK>',
    );
    await service.saveDocument(
      'register-1',
      '<CHECK><CHECKHEAD><DOCTYPE>0</DOCTYPE><DOCSUBTYPE>0</DOCSUBTYPE>' +
        '<ORDERNUM>12</ORDERNUM></CHECKHEAD>' +
        '<CHECKTOTAL><SUM>100</SUM><RNDSUM>0.10</RNDSUM>' +
        '<NORNDSUM>99.90</NORNDSUM></CHECKTOTAL>' +
        '<CHECKPAY><ROW><PAYFORMCD>0</PAYFORMCD><PAYFORMNM>Cash</PAYFORMNM>' +
        '<SUM>100</SUM></ROW></CHECKPAY>' +
        '<CHECKTAX><ROW><TYPE>1</TYPE><NAME>VAT</NAME><LETTER>A</LETTER>' +
        '<PRC>20</PRC><TURNOVER>100</TURNOVER><SOURCESUM>80</SOURCESUM>' +
        '<SUM>20</SUM></ROW></CHECKTAX></CHECK>',
    );
    await service.saveDocument(
      'register-1',
      '<CHECK><CHECKHEAD><DOCTYPE>0</DOCTYPE><DOCSUBTYPE>1</DOCSUBTYPE>' +
        '<ORDERNUM>13</ORDERNUM></CHECKHEAD>' +
        '<CHECKTOTAL><SUM>30</SUM></CHECKTOTAL>' +
        '<CHECKPAY><ROW><PAYFORMCD>0</PAYFORMCD><PAYFORMNM>Cash</PAYFORMNM>' +
        '<SUM>30</SUM></ROW></CHECKPAY></CHECK>',
    );
    await service.saveDocument(
      'register-1',
      '<CHECK><CHECKHEAD><DOCTYPE>0</DOCTYPE><DOCSUBTYPE>2</DOCSUBTYPE>' +
        '<ORDERNUM>14</ORDERNUM></CHECKHEAD>' +
        '<CHECKTOTAL><SUM>50</SUM></CHECKTOTAL></CHECK>',
    );

    const totals = await service.getLastTotals('register-1');

    expect(totals.ShiftState).toBe(1);
    expect(totals.Testing).toBeTrue();
    expect(totals.Opened).toBe('2026-09-20T21:00:00');
    expect(totals.OpenName).toBe('Test cashier');
    expect(totals.Totals.Real.Sum).toBe(100);
    expect(totals.Totals.Real.OrdersCount).toBe(1);
    expect(totals.Totals.Real.PayForm[0].Sum).toBe(100);
    expect(totals.Totals.Real.Tax[0].Sum).toBe(20);
    expect(totals.Totals.Ret.Sum).toBe(30);
    expect(totals.Totals.Ret.OrdersCount).toBe(1);
    expect(totals.Totals.ServiceInput).toBe(50);
  });

  it('leaves out a storno and the check it storns', async () => {
    await service.initContext(
      createConfig('register-1'),
      { ...registerState, NextLocalNum: 10 },
      openedShiftTotals,
      serverState,
    );
    const sale = (numLocal: number, fiscalNumber: string, sum: number) =>
      '<CHECK><CHECKHEAD><DOCTYPE>0</DOCTYPE><DOCSUBTYPE>0</DOCSUBTYPE>' +
      `<ORDERNUM>${numLocal}</ORDERNUM><VER>1</VER><ORDERTAXNUM>${fiscalNumber}</ORDERTAXNUM>` +
      `</CHECKHEAD><CHECKTOTAL><SUM>${sum}</SUM></CHECKTOTAL>` +
      '<CHECKPAY><ROW><PAYFORMCD>0</PAYFORMCD><PAYFORMNM>Cash</PAYFORMNM>' +
      `<SUM>${sum}</SUM></ROW></CHECKPAY></CHECK>`;
    await saveAll(service, [
      sale(10, '4000100', 100),
      sale(11, '4000101', 50),
      '<CHECK><CHECKHEAD><DOCTYPE>0</DOCTYPE><DOCSUBTYPE>5</DOCSUBTYPE>' +
        '<ORDERNUM>12</ORDERNUM><ORDERSTORNUM>4000101</ORDERSTORNUM>' +
        '</CHECKHEAD></CHECK>',
    ]);

    const totals = await service.getLastTotals('register-1');

    expect(totals.Totals.Real.Sum).toBe(100);
    expect(totals.Totals.Real.OrdersCount).toBe(1);
    expect(totals.Totals.Real.PayForm[0].Sum).toBe(100);
  });

  it('matches a storno to its check by the fiscal number as written', async () => {
    await service.initContext(
      createConfig('register-1'),
      { ...registerState, NextLocalNum: 10 },
      openedShiftTotals,
      serverState,
    );
    const sale = (numLocal: number, fiscalNumber: string, sum: number) =>
      '<CHECK><CHECKHEAD><DOCTYPE>0</DOCTYPE><DOCSUBTYPE>0</DOCSUBTYPE>' +
      `<ORDERNUM>${numLocal}</ORDERNUM><VER>1</VER><ORDERTAXNUM>${fiscalNumber}</ORDERTAXNUM>` +
      `</CHECKHEAD><CHECKTOTAL><SUM>${sum}</SUM></CHECKTOTAL></CHECK>`;
    // Both read as the number 9007199254740992; as text they are different checks.
    await saveAll(service, [
      sale(10, '9007199254740992', 100),
      sale(11, '9007199254740993', 50),
      '<CHECK><CHECKHEAD><DOCTYPE>0</DOCTYPE><DOCSUBTYPE>5</DOCSUBTYPE>' +
        '<ORDERNUM>12</ORDERNUM><ORDERSTORNUM>9007199254740993</ORDERSTORNUM>' +
        '</CHECKHEAD></CHECK>',
    ]);

    const totals = await service.getLastTotals('register-1');

    expect(totals.Totals.Real.Sum).toBe(100);
    expect(totals.Totals.Real.OrdersCount).toBe(1);
  });

  it('skips only the document immediately before OfflineBegin', async () => {
    await service.initContext(
      createConfig('register-1'),
      { ...registerState, NextLocalNum: 8 },
      openedShiftTotals,
      serverState,
    );
    await service.saveDocument(
      'register-1',
      '<CHECK><CHECKHEAD><DOCTYPE>0</DOCTYPE><DOCSUBTYPE>0</DOCSUBTYPE>' +
        '<ORDERNUM>8</ORDERNUM></CHECKHEAD>' +
        '<CHECKTOTAL><SUM>50</SUM></CHECKTOTAL></CHECK>',
    );
    await service.saveDocument(
      'register-1',
      '<CHECK><CHECKHEAD><DOCTYPE>0</DOCTYPE><DOCSUBTYPE>0</DOCSUBTYPE>' +
        '<ORDERNUM>9</ORDERNUM></CHECKHEAD>' +
        '<CHECKTOTAL><SUM>999</SUM></CHECKTOTAL></CHECK>',
    );
    await service.saveDocument(
      'register-1',
      '<CHECK><CHECKHEAD><DOCTYPE>102</DOCTYPE><ORDERNUM>10</ORDERNUM>' +
        '<ORDERTAXNUM>77.1.100</ORDERTAXNUM><OFFLINE>true</OFFLINE>' +
        '</CHECKHEAD></CHECK>',
    );
    await service.saveDocument(
      'register-1',
      '<CHECK><CHECKHEAD><DOCTYPE>0</DOCTYPE><DOCSUBTYPE>0</DOCSUBTYPE>' +
        '<ORDERNUM>11</ORDERNUM><ORDERTAXNUM>77.2.101</ORDERTAXNUM>' +
        '<OFFLINE>true</OFFLINE></CHECKHEAD>' +
        '<CHECKTOTAL><SUM>100</SUM></CHECKTOTAL></CHECK>',
    );

    const totals = await service.getLastTotals('register-1');

    expect(totals.Totals.Real.Sum).toBe(150);
    expect(totals.Totals.Real.OrdersCount).toBe(2);
  });

  it('adds a return check when stored last totals have a null Ret section', async () => {
    await service.initContext(
      createConfig('register-1'),
      { ...registerState, NextLocalNum: 10 },
      {
        ...openedShiftTotals,
        Totals: {
          Real: {
            Sum: 200,
            OrdersCount: 1,
            PayForm: [{ PayFormCode: 0, PayFormName: 'Cash', Sum: 200 }],
            Tax: [],
          },
          Ret: null,
          ServiceInput: 0,
          ServiceOutput: 0,
        },
      } as LastShiftTotalsResponse,
      serverState,
    );
    await service.saveDocument(
      'register-1',
      '<CHECK><CHECKHEAD><DOCTYPE>102</DOCTYPE><ORDERNUM>10</ORDERNUM>' +
        '<ORDERTAXNUM>77.1.100</ORDERTAXNUM><OFFLINE>true</OFFLINE>' +
        '</CHECKHEAD></CHECK>',
    );
    await service.saveDocument(
      'register-1',
      '<CHECK><CHECKHEAD><DOCTYPE>0</DOCTYPE><DOCSUBTYPE>1</DOCSUBTYPE>' +
        '<ORDERNUM>11</ORDERNUM><ORDERTAXNUM>77.2.101</ORDERTAXNUM>' +
        '<OFFLINE>true</OFFLINE></CHECKHEAD>' +
        '<CHECKTOTAL><SUM>30</SUM></CHECKTOTAL>' +
        '<CHECKPAY><ROW><PAYFORMCD>0</PAYFORMCD><PAYFORMNM>Cash</PAYFORMNM>' +
        '<SUM>30</SUM></ROW></CHECKPAY></CHECK>',
    );

    const totals = await service.getLastTotals('register-1');

    expect(totals.Totals.Real.Sum).toBe(200);
    expect(totals.Totals.Ret.Sum).toBe(30);
    expect(totals.Totals.Ret.OrdersCount).toBe(1);
    expect(totals.Totals.Ret.PayForm[0].Sum).toBe(30);
  });

  it('rejects a document without a valid tax document header', async () => {
    await expectAsync(
      service.saveDocument('register-1', '<INVALID />'),
    ).toBeRejectedWithError(
      'Tax document CHECKHEAD or ZREPHEAD is missing.',
    );
  });

  it('rejects a document with an unexpected local number', async () => {
    await service.initContext(
      createConfig('register-1'),
      registerState,
      openedShiftTotals,
      serverState,
    );
    await service.saveDocument(
      'register-1',
      '<CHECK><CHECKHEAD><DOCTYPE>0</DOCTYPE><ORDERNUM>10</ORDERNUM>' +
        '</CHECKHEAD></CHECK>',
    );

    await expectAsync(
      service.saveDocument(
        'register-1',
        '<CHECK><CHECKHEAD><DOCTYPE>0</DOCTYPE><ORDERNUM>12</ORDERNUM>' +
          '</CHECKHEAD></CHECK>',
      ),
    ).toBeRejectedWithError(
      'Tax document local number 12 is invalid. Expected 11.',
    );
  });

  it('validates document type and subtype against register state', async () => {
    await expectAsync(
      service.validateNextDocument('register-1'),
    ).toBeResolved();

    await service.initContext(
      createConfig('register-1'),
      registerState,
      lastShiftTotals,
      serverState,
    );

    await expectAsync(
      service.validateNextDocument('register-1', 0, 1),
    ).toBeRejectedWithError(
      'Код помилки: 5 ShiftNotOpened\r\nЗміну для ПРРО наразі не відкрито',
    );
    await service.validateNextDocument('register-1', 100);
    await expectAsync(
      service.validateNextDocument('register-1', 999),
    ).toBeRejectedWithError('Tax document DOCTYPE 999 is invalid.');
    await expectAsync(
      service.validateNextDocument('register-1', 100, 1),
    ).toBeRejectedWithError(
      'Tax document DOCSUBTYPE 1 is invalid for DOCTYPE 100.',
    );
  });

  it('marks the offline session start to revoke the last online document', async () => {
    await service.initContext(
      createConfig('register-1'),
      registerState,
      openedShiftTotals,
      serverState,
    );
    await service.saveDocument(
      'register-1',
      '<CHECK><CHECKHEAD><DOCTYPE>102</DOCTYPE><ORDERNUM>10</ORDERNUM>' +
        '<ORDERTAXNUM>77.1.100</ORDERTAXNUM><OFFLINE>true</OFFLINE>' +
        '<CASHREGISTERNUM>register-1</CASHREGISTERNUM>' +
        '</CHECKHEAD></CHECK>',
    );
    await service.saveDocument(
      'register-1',
      '<CHECK><CHECKHEAD><DOCTYPE>0</DOCTYPE><UID>offline-1</UID>' +
        '<ORDERNUM>11</ORDERNUM>' +
        '<ORDERTAXNUM>77.2.101</ORDERTAXNUM><OFFLINE>true</OFFLINE>' +
        '</CHECKHEAD><CHECKTOTAL><SUM>100.00</SUM></CHECKTOTAL></CHECK>',
    );

    expect(
      await service.revokeLastOnline('register-1', 10, '1'),
    ).toBeTrue();

    const documents = await service.getDocuments('register-1');
    expect(documents[0].Storned).toBeTrue();
    expect(documents[0].xmlCheck).toContain(
      '<REVOKELASTONLINEDOC>true</REVOKELASTONLINEDOC>',
    );
  });

  it('does not revoke once the server accepted session documents or still expects the original', async () => {
    await service.initContext(
      createConfig('register-1'),
      registerState,
      openedShiftTotals,
      serverState,
    );
    await service.saveDocument(
      'register-1',
      '<CHECK><CHECKHEAD><DOCTYPE>102</DOCTYPE><ORDERNUM>10</ORDERNUM>' +
        '<ORDERTAXNUM>77.1.100</ORDERTAXNUM><OFFLINE>true</OFFLINE>' +
        '<CASHREGISTERNUM>register-1</CASHREGISTERNUM>' +
        '</CHECKHEAD></CHECK>',
    );
    await service.saveDocument(
      'register-1',
      '<CHECK><CHECKHEAD><DOCTYPE>0</DOCTYPE><ORDERNUM>11</ORDERNUM>' +
        '<ORDERTAXNUM>77.2.101</ORDERTAXNUM><OFFLINE>true</OFFLINE>' +
        '</CHECKHEAD><CHECKTOTAL><SUM>100.00</SUM></CHECKTOTAL></CHECK>',
    );

    // The server already accepted documents of this session.
    expect(await service.revokeLastOnline('register-1', 12, '3')).toBeFalse();
    // The server did not accept the original (it still expects number 9).
    expect(await service.revokeLastOnline('register-1', 9, '1')).toBeFalse();
    expect(
      (await service.getDocuments('register-1'))[0].xmlCheck,
    ).not.toContain('REVOKELASTONLINEDOC');
  });

  it('returns offline documents as a package starting from offline begin', async () => {
    await service.initContext(
      createConfig('register-1'),
      { ...registerState, NextLocalNum: 9 },
      openedShiftTotals,
      serverState,
    );
    const onlineXml =
      '<CHECK><CHECKHEAD><DOCTYPE>0</DOCTYPE><ORDERNUM>9</ORDERNUM>' +
      '<ORDERTAXNUM>1009</ORDERTAXNUM></CHECKHEAD></CHECK>';
    const offlineBeginXml =
      '<CHECK><CHECKHEAD><DOCTYPE>102</DOCTYPE><ORDERNUM>10</ORDERNUM>' +
      '<ORDERTAXNUM>77.1.100</ORDERTAXNUM><OFFLINE>true</OFFLINE>' +
      '</CHECKHEAD></CHECK>';
    const offlineCheckXml =
      '<CHECK><CHECKHEAD><DOCTYPE>0</DOCTYPE><ORDERNUM>11</ORDERNUM>' +
      '<ORDERTAXNUM>77.2.101</ORDERTAXNUM><OFFLINE>true</OFFLINE>' +
      '</CHECKHEAD></CHECK>';
    await service.saveDocument('register-1', onlineXml);
    await service.saveDocument('register-1', offlineBeginXml);
    await service.saveDocument('register-1', offlineCheckXml);

    expect(await service.getOfflineDocuments('register-1', 1)).toEqual([
      offlineBeginXml,
      offlineCheckXml,
    ]);
  });

  it('resumes an offline package from the number requested by the server', async () => {
    await service.initContext(
      createConfig('register-1'),
      {
        ...registerState,
        OfflineSessionId: '77',
        OfflineNextLocalNum: '1',
      },
      openedShiftTotals,
      serverState,
    );
    const firstXml =
      '<CHECK><CHECKHEAD><DOCTYPE>102</DOCTYPE><ORDERNUM>10</ORDERNUM>' +
      '<ORDERTAXNUM>77.1.100</ORDERTAXNUM><OFFLINE>true</OFFLINE>' +
      '</CHECKHEAD></CHECK>';
    const secondXml =
      '<CHECK><CHECKHEAD><DOCTYPE>0</DOCTYPE><ORDERNUM>11</ORDERNUM>' +
      '<ORDERTAXNUM>77.2.101</ORDERTAXNUM><OFFLINE>true</OFFLINE>' +
      '</CHECKHEAD></CHECK>';
    const thirdXml =
      '<CHECK><CHECKHEAD><DOCTYPE>0</DOCTYPE><ORDERNUM>12</ORDERNUM>' +
      '<ORDERTAXNUM>77.3.102</ORDERTAXNUM><OFFLINE>true</OFFLINE>' +
      '</CHECKHEAD></CHECK>';
    await service.saveDocument('register-1', firstXml);
    await service.saveDocument('register-1', secondXml);
    await service.saveDocument('register-1', thirdXml);

    expect(await service.getOfflineDocuments('register-1', 2)).toEqual([
      secondXml,
      thirdXml,
    ]);
    // The server has every document: nothing ordinary remains, only the end.
    expect(await service.getOfflineDocuments('register-1', 4)).toEqual([]);
    // A server position beyond the local session is not silently ignored.
    await expectAsync(service.getOfflineDocuments('register-1', 5)).toBeRejected();
  });

  it('selects only the latest session documents', async () => {
    await service.initContext(
      createConfig('register-1'),
      { ...registerState, OfflineNextLocalNum: '1' },
      openedShiftTotals,
      serverState,
    );
    await service.saveDocument(
      'register-1',
      '<CHECK><CHECKHEAD><DOCTYPE>103</DOCTYPE><ORDERNUM>10</ORDERNUM>' +
        '<ORDERTAXNUM>76.5.100</ORDERTAXNUM><OFFLINE>true</OFFLINE></CHECKHEAD></CHECK>',
    );
    const beginXml =
      '<CHECK><CHECKHEAD><DOCTYPE>102</DOCTYPE><ORDERNUM>11</ORDERNUM>' +
      '<ORDERTAXNUM>77.1.100</ORDERTAXNUM><OFFLINE>true</OFFLINE></CHECKHEAD></CHECK>';
    await service.saveDocument('register-1', beginXml);

    expect(await service.getOfflineDocuments('register-1', 1)).toEqual([beginXml]);
    await expectAsync(service.getOfflineDocuments('register-1', 5)).toBeRejected();
  });

  it('walks back to the requested offline document and includes it', async () => {
    await service.initContext(
      createConfig('register-1'),
      {
        ...registerState,
        OfflineSessionId: '77',
        OfflineNextLocalNum: '1',
      },
      openedShiftTotals,
      serverState,
    );
    const firstXml =
      '<CHECK><CHECKHEAD><DOCTYPE>102</DOCTYPE><ORDERNUM>10</ORDERNUM>' +
      '<ORDERTAXNUM>77.1.100</ORDERTAXNUM><OFFLINE>true</OFFLINE>' +
      '</CHECKHEAD></CHECK>';
    const secondXml =
      '<CHECK><CHECKHEAD><DOCTYPE>0</DOCTYPE><ORDERNUM>11</ORDERNUM>' +
      '<ORDERTAXNUM>77.2.101</ORDERTAXNUM><OFFLINE>true</OFFLINE>' +
      '</CHECKHEAD></CHECK>';
    const fourthXml =
      '<CHECK><CHECKHEAD><DOCTYPE>0</DOCTYPE><ORDERNUM>12</ORDERNUM>' +
      '<ORDERTAXNUM>77.4.102</ORDERTAXNUM><OFFLINE>true</OFFLINE>' +
      '</CHECKHEAD></CHECK>';
    await service.saveDocument('register-1', firstXml);
    await service.saveDocument('register-1', secondXml);
    await service.saveDocument('register-1', fourthXml);

    expect(await service.getOfflineDocuments('register-1', 1)).toEqual([
      firstXml,
      secondXml,
      fourthXml,
    ]);
    expect(await service.getOfflineDocuments('register-1', 2)).toEqual([
      secondXml,
      fourthXml,
    ]);
    // A gap at the server's position is an unresolved state, not permission to skip.
    await expectAsync(service.getOfflineDocuments('register-1', 3)).toBeRejected();
  });

  describe('saving with the server receipt', () => {
    const uid = 'C0FFEE00-0000-4000-8000-000000000001';
    const openShiftXml = (numLocal: number, offline = false) =>
      `<CHECK><CHECKHEAD><DOCTYPE>100</DOCTYPE><UID>${uid}</UID>` +
      `<ORDERNUM>${numLocal}</ORDERNUM><VER>1</VER>` +
      (offline ? `<ORDERTAXNUM>77.2.100</ORDERTAXNUM><OFFLINE>true</OFFLINE>` : '') +
      '</CHECKHEAD></CHECK>';
    const ticket = (numLocal: number, extra = '') =>
      `<?xml version="1.0" encoding="windows-1251"?><TICKET><UID>${uid.toLowerCase()}</UID>` +
      `<ORDERNUM>${numLocal}</ORDERNUM><ORDERTAXNUM>4000${numLocal}</ORDERTAXNUM>${extra}` +
      '<VER>1</VER></TICKET>';
    const credentials =
      '<OFFLINESESSIONID>123456789012345678</OFFLINESESSIONID>' +
      '<OFFLINESEED>987654321098765432</OFFLINESEED>';
    const init = () =>
      service.initContext(
        createConfig('register-1'),
        {
          ...registerState,
          OfflineSessionId: '100',
          OfflineSeed: '200',
          OfflineNextLocalNum: '1',
        },
        lastShiftTotals,
        serverState,
      );

    it('writes the fiscal number, keeps the receipt and returns the saved XML', async () => {
      await init();

      const saved = await service.saveDocument(
        'register-1',
        openShiftXml(10),
        ticket(10),
      );

      expect(saved).toContain('</VER><ORDERTAXNUM>400010</ORDERTAXNUM>');
      const [document] = await service.getDocuments('register-1');
      expect(document.xmlCheck).toBe(saved);
      expect(document.NumFiscal).toBe('400010');
      expect(document.ticketXml).toBe(ticket(10));
      expect(await service.getStagedDocumentBatch()).toEqual([saved]);
    });

    it('keeps the fiscal number as written, with leading zeros and all digits', async () => {
      await init();
      const fiscalNumber = '0012345678901234567';

      await service.saveDocument(
        'register-1',
        openShiftXml(10),
        ticket(10).replace('<ORDERTAXNUM>400010<', `<ORDERTAXNUM>${fiscalNumber}<`),
      );

      const [document] = await service.getDocuments('register-1');
      expect(document.NumFiscal).toBe(fiscalNumber);
      expect(document.xmlCheck).toContain(`<ORDERTAXNUM>${fiscalNumber}</ORDERTAXNUM>`);
    });

    it('puts the shift-opening credentials in force with the document, in one write', async () => {
      await init();
      const contextBefore = storedValues.get('TAX_REGISTER_CONTEXT__register-1');

      await service.saveDocument(
        'register-1',
        openShiftXml(10),
        ticket(10, credentials),
      );

      expect(storedValues.get('TAX_REGISTER_CONTEXT__register-1')).toBe(
        contextBefore,
      );
      const state = await service.getState('register-1');
      expect(state.OfflineSessionId).toBe('123456789012345678');
      expect(state.OfflineSeed).toBe('987654321098765432');
      expect(state.OfflineNextLocalNum).toBe('1');
      expect(state.ShiftState).toBe(1);
    });

    it('keeps the credentials in force when the receipt has none', async () => {
      await init();

      await service.saveDocument('register-1', openShiftXml(10), ticket(10));

      const state = await service.getState('register-1');
      expect(state.OfflineSessionId).toBe('100');
      expect(state.OfflineSeed).toBe('200');
    });

    it('takes credentials only from an online shift opening', async () => {
      await init();
      await service.saveDocument(
        'register-1',
        '<CHECK><CHECKHEAD><DOCTYPE>0</DOCTYPE><UID>' + uid + '</UID><ORDERNUM>10</ORDERNUM>' +
          '<VER>1</VER></CHECKHEAD></CHECK>',
        ticket(10, credentials),
      );

      expect((await service.getState('register-1')).OfflineSessionId).toBe('100');
    });

    it('numbers the offline documents after the new credentials from their session', async () => {
      await init();
      await service.saveDocument('register-1', openShiftXml(10), ticket(10, credentials));
      await saveAll(service, [
        '<CHECK><CHECKHEAD><DOCTYPE>0</DOCTYPE><ORDERNUM>11</ORDERNUM></CHECKHEAD></CHECK>',
        '<CHECK><CHECKHEAD><DOCTYPE>102</DOCTYPE><ORDERNUM>12</ORDERNUM>' +
          '<ORDERTAXNUM>123456789012345678.1.100</ORDERTAXNUM><OFFLINE>true</OFFLINE>' +
          '</CHECKHEAD></CHECK>',
      ]);

      const state = await service.getState('register-1');
      expect(state.OfflineSessionId).toBe('123456789012345678');
      expect(state.OfflineNextLocalNum).toBe('2');
      expect(state.OfflineSession).toBeTrue();
    });

    it('rejects a receipt for another document and saves nothing', async () => {
      await init();

      await expectAsync(
        service.saveDocument('register-1', openShiftXml(10), ticket(11, credentials)),
      ).toBeRejectedWithError(/належить іншому документу \(номер 11, очікується 10\)/);
      await expectAsync(
        service.saveDocument(
          'register-1',
          openShiftXml(10),
          ticket(10).replace(uid.toLowerCase(), 'another-uid'),
        ),
      ).toBeRejectedWithError(/належить іншому документу \(UID another-uid\)/);
      expect(await service.getDocuments('register-1')).toEqual([]);
      expect((await service.getState('register-1')).OfflineSessionId).toBe('100');
    });

    it('ignores ERRORCODE when the receipt carries the fiscal number', async () => {
      await init();

      // Like the official example, which shows every element at once.
      const saved = await service.saveDocument(
        'register-1',
        openShiftXml(10),
        ticket(
          10,
          credentials +
            '<ERRORCODE>1</ERRORCODE><ERRORTEXT>РРО не зареєстрований</ERRORTEXT>',
        ),
      );

      expect(saved).toContain('<ORDERTAXNUM>400010</ORDERTAXNUM>');
      expect((await service.getState('register-1')).OfflineSessionId).toBe(
        '123456789012345678',
      );
    });

    it('rejects a receipt that reports an error without a fiscal number and saves nothing', async () => {
      await init();
      const errorTicket =
        `<TICKET><UID>${uid}</UID><ORDERNUM>10</ORDERNUM><ERRORCODE>7</ERRORCODE>` +
        '<ERRORTEXT>Невірний локальний номер чека, очікується 12</ERRORTEXT><VER>1</VER></TICKET>';

      await expectAsync(
        service.saveDocument('register-1', openShiftXml(10), errorTicket),
      ).toBeRejectedWithError(
        'Код помилки: 7 CheckLocalNumberInvalid\r\nНевірний локальний номер чека, очікується 12',
      );
      expect(await service.getDocuments('register-1')).toEqual([]);
    });

    it('replaces a fiscal number already in the document', async () => {
      await init();

      const saved = await service.saveDocument(
        'register-1',
        openShiftXml(10).replace('</VER>', '</VER><ORDERTAXNUM>1</ORDERTAXNUM>'),
        ticket(10),
      );

      expect(saved).toContain('</VER><ORDERTAXNUM>400010</ORDERTAXNUM></CHECKHEAD>');
      expect((await service.getDocuments('register-1'))[0].NumFiscal).toBe('400010');
    });

    it('refuses a receipt for an offline document', async () => {
      await init();

      await expectAsync(
        service.saveDocument('register-1', openShiftXml(10, true), ticket(10)),
      ).toBeRejectedWithError('Офлайн документ не має квитанції сервера.');
      expect(await service.getDocuments('register-1')).toEqual([]);
    });

    it('uses the server credentials for journals saved before receipts were kept', async () => {
      await init();
      await service.saveDocument('register-1', openShiftXml(10));

      expect((await service.getState('register-1')).OfflineSessionId).toBe('100');
    });

    it('accepts only an offline end in completeOfflineSession', async () => {
      await init();

      await expectAsync(
        service.completeOfflineSession('register-1', openShiftXml(10), {
          OfflineSessionId: '1',
          OfflineSeed: '2',
        }),
      ).toBeRejectedWithError('Tax document is not an offline session end.');
      expect(await service.getDocuments('register-1')).toEqual([]);
    });
  });

  describe('cancelled registration', () => {
    const cancelledState = {
      ...registerState,
      ShiftState: 1,
      Closed: true,
    } as TransactionsRegistrarStateResponse;
    const message = 'Реєстрацію ПРРО скасовано: нові документи не створюються.';

    it('disables the register and rejects every new document', async () => {
      await service.initContext(
        createConfig('register-1'),
        cancelledState,
        openedShiftTotals,
        serverState,
      );
      await service.initContext(
        createConfig('register-2'),
        registerState,
        openedShiftTotals,
        serverState,
      );
      await service.setDisabled('register-2', false);

      expect(await service.isDisabled('register-1')).toBeTrue();
      await expectAsync(
        service.setDisabled('register-1', false),
      ).toBeRejectedWithError('Реєстрацію ПРРО скасовано: касу не можна увімкнути.');
      expect(
        (await service.getAllTaxConfigs()).map((config) => config.taxRegister.fiscalNumber),
      ).toEqual(['register-2']);
      // Sale, shift closing, Z-report (no DOCTYPE) and offline begin.
      for (const docType of [0, 101, undefined, 102]) {
        await expectAsync(
          service.validateNextDocument('register-1', docType),
        ).toBeRejectedWithError(message);
      }
      await expectAsync(
        service.validateNextDocument('register-2', 0),
      ).toBeResolved();
    });

    it('disables an enabled register when a later state reports the cancellation', async () => {
      await service.initContext(
        createConfig('register-1'),
        registerState,
        openedShiftTotals,
        serverState,
      );
      await service.setDisabled('register-1', false);
      expect(await service.isDisabled('register-1')).toBeFalse();

      await service.initContext(
        createConfig('register-1'),
        cancelledState,
        openedShiftTotals,
        serverState,
        true,
      );

      expect(await service.isDisabled('register-1')).toBeTrue();
      expect(
        (await service.getTaxContext('register-1')).disabled,
      ).toBeTrue();
    });
  });

  describe('package API', () => {
    it('requires a storage', () => {
      expect(
        () => new TaxRegisterService(undefined as TaxContextStorage),
      ).toThrowError('Tax context storage is required.');
    });

    it('accepts fixed settings and normalizes them', () => {
      const fixed = new TaxRegisterService(storage, {
        offlineEnabled: false,
        offlinePackageDocumentLimit: 500,
      });

      expect(fixed.offlineSettings.offlineEnabled).toBeFalse();
      expect(fixed.offlineSettings.offlinePackageDocumentLimit).toBe(100);
      expect(service.offlineSettings.offlineEnabled).toBeTrue();
    });

    it('reads settings from a function each time they are needed', () => {
      let enabled = true;
      const dynamic = new TaxRegisterService(storage, () => ({
        offlineEnabled: enabled,
      }));

      expect(dynamic.offlineSettings.offlineEnabled).toBeTrue();
      enabled = false;
      expect(dynamic.offlineSettings.offlineEnabled).toBeFalse();
    });

    it('works with the in-memory storage', async () => {
      const memoryService = new TaxRegisterService(
        new InMemoryTaxContextStorage(),
      );

      await memoryService.initContext(
        createConfig('register-1'),
        registerState,
        openedShiftTotals,
        serverState,
      );
      await memoryService.setDisabled('register-1', false);

      expect(await memoryService.hasContext('register-1')).toBeTrue();
      expect(await memoryService.isDisabled('register-1')).toBeFalse();
    });
  });
});
