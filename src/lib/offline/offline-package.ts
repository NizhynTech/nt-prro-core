import { SendOflPackageCommand } from '../commands/tax-commands.js';
import { API_MAX_OFFLINE_PACKAGE_DOCUMENTS } from '../models/tax-offline-settings.js';
import { OfflineSessionState } from '../tax-register.service.js';
import {
  base64ByteLength,
  decodeBase64ToBinaryString,
} from '../utils/base64.js';

// "Запит надсилання пакета офлайн документів" (SendOflPackage): packing, size limits, and
// response normalization. No I/O: signing is passed in, so the rules can be tested alone.

export const MAX_OFFLINE_PACKAGE_DOCUMENTS = API_MAX_OFFLINE_PACKAGE_DOCUMENTS; // API maximum ("Пакет офлайн документів").
export const OFFLINE_PACKAGE_DOCUMENT_LIMIT = 50; // Application package size, 1..MAX_OFFLINE_PACKAGE_DOCUMENTS.
export const MAX_OFFLINE_REQUEST_BYTES = 200_000; // Signed SendOflPackage body, inclusive.

export type SignData = (data: string) => Promise<string>; // Returns Base64 of the KEP-signed data.

export interface PreparedOfflinePackage {
  signedCommand: string; // Base64 of the signed SendOflPackage JSON.
  uid: string;
  count: number; // Documents taken from the list, starting at `start`.
  signedBytes: number;
}

// Result of sending a package, as the application's transport reports it.
export interface OfflinePackageResult {
  success: boolean;
  // Response body: "OK", JSON text, Base64 of the response bytes, or an already parsed object.
  data?: unknown;
  error?: unknown;
}

export interface OfflinePackageResponse {
  accepted: boolean; // "OK": an ordinary package was accepted.
  state: OfflineSessionState | null; // Next session's credentials: the end package was accepted.
}

// A single offline document (or the end draft) whose one-document package exceeds the byte
// limit. Not retried automatically; nothing after it is sent.
export class OfflineDocumentTooLargeError extends Error {
  readonly code = 'OFFLINE_DOCUMENT_TOO_LARGE';
  readonly retryable = false;

  constructor(
    readonly NumFiscal: string,
    readonly NumLocal: number,
    readonly OfflineFiscalNum: string,
    readonly measuredBytes: number,
    readonly limitBytes = MAX_OFFLINE_REQUEST_BYTES,
  ) {
    super(
      `Офлайн документ №${NumLocal} (${OfflineFiscalNum}) завеликий для пакета: ${measuredBytes} байт, допустимо ${limitBytes}.`,
    );
    Object.setPrototypeOf(this, OfflineDocumentTooLargeError.prototype);
  }
}

// Builds the largest package starting at `start` with at most `documentLimit` documents and a
// signed body of at most MAX_OFFLINE_REQUEST_BYTES. The signature overhead is measured on the
// one-document package; the chosen package is then signed and measured exactly.
export async function prepareOfflinePackage(
  sign: SignData,
  newUid: () => string,
  numFiscal: string,
  signedDocuments: string[],
  xmlDocuments: string[],
  start: number,
  documentLimit = OFFLINE_PACKAGE_DOCUMENT_LIMIT,
): Promise<PreparedOfflinePackage> {
  const signCandidate = async (count: number) => {
    const uid = newUid();
    const json = new SendOflPackageCommand(
      signedDocuments.slice(start, start + count),
      uid,
    ).toString();
    const signedCommand = await sign(json);
    return {
      signedCommand,
      uid,
      count,
      jsonBytes: json.length, // Base64 and ASCII only: one byte per character.
      signedBytes: base64ByteLength(signedCommand),
    };
  };

  const single = await signCandidate(1);
  if (single.signedBytes > MAX_OFFLINE_REQUEST_BYTES) {
    throw offlineDocumentTooLarge(
      numFiscal,
      xmlDocuments[start],
      single.signedBytes,
    );
  }

  const signatureOverhead = single.signedBytes - single.jsonBytes;
  const maxCount = Math.min(
    Math.max(1, Math.trunc(documentLimit)),
    MAX_OFFLINE_PACKAGE_DOCUMENTS,
    signedDocuments.length - start,
  );
  let count = 1;
  let estimatedJsonBytes = single.jsonBytes;
  while (count < maxCount) {
    // Each further document adds its Base64 text, two quotes, and a comma.
    const nextJsonBytes =
      estimatedJsonBytes + signedDocuments[start + count].length + 3;
    if (nextJsonBytes + signatureOverhead > MAX_OFFLINE_REQUEST_BYTES) {
      break;
    }
    estimatedJsonBytes = nextJsonBytes;
    count++;
  }

  // The estimate selects the candidate; only the exact measurement authorizes sending.
  while (count > 1) {
    const candidate = await signCandidate(count);
    if (candidate.signedBytes <= MAX_OFFLINE_REQUEST_BYTES) {
      return candidate;
    }
    count--;
  }

  return single;
}

// Normalizes a SendOflPackage response: "OK" acknowledges an ordinary package, JSON with
// OfflineSessionId and OfflineSeed acknowledges the package with OfflineEnd.
export function readOfflinePackageResponse(
  result: OfflinePackageResult,
  requestUid: string,
): OfflinePackageResponse {
  if (!result?.success) {
    throw result?.error || result;
  }

  const data = result.data;
  const text = typeof data === 'string' ? data.trim() : null;
  const errorCode =
    data && typeof data === 'object'
      ? (data as { ErrorCode?: number }).ErrorCode
      : text && /"ErrorCode"\s*:\s*(\d+)/.exec(text)?.[1];
  if (errorCode != null && Number(errorCode) !== 0) {
    throw data;
  }

  const responseUid =
    data && typeof data === 'object'
      ? (data as { UID?: string }).UID
      : text && /"UID"\s*:\s*"([^"]+)"/.exec(text)?.[1];
  if (responseUid && responseUid !== requestUid) {
    throw new Error(
      'UID відповіді сервера не відповідає UID надісланого офлайн пакета.',
    );
  }

  const accepted = text !== null && text.replace(/^"|"$/g, '') === 'OK';
  return {
    accepted,
    state: accepted ? null : parseOfflineSessionState(data),
  };
}

// Reads the end-package credentials: an already parsed object, JSON text, or Base64 of the
// response bytes. Identifiers are read from the text as written, not via a float.
export function parseOfflineSessionState(
  data: unknown,
): OfflineSessionState | null {
  if (data && typeof data === 'object') {
    const value = data as Partial<OfflineSessionState>;
    if (value.OfflineSessionId == null || value.OfflineSeed == null) {
      return null;
    }
    return {
      OfflineSessionId: String(value.OfflineSessionId),
      OfflineSeed: String(value.OfflineSeed),
    };
  }
  if (typeof data !== 'string' || !data.trim()) {
    return null;
  }

  let text = data.trim();
  if (!text.includes('OfflineSessionId')) {
    try {
      text = decodeBase64ToBinaryString(text);
    } catch {
      return null;
    }
  }

  const sessionId = /"OfflineSessionId"\s*:\s*"?(\d+)"?/.exec(text)?.[1];
  const seed = /"OfflineSeed"\s*:\s*"?(\d+)"?/.exec(text)?.[1];
  return sessionId && seed
    ? { OfflineSessionId: sessionId, OfflineSeed: seed }
    : null;
}

function offlineDocumentTooLarge(
  numFiscal: string,
  xmlDocument: string,
  measuredBytes: number,
): OfflineDocumentTooLargeError {
  const numLocal = Number(/<ORDERNUM>(\d+)<\/ORDERNUM>/.exec(xmlDocument)?.[1]);
  const offlineFiscalNum =
    /<ORDERTAXNUM>([^<]+)<\/ORDERTAXNUM>/.exec(xmlDocument)?.[1] || '';
  return new OfflineDocumentTooLargeError(
    numFiscal,
    numLocal,
    offlineFiscalNum,
    measuredBytes,
  );
}
