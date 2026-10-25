import {
  MAX_OFFLINE_REQUEST_BYTES,
  OfflineDocumentTooLargeError,
  parseOfflineSessionState,
  prepareOfflinePackage,
  readOfflinePackageResponse,
} from './offline-package.js';
import { base64ByteLength } from '../utils/base64.js';

describe('offline package utility', () => {
  // Fake KEP signer: the signed bytes are the data plus a fixed overhead, returned as Base64.
  const signerWithOverhead =
    (overhead: number) =>
    async (data: string): Promise<string> =>
      btoa('X'.repeat(overhead) + data);
  const decodeCommand = (signedCommand: string, overhead: number) =>
    JSON.parse(atob(signedCommand).slice(overhead));

  let uidCounter: number;
  const newUid = () => `uid-${++uidCounter}`;
  const signedDocs = (count: number, size: number) =>
    Array.from({ length: count }, (_, index) =>
      (index.toString(36) + 'A'.repeat(size)).slice(0, size),
    );
  const xmlFor = (count: number) =>
    Array.from(
      { length: count },
      (_, index) =>
        `<CHECK><CHECKHEAD><ORDERNUM>${10 + index}</ORDERNUM>` +
        `<ORDERTAXNUM>77.${index + 1}.100</ORDERTAXNUM></CHECKHEAD></CHECK>`,
    );

  beforeEach(() => {
    uidCounter = 0;
  });

  it('builds a signed SendOflPackage command with documents in order', async () => {
    const docs = signedDocs(3, 10);

    const result = await prepareOfflinePackage(
      signerWithOverhead(100),
      newUid,
      'register-1',
      docs,
      xmlFor(3),
      0,
    );

    const command = decodeCommand(result.signedCommand, 100);
    expect(result.count).toBe(3);
    expect(command).toEqual({
      Command: 'SendOflPackage',
      Documents: docs,
      UID: result.uid,
    });
    expect(Object.keys(command)).not.toContain('NumFiscal');
  });

  it('never exceeds the document limit', async () => {
    const docs = signedDocs(101, 10);
    const sign = signerWithOverhead(100);

    const first = await prepareOfflinePackage(sign, newUid, 'r', docs, xmlFor(101), 0);
    const second = await prepareOfflinePackage(sign, newUid, 'r', docs, xmlFor(101), 50);
    const third = await prepareOfflinePackage(sign, newUid, 'r', docs, xmlFor(101), 100);
    const configured = await prepareOfflinePackage(sign, newUid, 'r', docs, xmlFor(101), 0, 100);

    expect([first.count, second.count, third.count]).toEqual([50, 50, 1]);
    expect(configured.count).toBe(100);
  });

  it('ends a package at the byte limit and keeps the order', async () => {
    // Three 70,000-byte documents: two fit within 200,000 bytes, three do not.
    const docs = signedDocs(3, 70_000);

    const result = await prepareOfflinePackage(
      signerWithOverhead(1_000),
      newUid,
      'r',
      docs,
      xmlFor(3),
      0,
    );

    expect(result.count).toBe(2);
    expect(result.signedBytes).toBeLessThanOrEqual(MAX_OFFLINE_REQUEST_BYTES);
    expect(decodeCommand(result.signedCommand, 1_000).Documents).toEqual(
      docs.slice(0, 2),
    );
  });

  it('allows exactly 200,000 bytes and rejects 200,001', async () => {
    const doc = signedDocs(1, 1_000);
    const jsonBytes = JSON.stringify({
      Command: 'SendOflPackage',
      Documents: doc,
      UID: 'uid-1',
    }).length;

    const exact = await prepareOfflinePackage(
      signerWithOverhead(MAX_OFFLINE_REQUEST_BYTES - jsonBytes),
      newUid,
      'r',
      doc,
      xmlFor(1),
      0,
    );
    expect(exact.signedBytes).toBe(200_000);

    uidCounter = 0;
    const tooLarge = prepareOfflinePackage(
      signerWithOverhead(MAX_OFFLINE_REQUEST_BYTES - jsonBytes + 1),
      newUid,
      'register-1',
      doc,
      xmlFor(1),
      0,
    );
    await expectAsync(tooLarge).toBeRejectedWith(
      jasmine.objectContaining({
        code: 'OFFLINE_DOCUMENT_TOO_LARGE',
        NumFiscal: 'register-1',
        NumLocal: 10,
        OfflineFiscalNum: '77.1.100',
        measuredBytes: 200_001,
        limitBytes: 200_000,
        retryable: false,
      }),
    );
    await expectAsync(tooLarge).toBeRejectedWithError(OfflineDocumentTooLargeError);
  });

  it('re-measures the signed body when the estimate is too optimistic', async () => {
    // The signature grows with the content, so the singleton overhead underestimates.
    const growingSigner = async (data: string) =>
      btoa('X'.repeat(500 + Math.floor(data.length / 10)) + data);
    const docs = signedDocs(3, 62_000);

    const result = await prepareOfflinePackage(
      growingSigner,
      newUid,
      'r',
      docs,
      xmlFor(3),
      0,
    );

    // The estimate allows three documents (~193,000 bytes); signed they are ~205,000.
    expect(result.count).toBe(2);
    expect(result.signedBytes).toBeLessThanOrEqual(MAX_OFFLINE_REQUEST_BYTES);
  });

  it('acknowledges an ordinary package only with "OK"', () => {
    expect(readOfflinePackageResponse({ success: true, data: 'OK' }, 'uid-1')).toEqual({
      accepted: true,
      state: null,
    });
    expect(
      readOfflinePackageResponse({ success: true, data: ' "OK"\r\n' }, 'uid-1').accepted,
    ).toBeTrue();
    expect(
      readOfflinePackageResponse({ success: true, data: 'something' }, 'uid-1'),
    ).toEqual({ accepted: false, state: null });
  });

  it('reads the end response credentials exactly as written', () => {
    const response = readOfflinePackageResponse(
      {
        success: true,
        data: '{"UID":"uid-1","OfflineSessionId":60259556,"OfflineSeed":123456789012345678901}',
      },
      'uid-1',
    );

    expect(response).toEqual({
      accepted: false,
      state: {
        OfflineSessionId: '60259556',
        OfflineSeed: '123456789012345678901',
      },
    });
    expect(
      readOfflinePackageResponse(
        { success: true, data: { OfflineSessionId: 1, OfflineSeed: 2 } },
        'uid-1',
      ).state,
    ).toEqual({ OfflineSessionId: '1', OfflineSeed: '2' });
  });

  it('rejects errors, mismatched UIDs, and failed requests', () => {
    expect(() =>
      readOfflinePackageResponse(
        { success: true, data: '{"UID":"other","OfflineSessionId":1,"OfflineSeed":2}' },
        'uid-1',
      ),
    ).toThrowError(/UID/);
    expect(() =>
      readOfflinePackageResponse(
        { success: true, data: { ErrorCode: 10, ErrorMessage: 'PackageValidationError' } },
        'uid-1',
      ),
    ).toThrow();
    expect(() =>
      readOfflinePackageResponse(
        { success: false, error: 'Код помилки: 10 PackageValidationError' },
        'uid-1',
      ),
    ).toThrow('Код помилки: 10 PackageValidationError');
  });

  it('parses credentials from Base64 response bytes and ignores incomplete ones', () => {
    expect(
      parseOfflineSessionState(btoa('{"OfflineSessionId":5,"OfflineSeed":"7"}')),
    ).toEqual({ OfflineSessionId: '5', OfflineSeed: '7' });
    expect(parseOfflineSessionState('{"OfflineSessionId":5}')).toBeNull();
    expect(parseOfflineSessionState('OK')).toBeNull();
  });

  it('counts the bytes of a Base64 value', () => {
    expect(base64ByteLength(btoa('a'))).toBe(1);
    expect(base64ByteLength(btoa('ab'))).toBe(2);
    expect(base64ByteLength(btoa('abc'))).toBe(3);
    expect(base64ByteLength('')).toBe(0);
  });
});
