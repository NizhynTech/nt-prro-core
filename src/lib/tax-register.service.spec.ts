import {
  DocumentItem,
  ITaxConfig,
  LastShiftTotalsResponse,
  TransactionsRegistrarStateResponse,
} from './models/tax.model.js';
import { TaxOfflineSettings } from './models/tax-offline-settings.js';
import {
  InMemoryTaxContextStorage,
  TaxContextStorage,
} from './storage/tax-context-storage.js';
import {
  TaxRegisterContext,
  TaxRegisterService,
} from './tax-register.service.js';

describe('TaxRegisterService', () => {
  let service: TaxRegisterService;
  let storedValues: Map<string, unknown>;
  let storage: jasmine.SpyObj<TaxContextStorage>;

  const createConfig = (fiscalNumber: string, storeId = 1): ITaxConfig =>
    ({
      tin: '1234567890',
      store: { erpStoreId: storeId },
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
      storeId: 1,
      taxConfig,
      registerState,
      lastShiftTotals,
      serverState: {
        response: serverState,
        currentTime: currentTime.toISOString(),
      },
      disabled: true,
    } as TaxRegisterContext);
    expect(storedValues.get('TAX_REGISTER_STORE__1')).toBe('register-1');
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
      createConfig('register-2', 2),
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
      createConfig('register-2', 2),
      { ...registerState, UID: 'second-register-state' },
      lastShiftTotals,
      serverState,
    );

    expect(storedValues.has('TAX_REGISTER_CONTEXT__register-1')).toBeTrue();
    expect(storedValues.has('TAX_REGISTER_CONTEXT__register-2')).toBeTrue();
  });

  it('gets the stored tax register by store id', async () => {
    const config = createConfig('register-1', 15);
    await service.initContext(
      config,
      registerState,
      lastShiftTotals,
      serverState,
    );
    const restoredService = new TaxRegisterService(storage);

    expect(await restoredService.getTaxRegisterByStoreId(15)).toEqual(
      config.taxRegister,
    );
    expect(await restoredService.getTaxRegisterByStoreId(16)).toBeNull();
  });

  it('resolves the tax register id from a store mapping', async () => {
    await service.initContext(
      createConfig('register-1', 15),
      registerState,
      lastShiftTotals,
      serverState,
    );

    expect(await service.getTaxRegisterIdByStoreId(15)).toBe('register-1');
    expect(await service.getTaxRegisterIdByStoreId(16)).toBeNull();
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

    const forceInitialized = await service.initContext(
      createConfig('register-1'),
      olderIncomingState,
      openedShiftTotals,
      serverState,
      true,
    );

    expect(forceInitialized).toBeTrue();
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
    expect(
      await restoredService.hasOfflineDocs('register-1'),
    ).toBeFalse();
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

  it('updates server state and removes documents older than NextLocalNum', async () => {
    await service.initContext(
      createConfig('register-1'),
      { ...registerState, NextLocalNum: 9 },
      openedShiftTotals,
      serverState,
    );
    for (const orderNumber of [9, 10, 11]) {
      await service.saveDocument(
        'register-1',
        `<CHECK><CHECKHEAD><DOCTYPE>0</DOCTYPE><ORDERNUM>${orderNumber}</ORDERNUM>` +
          `<ORDERTAXNUM>${orderNumber}</ORDERTAXNUM></CHECKHEAD></CHECK>`,
      );
    }
    const updatedState = {
      ...registerState,
      NextLocalNum: 11,
      OfflineNextLocalNum: '3',
    } as TransactionsRegistrarStateResponse;

    await service.updateServerState('register-1', updatedState);

    const context = storedValues.get(
      'TAX_REGISTER_CONTEXT__register-1',
    ) as TaxRegisterContext;
    expect(context.registerState).toEqual(updatedState);
    expect(
      (await service.getDocuments('register-1')).map(
        (document) => document.NumLocal,
      ),
    ).toEqual([11]);
    expect((await service.getState('register-1')).Offline).toBeFalse();
    expect((await service.getState('register-1')).OfflineSession).toBeFalse();

    await service.updateServerState('register-1', {
      ...updatedState,
      NextLocalNum: 12,
      OfflineNextLocalNum: '1',
    });

    expect(await service.getDocuments('register-1')).toEqual([]);
    expect((await service.getState('register-1')).Offline).toBeFalse();
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
    await service.saveDocument(
      'register-1',
      '<CHECK><CHECKHEAD><DOCTYPE>103</DOCTYPE><ORDERNUM>11</ORDERNUM>' +
        '<ORDERTAXNUM>100.2.2</ORDERTAXNUM><OFFLINE>true</OFFLINE>' +
        '</CHECKHEAD></CHECK>',
    );
    const totalsBeforeFinish = await service.getLastTotals('register-1');

    await service.finishOfflineSession('register-1', {
      OfflineSessionId: 60259556,
      OfflineSeed: 668820867191246,
    });

    const context = storedValues.get(
      'TAX_REGISTER_CONTEXT__register-1',
    ) as TaxRegisterContext;
    expect(context.registerState.OfflineSessionId).toBe('60259556');
    expect(context.registerState.OfflineSeed).toBe(
      '668820867191246',
    );
    expect(context.registerState.OfflineNextLocalNum).toBe('1');
    expect(context.registerState.NextLocalNum).toBe(10);
    expect((await service.getState('register-1')).NextLocalNum).toBe(12);
    expect(context.lastShiftTotals).toEqual(lastShiftTotals);
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
    expect(await service.hasOfflineDocs('register-1')).toBeFalse();
    expect((await service.getState('register-1')).OfflineNextLocalNum).toBe(
      '1',
    );
    expect((await service.getState('register-1')).Offline).toBeFalse();
  });

  it('saves and returns offline session errors', async () => {
    await service.initContext(
      createConfig('register-1'),
      registerState,
      lastShiftTotals,
      serverState,
    );

    await service.saveOfflineSessionError(
      'register-1',
      new Error('Сервер податкової недоступний'),
      'stopOfflineSession',
    );
    await service.saveOfflineSessionError(
      'register-1',
      'PackageValidationError',
      'stopOfflineSession',
    );

    expect(await service.getOfflineSessionErrors('register-1')).toEqual([
      jasmine.objectContaining({
        message: 'Сервер податкової недоступний',
        operation: 'stopOfflineSession',
      }),
      jasmine.objectContaining({
        message: 'PackageValidationError',
        operation: 'stopOfflineSession',
      }),
    ]);
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
    expect(await service.hasOfflineDocs('register-1')).toBeTrue();
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
      await target.saveDocuments('register-1', [
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
      await target.saveDocuments('register-1', [
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
      await target.saveDocuments('register-1', [
        offlineXml(102, 10, 1, startedAt),
        offlineXml(0, 11, 2, startedAt),
      ]);

      await expectAsync(target.validateNextDocument('register-1', 0)).toBeResolved();
    });

    it('uses the settings package size for offline parts', async () => {
      const target = withSettings({ offlinePackageDocumentLimit: 2 });
      await initOpenShift(target);
      const xmls = [offlineXml(102, 10, 1), offlineXml(0, 11, 2), offlineXml(0, 12, 3)];
      await target.saveDocuments('register-1', xmls);

      expect(await target.getOfflineParts('register-1', 1)).toEqual([
        xmls.slice(0, 2),
        xmls.slice(2),
      ]);
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

  it('saves a group of documents in one journal write', async () => {
    await service.initContext(
      createConfig('register-1'),
      { ...registerState, OfflineNextLocalNum: '1' },
      openedShiftTotals,
      serverState,
    );
    const xmls = [
      '<CHECK><CHECKHEAD><DOCTYPE>0</DOCTYPE><ORDERNUM>10</ORDERNUM></CHECKHEAD></CHECK>',
      '<CHECK><CHECKHEAD><DOCTYPE>102</DOCTYPE><ORDERNUM>11</ORDERNUM>' +
        '<ORDERTAXNUM>77.1.100</ORDERTAXNUM><OFFLINE>true</OFFLINE></CHECKHEAD></CHECK>',
      '<CHECK><CHECKHEAD><DOCTYPE>0</DOCTYPE><ORDERNUM>12</ORDERNUM>' +
        '<ORDERTAXNUM>77.2.101</ORDERTAXNUM><OFFLINE>true</OFFLINE></CHECKHEAD></CHECK>',
    ];

    await service.saveDocuments('register-1', xmls);

    expect((await service.getDocuments('register-1')).length).toBe(3);
    const state = await service.getState('register-1');
    expect(state.NextLocalNum).toBe(13);
    expect(state.OfflineNextLocalNum).toBe('3');
  });

  it('rejects a document group with a numbering gap and saves none of it', async () => {
    await service.initContext(
      createConfig('register-1'),
      registerState,
      openedShiftTotals,
      serverState,
    );

    await expectAsync(
      service.saveDocuments('register-1', [
        '<CHECK><CHECKHEAD><DOCTYPE>0</DOCTYPE><ORDERNUM>10</ORDERNUM></CHECKHEAD></CHECK>',
        '<CHECK><CHECKHEAD><DOCTYPE>0</DOCTYPE><ORDERNUM>12</ORDERNUM></CHECKHEAD></CHECK>',
      ]),
    ).toBeRejectedWithError('Tax document local number 12 is invalid. Expected 11.');
    expect(await service.getDocuments('register-1')).toEqual([]);
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
    await service.saveDocuments('register-1', [
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

    expect(await service.getOfflineParts('register-1', 1)).toEqual([
      [offlineBeginXml, offlineCheckXml],
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

    expect(await service.getOfflineParts('register-1', 2)).toEqual([
      [secondXml, thirdXml],
    ]);
    // The server has every document: nothing ordinary remains, only the end.
    expect(await service.getOfflineParts('register-1', 4)).toEqual([]);
    // A server position beyond the local session is not silently ignored.
    await expectAsync(service.getOfflineParts('register-1', 5)).toBeRejected();
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

    expect(await service.getOfflineParts('register-1', 1)).toEqual([[beginXml]]);
    await expectAsync(service.getOfflineParts('register-1', 5)).toBeRejected();
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

    expect(await service.getOfflineParts('register-1', 1)).toEqual([
      [firstXml, secondXml, fourthXml],
    ]);
    expect(await service.getOfflineParts('register-1', 2)).toEqual([
      [secondXml, fourthXml],
    ]);
    // A gap at the server's position is an unresolved state, not permission to skip.
    await expectAsync(service.getOfflineParts('register-1', 3)).toBeRejected();
  });

  it('splits offline documents into packages of 50', async () => {
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

    const documents: string[] = [];
    for (let index = 1; index <= 51; index++) {
      const xml =
        `<CHECK><CHECKHEAD><DOCTYPE>${index === 1 ? 102 : 0}</DOCTYPE>` +
        `<ORDERNUM>${9 + index}</ORDERNUM>` +
        `<ORDERTAXNUM>77.${index}.100</ORDERTAXNUM>` +
        '<OFFLINE>true</OFFLINE></CHECKHEAD></CHECK>';
      documents.push(xml);
      await service.saveDocument('register-1', xml);
    }

    expect(await service.getOfflineParts('register-1', 1)).toEqual([
      documents.slice(0, 50),
      documents.slice(50),
    ]);
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

    it('works with the in-memory storage and emits state changes', async () => {
      const memoryService = new TaxRegisterService(
        new InMemoryTaxContextStorage(),
      );
      const changes: string[] = [];
      const subscription = memoryService.stateChanged.subscribe((id) =>
        changes.push(id),
      );

      await memoryService.initContext(
        createConfig('register-1'),
        registerState,
        openedShiftTotals,
        serverState,
      );
      subscription.unsubscribe();
      await memoryService.setDisabled('register-1', false);

      expect(changes).toEqual(['register-1']);
      expect(await memoryService.getTaxRegisterIdByStoreId(1)).toBe(
        'register-1',
      );
      expect(await memoryService.isDisabled('register-1')).toBeFalse();
    });

    it('keeps emitting to other listeners when one throws', () => {
      const received: string[] = [];
      service.stateChanged.subscribe(() => {
        throw new Error('listener failed');
      });
      service.stateChanged.subscribe((id) => received.push(id));
      spyOn(Promise, 'reject').and.returnValue(Promise.resolve() as never);

      service.stateChanged.emit('register-1');

      expect(received).toEqual(['register-1']);
      expect(Promise.reject).toHaveBeenCalled();
    });
  });
});
