# tax-register-core

Локальний стан програмного реєстратора розрахункових операцій (ПРРО) для роботи з Фіскальним сервером ДПС.

Пакет зберігає та веде:

- **контекст ПРРО**: конфігурацію реєстратора, стан, отриманий від сервера (`TransactionsRegistrarState`), підсумки останньої зміни та мітку часу сервера;
- **журнал документів**: XML усіх документів, створених після останньої синхронізації з сервером, як онлайн, так і офлайн;
- **поточний стан**, обчислений із контексту та журналу: наступний локальний номер, наступний номер в офлайн сесії, стан зміни, наявність Z-звіту, ознаки офлайн режиму;
- **підсумки зміни**: суми реалізації та повернень, форми оплати, податки, службове внесення та видача;
- **правила офлайн режиму**: дозвіл на офлайн роботу, ліміт кількості документів і тривалості сесії, вибір документів для пакета, скасування останнього онлайн документа.

Пакет написано на чистому TypeScript. Він не залежить від фреймворків, DOM чи API Node.js і працює в браузері, застосунках Ionic/Capacitor, web workers та Node.js. Єдина залежність під час виконання — `js-sha256`.

## Чого пакет не робить

- Не надсилає запити на Фіскальний сервер.
- Не підписує документи КЕП.
- Не формує XML документів (чеків, Z-звітів, документів офлайн сесії).

Це залишається за застосунком. Застосунок передає в пакет відповіді сервера та готовий XML, а від пакета отримує номери, стан, хеш попереднього документа та перелік документів для надсилання.

## Встановлення

З приватного реєстру:

```bash
npm install tax-register-core
```

Без реєстру, з архіву:

```bash
# у теці пакета
npm pack
# у теці застосунку
npm install ../path/to/tax-register-core-0.0.1.tgz
```

Пакет постачається лише як ES-модуль (`"type": "module"`) з типами TypeScript.

## Швидкий старт

```ts
import {
  TaxContextStorage,
  TaxRegisterService,
} from 'tax-register-core';

// 1. Сховище, яке надає застосунок.
const storage: TaxContextStorage = {
  get: (key) => db.get(key),
  set: (key, value) => db.set(key, value),
  remove: (key) => db.remove(key),
  keys: () => db.keys(),
};

// 2. Один екземпляр сервісу на сховище на весь час роботи застосунку.
//    Налаштування можна передати об'єктом або функцією, яку сервіс викликає щоразу,
//    коли вони потрібні (наприклад, для віддаленої конфігурації).
const context = new TaxRegisterService(storage, () => ({
  offlineEnabled: remoteConfig.taxOfflineEnabled,
  maxOfflineDocuments: remoteConfig.taxMaxOfflineDocuments,
  maxOfflineSessionDurationMinutes: remoteConfig.taxMaxOfflineSessionMinutes,
  offlinePackageDocumentLimit: remoteConfig.taxOfflinePackageDocuments,
  useServerTimeCorrection: remoteConfig.usePrroServerTimeCorrection,
}));

// 3. Підписка на зміни стану: подія передає фіскальний номер ПРРО.
const subscription = context.stateChanged.subscribe((fiscalNumber) =>
  refresh(fiscalNumber),
);
subscription.unsubscribe();
```

Для тестів і короткочасних процесів є `InMemoryTaxContextStorage`, який зберігає дані в пам'яті.

## Основні поняття

### Ідентифікатор ПРРО

Усі методи приймають фіскальний номер ПРРО (`taxConfig.taxRegister.fiscalNumber`) як рядок або число. Сервіс також зберігає відповідність магазину (`taxConfig.store.erpStoreId`) і ПРРО, тому реєстратор можна знайти за ідентифікатором магазину.

### Контекст і журнал

Контекст — це останній знімок даних сервера. Журнал — документи, створені після цього знімка. Поточний стан (`getState`) і підсумки (`getLastTotals`) завжди обчислюються з обох частин, тому після збереження кожного документа вони одразу актуальні, без запиту на сервер.

`initContext` записує новий знімок і **очищає журнал**. Тому викликайте його лише тоді, коли сервер уже має всі документи журналу: у `getState(id)` немає відкритої офлайн сесії, а `NextLocalNum` збігається з відповіддю сервера.

Сам метод захищає журнал лише частково. Без `force = true` він не перезаписує контекст, якщо в **збереженому стані сервера** активна офлайн послідовність (`OfflineNextLocalNum` більше 1): тоді оновлює лише час сервера й повертає `false`. Офлайн документи, створені після останньої синхронізації, у цій перевірці не враховуються, тож перевірку перед викликом має зробити застосунок.

Новий контекст створюється вимкненим (`disabled = true`). Увімкніть його через `setDisabled(id, false)`, коли застосунок готовий працювати з цим ПРРО. Вимкнені ПРРО не потрапляють у `getAllTaxConfigs()`.

### Офлайн сесія

Офлайн документи мають фіскальний номер виду `<OfflineSessionId>.<номер в сесії>.<контрольне число>`. Сервіс розпізнає їх за цим форматом і веде лічильник `OfflineNextLocalNum`:

- документ «Початок офлайн сесії» (`DOCTYPE` 102) отримує номер `1` у сесії;
- кожен наступний документ сесії — наступний номер;
- після збереженого документа «Завершення офлайн сесії» (`DOCTYPE` 103) наступна сесія знову починається з `1`.

Ідентифікатор сесії та «секретне число» (`OfflineSessionId`, `OfflineSeed`) приходять від сервера: у квитанції на онлайн відкриття зміни та у відповіді на пакет із завершенням сесії. Застосунок передає їх у `setOfflineCredentials` або `completeOfflineSession`.

### Черга документів

Кожен збережений документ також потрапляє в окрему чергу. Застосунок може забирати документи з черги порціями (`getStagedDocumentBatch`), наприклад, щоб передати їх у власний бекенд, і видаляти передані (`acknowledgeStagedDocuments`). Черга не впливає на стан ПРРО.

## Типовий сценарій

### 1. Синхронізація з сервером

```ts
// Відповіді сервера отримує застосунок.
const ok = await context.initContext(
  taxConfig,
  registerState,       // відповідь на запит стану ПРРО
  lastShiftTotals,     // підсумки останньої зміни або null
  { UID, Timestamp },  // UID і час відповіді сервера
);
await context.setDisabled(taxConfig.taxRegister.fiscalNumber, false);
```

### 2. Створення документа

```ts
const id = taxConfig.taxRegister.fiscalNumber;

// Перевіряє, чи можна зараз створити документ цього типу.
await context.validateNextDocument(id, TaxDocumentType.SALE_GOODS, 0);

const state = await context.getState(id);
// state.NextLocalNum — ORDERNUM нового документа;
// state.OfflineSession / state.Offline — чи документ створюється офлайн;
// state.OfflineSessionId, state.OfflineSeed, state.OfflineNextLocalNum — для офлайн номера.
const prevDocHash = await context.getLastDocHash(id); // PREVDOCHASH офлайн документа

const xml = buildCheckXml(order, state, prevDocHash); // формує застосунок

// Онлайн: після того як сервер прийняв документ. Офлайн: одразу після створення.
await context.saveDocument(id, xml);
```

`saveDocument` перевіряє, що `ORDERNUM` документа дорівнює очікуваному наступному номеру, і відхиляє документ з іншим номером. Якщо потрібно зберегти кілька документів разом (наприклад, документ, який не вдалося надіслати онлайн, «Початок офлайн сесії» і той самий документ, створений повторно офлайн), використовуйте `saveDocuments`: вона перевіряє послідовність номерів і записує журнал один раз, тож група не може зберегтися частково.

Якщо квитанція на онлайн відкриття зміни містить `OFFLINESESSIONID` і `OFFLINESEED`, передайте їх у `setOfflineCredentials(id, { OfflineSessionId, OfflineSeed })`.

### 3. Надсилання офлайн документів

```ts
// Стан сервера отримує застосунок.
const serverState = await api.getRegisterState(id);

// Позначає «Початок офлайн сесії» для скасування останнього онлайн документа, якщо
// сервер прийняв той документ, з офлайн сесії ще нічого не отримав, а перший документ
// сесії після «Початку» — чек.
await context.revokeLastOnline(
  id,
  serverState.NextLocalNum,
  serverState.OfflineNextLocalNum,
);

// Документи поточної сесії, починаючи з номера, якого чекає сервер.
// Порожній масив, якщо сервер уже має всі документи.
const xmls = await context.getOfflineDocuments(
  id,
  Number(serverState.OfflineNextLocalNum),
);
await api.sendOfflinePackages(xmls, context.offlineSettings.offlinePackageDocumentLimit);
```

`getOfflineDocuments` бере лише документи останньої офлайн сесії і кидає помилку, якщо документа з номером, якого чекає сервер, немає в журналі: пропустити документи не можна. `getOfflineParts` повертає ті самі документи, розбиті на пакети за налаштуванням `offlinePackageDocumentLimit`.

### 4. Завершення офлайн сесії

```ts
const endXml = buildOfflineEndXml(await context.getState(id));
const response = await api.sendOfflineEndPackage(endXml); // { OfflineSessionId, OfflineSeed }

// Зберігає документ завершення і нові дані сесії. Викликайте лише після успішної відповіді.
await context.completeOfflineSession(id, endXml, response);
```

Після цього, коли сервер має всі документи, можна знову синхронізуватися через `initContext`.

## Перевірки перед створенням документа

`validateNextDocument(id, docType, docSubType)` кидає помилку, якщо документ зараз створити не можна:

| Ситуація | Повідомлення |
| --- | --- |
| Невідомий `DOCTYPE` (дозволені 0, 100, 101, 102, 103) | `Tax document DOCTYPE … is invalid.` |
| Недопустимий `DOCSUBTYPE` для типу документа | `Tax document DOCSUBTYPE … is invalid for DOCTYPE ….` |
| Чек, а зміну не відкрито | `Код помилки: 5 ShiftNotOpened …` |
| Чек, а Z-звіт уже зареєстровано | `Код помилки: 8 ZRepAlreadyRegistered …` |
| Відкриття зміни, коли зміну вже відкрито (крім повторного створення відкриття зміни як другого документа офлайн сесії) | `Код помилки: 4 ShiftAlreadyOpened …` |
| Закриття зміни, коли зміну не відкрито | `Код помилки: 5 ShiftNotOpened …` |
| Початок офлайн сесії, коли офлайн роботу вимкнено | `Роботу ПРРО в режимі офлайн вимкнено в налаштуваннях.` |
| Початок офлайн сесії, коли сесію вже відкрито | `Код помилки: 14 OfflineSessionAlreadyOpened …` |
| Початок офлайн сесії, поки не надіслано попередній пакет | `Неможливо почати нову офлайн сесію, поки не надіслано попередній офлайн пакет.` |
| Завершення офлайн сесії, коли сесію не відкрито | `Код помилки: 15 OfflineSessionNotOpened …` |
| У відкритій сесії досягнуто `maxOfflineDocuments` | `Досягнуто максимальну кількість документів офлайн сесії (…). …` |
| Відкрита сесія триває `maxOfflineSessionDurationMinutes` або довше | `Перевищено максимальну тривалість офлайн сесії (… год). …` |

Документ «Завершення офлайн сесії» не підпадає під ліміти кількості й тривалості, тож сесію завжди можна закрити. Z-звіт (без `DOCTYPE`) не перевіряється.

Тривалість сесії рахується від часу документа «Початок офлайн сесії» за тим самим годинником, що й час документів: за часом сервера, якщо увімкнено `useServerTimeCorrection`, інакше за часом пристрою.

## Налаштування

| Налаштування | Призначення | За замовчуванням | Обмеження |
| --- | --- | --- | --- |
| `offlineEnabled` | Чи можна починати офлайн сесію | `true` | — |
| `maxOfflineDocuments` | Найбільша кількість документів в офлайн сесії, разом із «Початком офлайн сесії», без «Завершення» | `1000` | не менше 2 |
| `maxOfflineSessionDurationMinutes` | Найбільша тривалість офлайн сесії, хвилин | `1800` (30 год) | не більше 2160 (36 год, ліміт API) |
| `offlinePackageDocumentLimit` | Кількість документів в одному пакеті | `50` | не більше 100 (ліміт API) |
| `useServerTimeCorrection` | Рахувати час за часом сервера, а не пристрою | `false` | — |

Відсутні чи некоректні значення замінюються значеннями за замовчуванням (`DEFAULT_TAX_OFFLINE_SETTINGS`), а значення поза межами обрізаються до меж. Логічні значення можна передавати й рядками `'true'`/`'false'`. Поточні нормалізовані значення повертає `context.offlineSettings`.

## Сховище

```ts
export interface TaxContextStorage {
  get<T = unknown>(key: string): Promise<T | null | undefined>;
  set(key: string, value: unknown): Promise<unknown>;
  remove(key: string): Promise<unknown>;
  keys(): Promise<string[]>;
}
```

Вимоги до реалізації:

- значення — звичайні об'єкти й масиви, які можна серіалізувати в JSON;
- запис має бути надійно збережений на момент, коли повертається проміс: у сховищі лежить журнал фіскальних документів;
- `keys()` повертає всі ключі сховища, сервіс сам фільтрує свої за префіксами.

Ключі, які використовує сервіс:

| Префікс | Вміст |
| --- | --- |
| `TAX_REGISTER_CONTEXT__<фіскальний номер>` | Контекст ПРРО |
| `TAX_REGISTER_DOCUMENTS__<фіскальний номер>` | Журнал документів |
| `TAX_REGISTER_STORE__<id магазину>` | Фіскальний номер ПРРО магазину |
| `TAX_DOCUMENT_STAGE__<фіскальний номер>` | Черга XML документів |

### Кілька компаній

Розмежування даних — відповідальність сховища. Якщо застосунок працює з кількома компаніями, передайте сховище, уже прив'язане до поточної компанії, або додайте до ключів префікс компанії, щоб ПРРО різних компаній не мали спільних ключів.

## Інтеграція

### Angular

Сервіс не має декораторів Angular. Його можна зареєструвати через фабрику або успадкувати:

```ts
import { Injectable } from '@angular/core';
import { TaxRegisterService } from 'tax-register-core';

@Injectable({ providedIn: 'root' })
export class AppTaxRegisterService extends TaxRegisterService {
  constructor(storage: CompanyStorage, settings: SettingsService) {
    super(storage, () => ({
      ...settings.taxOfflineSettings,
      useServerTimeCorrection: settings.usePrroServerTimeCorrection,
    }));
  }
}
```

`stateChanged.subscribe()` повертає об'єкт з методом `unsubscribe()`, тому наявний код, який підписувався на `EventEmitter` або `Subject`, працює без змін.

### Node.js

```ts
import { InMemoryTaxContextStorage, TaxRegisterService } from 'tax-register-core';

const context = new TaxRegisterService(new InMemoryTaxContextStorage(), {
  offlineEnabled: false,
});
```

Для постійного зберігання реалізуйте `TaxContextStorage` поверх файлу, бази даних чи Redis.

## Довідник методів

**Контекст**

| Метод | Опис |
| --- | --- |
| `initContext(config, state, totals, serverState, force?)` | Записує знімок даних сервера й очищає журнал. Повертає `false` і нічого не перезаписує, якщо збережений стан сервера має активну офлайн послідовність |
| `updateServerState(id, state)` | Замінює стан сервера й видаляє з журналу документи з номером, меншим за `NextLocalNum` |
| `saveTaxConfig(config)` / `getTaxConfig(id)` | Зберігає або повертає конфігурацію ПРРО |
| `getTaxContext(id)` / `getTaxContextByStoreId(storeId)` | Повертає збережений контекст або `null` |
| `getTaxRegisterIdByStoreId(storeId)` / `getTaxRegisterByStoreId(storeId)` | Фіскальний номер або дані ПРРО магазину |
| `getAllTaxConfigs()` | Конфігурації всіх увімкнених ПРРО |
| `hasContext(id)`, `isDisabled(id)`, `setDisabled(id, disabled)` | Наявність і стан контексту |
| `removeContext(id)` | Видаляє контекст, журнал і прив'язку до магазину |
| `getServerTime(id)` | Поточний час сервера, оцінений за різницею з часом пристрою під час синхронізації |

**Стан і документи**

| Метод | Опис |
| --- | --- |
| `getState(id)` | Поточний стан ПРРО з урахуванням журналу |
| `getLastTotals(id)` | Підсумки поточної зміни з урахуванням журналу |
| `validateNextDocument(id, docType, docSubType?)` | Перевірки перед створенням документа (див. вище) |
| `saveDocument(id, xml)` / `saveDocuments(id, xmls)` | Додає документ або групу документів до журналу |
| `getDocuments(id)` | Журнал документів (`DocumentItem[]`) |
| `getLastDocHash(id)` | SHA-256 останнього документа журналу в кодуванні Windows-1251, для `PREVDOCHASH`; `null`, якщо журнал порожній |
| `getStagedDocumentBatch(limit?)` / `acknowledgeStagedDocuments(xmls)` | Черга документів: отримати порцію (за замовчуванням 50, не більше 500) і видалити передані |

**Офлайн режим**

| Метод | Опис |
| --- | --- |
| `offlineSettings` | Поточні нормалізовані налаштування |
| `setOfflineCredentials(id, { OfflineSessionId, OfflineSeed })` | Записує нові дані сесії й скидає лічильник на `1` (`finishOfflineSession` — те саме, стара назва) |
| `completeOfflineSession(id, endXml, credentials)` | Зберігає документ завершення сесії та нові дані сесії |
| `getOfflineDocuments(id, serverOfflineNextLocalNum)` | Документи поточної сесії, яких ще немає на сервері |
| `getOfflineParts(id, serverOfflineNextLocalNum)` | Ті самі документи, розбиті на пакети |
| `revokeLastOnline(id, serverNextLocalNum, serverOfflineNextLocalNum)` | Додає `REVOKELASTONLINEDOC` у «Початок офлайн сесії», коли це допустимо. Повертає `true`, якщо документ змінено |
| `hasOfflineDocs(id)` | Чи є в журналі офлайн документи |
| `clearOfflineDocuments(id)` | Видаляє офлайн документи з журналу й скидає лічильник |
| `saveOfflineSessionError(id, error, operation?)` / `getOfflineSessionErrors(id)` | Журнал помилок офлайн режиму (останні 20) |

## Як рахуються підсумки зміни

`getLastTotals` бере збережені підсумки зміни й додає документи журналу після останнього відкриття зміни:

- чеки продажу додаються до `Real`, чеки повернення (`DOCSUBTYPE` 1) — до `Ret`, разом із формами оплати й податками;
- податки групуються за видом, літерою, ставкою та ознакою `SIGN`;
- службове внесення (2) і отримання підкріплення (3) додаються до `ServiceInput`, службова видача (4) — до `ServiceOutput`;
- чеки сторнування (5), а також відкликані й сторновані документи не враховуються;
- закриття зміни і Z-звіт змінюють стан зміни, а не суми.

Суми округлюються до копійок після кожного додавання.

## Обмеження

- **Один екземпляр на сховище.** Сервіс кешує контексти в пам'яті. Два екземпляри над одним сховищем можуть бачити різні дані.
- **Послідовні операції.** Сервіс не блокує одночасні операції. Застосунок має виконувати операції з одним ПРРО по черзі, наприклад, через чергу промісів для кожного фіскального номера.
- **Немає транзакцій між ключами.** Документ спочатку додається в чергу, потім у журнал. Якщо запис перерветься між цими кроками, документ може опинитися в черзі без журналу.
- **Розбір XML.** `parseXml` підтримує елементи, атрибути, текст, CDATA, коментарі та стандартні сутності (`&amp;`, `&#1040;` тощо). DTD і власні сутності не підтримуються. Рядки, що виглядають як числа, перетворюються на числа: `"0012"` стає `12`, а дуже великі цілі числа можуть втратити точність.
- **Знак ₴.** Його немає в Windows-1251. Для `PREVDOCHASH` він кодується байтом `0xB4`, як і в документах, які надсилає застосунок.

## Інші експорти

- `ITaxConfig` та пов'язані типи (`TaxConfigStore`, `TaxConfigRegister`, `Cashier`, `CashierPrivateKey`).
- Моделі Фіскального сервера: `TransactionsRegistrarStateResponse`, `LastShiftTotalsResponse`, `ShiftTotals`, `DocumentItem` тощо.
- Константи типів документів: `TaxDocumentType`, `TaxDocumentSubType`.
- `normalizeTaxOfflineSettings`, `DEFAULT_TAX_OFFLINE_SETTINGS`, `API_MAX_OFFLINE_SESSION_DURATION_MINUTES`, `API_MAX_OFFLINE_PACKAGE_DOCUMENTS`.
- `parseXml`: перетворює XML фіскального документа на об'єкт без DOM.
- `encodeWin1251`: байти тексту в кодуванні Windows-1251.
- `TaxContextEventEmitter`: простий синхронний емітер подій.

## Розробка

```bash
npm install
npm test        # компілює в .test/ і запускає тести Jasmine у Node.js
npm run build   # збирає в dist/
```

Пакет — лише ES-модуль, тому відносні імпорти в `src` закінчуються на `.js`.

Публікація: `npm publish` у приватний реєстр (перед пакуванням `prepack` збирає пакет). Без реєстру: `npm pack` і встановлення `.tgz`.

## Документи

- `docs/tax-register-context-service-feature.md` — погоджений опис онлайн та офлайн роботи зі сценаріями приймання.
- `docs/official/` — незмінені копії офіційного опису API Фіскального сервера, XML-схем і прикладів, на які посилається опис. Схеми та приклади в кодуванні Windows-1251.
