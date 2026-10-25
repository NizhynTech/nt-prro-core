// Application settings for working offline with a tax register (ПРРО).

export interface TaxOfflineSettings {
  // false: an API or key error never starts an offline session.
  offlineEnabled: boolean;
  // Maximum number of documents in one offline session, OfflineBegin included and OfflineEnd
  // excluded (the end must always be possible). Reaching it blocks new offline documents.
  maxOfflineDocuments: number;
  // Maximum offline session duration, counted from OfflineBegin. The API limit is 36 hours.
  maxOfflineSessionDurationMinutes: number;
  // Documents per SendOflPackage package, 1..100 (API maximum).
  offlinePackageDocumentLimit: number;
}

export const API_MAX_OFFLINE_SESSION_DURATION_MINUTES = 36 * 60;
// Total of all offline sessions in a calendar month.
export const API_MAX_OFFLINE_MONTHLY_DURATION_MINUTES = 168 * 60;
export const API_MAX_OFFLINE_PACKAGE_DOCUMENTS = 100;

export const DEFAULT_TAX_OFFLINE_SETTINGS: TaxOfflineSettings = {
  offlineEnabled: true,
  maxOfflineDocuments: 1000,
  maxOfflineSessionDurationMinutes: 30 * 60,
  offlinePackageDocumentLimit: 50,
};

// Applies the defaults to missing or invalid values and keeps every value within the API
// limits, so a bad remote setting can never exceed them.
export function normalizeTaxOfflineSettings(
  settings: Partial<TaxOfflineSettings> | null | undefined,
): TaxOfflineSettings {
  const defaults = DEFAULT_TAX_OFFLINE_SETTINGS;
  const positiveInteger = (value: unknown, fallback: number) => {
    const number = Number(value);
    return Number.isInteger(number) && number > 0 ? number : fallback;
  };

  const flag = (value: unknown, fallback: boolean) => {
    if (typeof value === 'boolean') {
      return value;
    }
    if (value === 'true' || value === 'false') {
      return value === 'true';
    }
    return fallback;
  };

  return {
    offlineEnabled: flag(settings?.offlineEnabled, defaults.offlineEnabled),
    // OfflineBegin and the recreated document are created together, so at least 2.
    maxOfflineDocuments: Math.max(
      2,
      positiveInteger(settings?.maxOfflineDocuments, defaults.maxOfflineDocuments),
    ),
    maxOfflineSessionDurationMinutes: Math.min(
      API_MAX_OFFLINE_SESSION_DURATION_MINUTES,
      positiveInteger(
        settings?.maxOfflineSessionDurationMinutes,
        defaults.maxOfflineSessionDurationMinutes,
      ),
    ),
    offlinePackageDocumentLimit: Math.min(
      API_MAX_OFFLINE_PACKAGE_DOCUMENTS,
      positiveInteger(
        settings?.offlinePackageDocumentLimit,
        defaults.offlinePackageDocumentLimit,
      ),
    ),
  };
}
