import {
  API_MAX_OFFLINE_MONTHLY_DURATION_MINUTES,
  API_MAX_OFFLINE_SESSION_DURATION_MINUTES,
} from '../models/tax-offline-settings.js';
import {
  TransactionsRegistrarStateResponse,
  isOfflineSequenceActive,
} from '../models/tax.model.js';

// Checks that a register may start an offline session, from its state (the server's state,
// or the local state with Offline/OfflineSession). Throws with the reason when it may not.
export function validateOfflineSessionStart(
  state: TransactionsRegistrarStateResponse & {
    Offline?: boolean;
    OfflineSession?: boolean;
  },
): void {
  // Closed: the registration was cancelled while the shift is still open.
  if (state.Closed === true || (state.Closed as unknown) === 'true') {
    throw new Error('Реєстрацію ПРРО скасовано: офлайн режим недоступний.');
  }
  if (!state.OfflineSupported) {
    throw new Error('Каса не підтримує офлайн режим.');
  }
  if (!state.OfflineSessionId || !state.OfflineSeed) {
    throw new Error('Каса не підтримує офлайн режим.');
  }

  if (state.Offline || state.OfflineSession) {
    throw new Error('Каса вже працює в офлайн режимі.');
  }
  if (isOfflineSequenceActive(state.OfflineNextLocalNum)) {
    throw new Error(
      'Неможливо почати нову офлайн сесію, поки не надіслано попередній офлайн пакет.',
    );
  }

  const sessionDuration = Number(state.OfflineSessionDuration ?? 0);
  if (
    !Number.isFinite(sessionDuration) ||
    sessionDuration >= API_MAX_OFFLINE_SESSION_DURATION_MINUTES
  ) {
    throw new Error('Перевищено максимальну тривалість офлайн сесії.');
  }

  const monthlyDuration = Number(state.OfflineSessionsMonthlyDuration ?? 0);
  if (
    !Number.isFinite(monthlyDuration) ||
    monthlyDuration >= API_MAX_OFFLINE_MONTHLY_DURATION_MINUTES
  ) {
    throw new Error('Перевищено максимальну тривалість офлайн сесій за місяць.');
  }
}
