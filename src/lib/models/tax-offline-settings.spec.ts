import {
  DEFAULT_TAX_OFFLINE_SETTINGS,
  normalizeTaxOfflineSettings,
} from './tax-offline-settings.js';

describe('normalizeTaxOfflineSettings', () => {
  it('uses the defaults for missing settings', () => {
    expect(normalizeTaxOfflineSettings(undefined)).toEqual(
      DEFAULT_TAX_OFFLINE_SETTINGS,
    );
    expect(DEFAULT_TAX_OFFLINE_SETTINGS.maxOfflineSessionDurationMinutes).toBe(
      30 * 60,
    );
    expect(DEFAULT_TAX_OFFLINE_SETTINGS.offlineEnabled).toBeTrue();
  });

  it('reads remote values, including booleans written as text', () => {
    expect(
      normalizeTaxOfflineSettings({
        offlineEnabled: 'false' as unknown as boolean,
        maxOfflineDocuments: '200' as unknown as number,
        maxOfflineSessionDurationMinutes: 600,
        offlinePackageDocumentLimit: 20,
      }),
    ).toEqual({
      offlineEnabled: false,
      maxOfflineDocuments: 200,
      maxOfflineSessionDurationMinutes: 600,
      offlinePackageDocumentLimit: 20,
    });
  });

  it('falls back on invalid values and caps values at the API limits', () => {
    const settings = normalizeTaxOfflineSettings({
      offlineEnabled: 'yes' as unknown as boolean,
      maxOfflineDocuments: 1,
      maxOfflineSessionDurationMinutes: 48 * 60,
      offlinePackageDocumentLimit: 500,
    });

    expect(settings.offlineEnabled).toBeTrue();
    expect(settings.maxOfflineDocuments).toBe(2);
    expect(settings.maxOfflineSessionDurationMinutes).toBe(36 * 60);
    expect(settings.offlinePackageDocumentLimit).toBe(100);
    expect(
      normalizeTaxOfflineSettings({ maxOfflineDocuments: -5 }).maxOfflineDocuments,
    ).toBe(DEFAULT_TAX_OFFLINE_SETTINGS.maxOfflineDocuments);
  });
});
