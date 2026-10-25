# tax-register-core

Локальний стан програмного реєстратора розрахункових операцій (ПРРО) для роботи з Фіскальним сервером ДПС.

Пакет зберігає та веде:

- **контекст ПРРО**: конфігурацію реєстратора, стан, отриманий від сервера (`TransactionsRegistrarState`), підсумки останньої зміни та мітку часу сервера;
- **журнал документів**: XML усіх документів, створених після останньої синхронізації з сервером, як онлайн, так і офлайн;
- **поточний стан**, обчислений із контексту та журналу: наступний локальний номер, наступний номер в офлайн сесії, стан зміни, наявність Z-звіту, ознаки офлайн режиму;
- **підсумки зміни**: суми реалізації та повернень, форми оплати, податки, службове внесення та видача;
- **правила офлайн режиму**: дозвіл на офлайн роботу, ліміт кількості документів і тривалості сесії, вибір документів для пакета, скасування останнього онлайн документа;
- **команди Фіскального сервера**: JSON запитів до `/cmd` і типи відповідей (див. «Команди Фіскального сервера»).

Пакет написано на чистому TypeScript. Він не залежить від фреймворків, DOM чи API Node.js і працює в браузері, застосунках Ionic/Capacitor, web workers та Node.js. Єдина залежність під час виконання — `js-sha256`.

## Чого пакет не робить

- Не надсилає запити на Фіскальний сервер.
- Не підписує документи КЕП.
- Не вирішує, які документи створювати: тип документа, номери, час і суми задає застосунок.

Це залишається за застосунком. Застосунок передає в пакет відповіді сервера та дані документів, а від пакета отримує XML, номери, стан, хеш попереднього документа та перелік документів для надсилання.

## Команди Фіскального сервера

Кожна команда — клас, метод `toString()` якого повертає JSON запиту. Застосунок підписує цей текст КЕП і надсилає на `/cmd`. Виняток — `ServerState`: його надсилають без підпису.

```ts
import { LastShiftTotalsCommand, LastShiftTotalsResponse } from 'tax-register-core';

const json = new LastShiftTotalsCommand('4000123456').toString();
// {"Command":"LastShiftTotals","NumFiscal":"4000123456"}
const totals = await api.sendSigned<LastShiftTotalsResponse>(await signer.sign(json));
```

| Клас | Команда | Відповідь |
| --- | --- | --- |
| `ServerStateCommand()` | `ServerState` — час сервера | `ServerStateResponse` |
| `TransactionsRegistrarStateCommand(numFiscal, offlineSessionId?, offlineSeed?, includeTaxObject?)` | `TransactionsRegistrarState` — стан ПРРО | `TransactionsRegistrarStateResponse` |
| `LastShiftTotalsCommand(numFiscal)` | `LastShiftTotals` — підсумки останньої зміни | `LastShiftTotalsResponse` |
| `ShiftsCommand(numFiscal, from, to)` | `Shifts` — зміни за період | `ShiftsResponse` |
| `ShiftDocumentsCommand(numFiscal, shiftId, openShiftFiscalNum)` | `Documents` — документи зміни | `ShiftDocumentsResponse` |
| `CheckExtCommand({ registrarNumFiscal, numFiscal або numLocal, type, acquireCabinetUrl? })` | `CheckExt` — чек | `DocumentResponse` |
| `ZRepExtCommand(registrarNumFiscal, numFiscal, type)` | `ZRepExt` — Z-звіт | `DocumentResponse` |
| `ObjectsCommand()` | `Objects` — господарські об'єкти та їхні ПРРО | `ObjectsResponse` |
| `OperatorsCommand()` | `Operators` — оператори (касири) суб'єкта господарювання | `ResponseOperators` |
| `SendOflPackageCommand(documents, uid)` | `SendOflPackage` — пакет офлайн документів | `"OK"` або дані наступної сесії, див. «Пакети офлайн документів» |

- `ShiftsCommand` охоплює цілі дні: від початку дня `from` до 23:59:59 дня `to`. Дні беруться з локальної дати, а час передається як `/Date(<мс UTC>)/`.
- `type` для `CheckExt` і `ZRepExt` — значення `DocumentRequestType` з опису API (`TaxDocumentResponseType`): `Availability`, `OriginalXml`, `SignedByServerXml`, `Visualization`, `SignedBySenderXml`, `SignedBySenderAndServerXml`.
- `DocumentResponse.Data` містить документ у Base64. Оригінальний XML (`OriginalXml`) закодовано в Windows-1251.
- Необов'язкові поля, які не передано, у JSON не потрапляють.

### Пакети офлайн документів

`SendOflPackageCommand` зазвичай не створюють напряму: пакет формує `prepareOfflinePackage`, а відповідь розбирає `readOfflinePackageResponse`.

```ts
import {
  prepareOfflinePackage,
  readOfflinePackageResponse,
} from 'tax-register-core';

// signedDocuments — Base64 підписаних офлайн документів, xmlDocuments — їхній XML.
let start = 0;
while (start < signedDocuments.length) {
  const prepared = await prepareOfflinePackage(
    (json) => signer.sign(json), // підпис КЕП, повертає Base64
    () => crypto.randomUUID(),
    numFiscal,
    signedDocuments,
    xmlDocuments,
    start,
    context.offlineSettings.offlinePackageDocumentLimit,
  );
  const result = await api.sendCommand(prepared.signedCommand); // { success, data, error }
  const response = readOfflinePackageResponse(result, prepared.uid);
  start += prepared.count;
}
```

- **Розмір пакета.** `prepareOfflinePackage` бере якомога більше документів, починаючи з `start`, але не більше `documentLimit` (і не більше 100, ліміт API). Підписане тіло запиту має бути не більше 200 000 байт (`MAX_OFFLINE_REQUEST_BYTES`). Кількість спочатку оцінюється за розміром підпису пакета з одного документа, потім вибраний пакет підписується й вимірюється точно. Якщо він завеликий, документів стає менше.
- **Завеликий документ.** Якщо навіть пакет з одного документа більший за ліміт, кидається `OfflineDocumentTooLargeError` з номерами документа та розміром. Повторювати таку спробу немає сенсу, а наступні документи не можна надсилати, поки цей не надіслано.
- **Відповідь.** `readOfflinePackageResponse` повертає `{ accepted, state }`. `accepted = true` означає, що звичайний пакет прийнято (`"OK"`). Для пакета із «Завершенням офлайн сесії» `state` містить `OfflineSessionId` і `OfflineSeed` наступної сесії: передайте їх у `completeOfflineSession`. Помилка сервера (`ErrorCode` не 0) або `UID` відповіді, що не збігається з `UID` запиту, кидають виняток.
- **Формат даних.** Відповідь може бути текстом, JSON, Base64 або вже розібраним об'єктом. Ідентифікатори сесії читаються з тексту як рядки, без перетворення на число, тож великі значення не втрачають точності.

## Формування XML документів

`TaxDocumentUtility` формує текст XML документа, який застосунок кодує в Windows-1251 (`encodeWin1251`), підписує й надсилає:

| Метод | Документ | Вхідні дані |
| --- | --- | --- |
| `getCheck(order)` | Чек (`check01.xsd`): заголовок, `CHECKTOTAL`, `CHECKPAY`, `CHECKTAX`, `CHECKBODY` | `ITaxOrder` |
| `getZRepo(report)` | Z-звіт (`zrep01.xsd`) з підсумками зміни `report.shiftTotals` | `ITaxOrder` |
| `getChekDoc(head)` | Чек лише із заголовком: відкриття й закриття зміни, початок і завершення офлайн сесії | `CHECKHEAD` |

`getCheck` і `getZRepo` повертають `{ uid, orderNumber, xml }`, `getChekDoc` — сам текст.

- Суми записуються з двома знаками після крапки, кількість — з трьома. Суми, які прийшли рядком у локальному форматі (`1,200.00`, `1200,00`, `1 000,00`), перетворюються на `1200.00`.
- Символи `<`, `>`, `&`, `'`, `"` екрануються в назвах організації, точки, касира, форм оплати, податків і товарів.
- Текст має бути незмінним для того самого документа: від нього залежать підпис і `PREVDOCHASH` наступного офлайн документа. Тому зміни у форматуванні вносять лише свідомо, разом із тестами.

## Правила документів

### Заголовок документа

Для ПРРО з контекстом заголовок будує сервіс: `context.createDocumentHead(id, request)` (див. «Створення документа»). Функція `createDocumentHead` нижче — для коду без контексту: усі значення передає той, хто викликає.

`createDocumentHead` будує `CHECKHEAD` для `getChekDoc` або для полів `ITaxOrder` і застосовує правила офлайн документів:

```ts
const head = createDocumentHead({
  docType: TaxDocumentType.SALE_GOODS,
  uid: newUid(),
  orderDate: formatOrderDate(now), // DDMMYYYY
  orderTime: formatOrderTime(now), // HHMMSS
  orderNumber: state.NextLocalNum,
  issuer: { tin, ipn, organizationName, pointName, pointAddress, cashRegisterNum, cashDeskNum, cashier },
  testing: state.Testing,
  // Лише для офлайн документа:
  offline: {
    sessionId: state.OfflineSessionId,
    seed: state.OfflineSeed,
    localNum: +state.OfflineNextLocalNum,
    previousDocumentHash: isPreviousDocumentHashRequired(state.OfflineNextLocalNum)
      ? await context.getLastDocHash(id)
      : null,
    checkTotal: total.toFixed(2),
  },
});
```

- Онлайн документ не має `ORDERTAXNUM` (його присвоює сервер) і `PREVDOCHASH`.
- Офлайн документ отримує `OFFLINE`, фіскальний номер `<OfflineSessionId>.<номер у сесії>.<контрольне число>` і, якщо передано, `PREVDOCHASH`.
- «Початок офлайн сесії» і «Завершення офлайн сесії» ніколи не мають `TESTING`.
- `PREVDOCHASH` додається з третього документа сесії (`isPreviousDocumentHashRequired`). Документ «Завершення офлайн сесії» застосунок зазвичай будує з гешем завжди.

### Контрольне число

`getOfflineControlString` складає рядок із секретного числа, дати, часу, `ORDERNUM`, `CASHREGISTERNUM`, `CASHDESKNUM`, а також суми чека й `PREVDOCHASH`, якщо вони є. `getOfflineControlNumber` рахує CRC-32 цього рядка, змінює порядок байтів на зворотний і бере остачу від ділення на 10000 (або 1, якщо остача 0). Офіційний тестовий приклад з опису API дає **4758**, і тести пакета це перевіряють.

### Інші правила

| Функція | Призначення |
| --- | --- |
| `formatOrderDate`, `formatOrderTime`, `parseOrderDateTime` | `ORDERDATE` і `ORDERTIME` з `Date` і назад. Розбір відновлює нулі на початку, які губляться, коли XML прочитано як числа |
| `hashTaxDocument(xml)` | SHA-256 документа в Windows-1251 — значення `PREVDOCHASH` наступного документа |
| `validateOfflineSessionStart(state)` | Чи можна почати офлайн сесію: реєстрацію ПРРО не скасовано, підтримка офлайн режиму, дані сесії, немає ненадісланого пакета, ліміти 36 год на сесію і 168 год на місяць |
| `extractTicketXml(response)`, `parseTaxTicket(xml)` | Квитанція сервера з відповіді на документ. Значення лишаються текстом, тож великі `OFFLINESEED` і `OFFLINESESSIONID` не втрачають точності |
| `getTaxTicketError(ticket)` | Відмова, про яку повідомляє квитанція, у форматі помилок сервера (`Код помилки: …`), або `null`. Квитанція з фіскальним номером означає, що документ зареєстровано, тому її `ERRORCODE` не враховується |
| `setDocumentFiscalNumber(xml, fiscalNumber)` | Записує в онлайн документ фіскальний номер з квитанції: замінює наявний або додає елемент після `VER` |
| `TaxError`, `TaxErrorEnum` | Розбір помилки сервера: код, назва, текст; для помилки 7 — номер, якого очікує сервер |
| `isDocumentRejectedByServer(httpStatus)` | 4xx — сервер відхилив документ; 5xx або немає відповіді — результат невідомий, варто переходити в офлайн |
| `getDocumentVerificationUrl`, `getDocumentVerificationUrlFromXml` | Посилання для перевірки документа на сайті ДПС (QR-код чека). Для Z-звіту, де немає суми в заголовку, параметра `sm` немає |

## Встановлення

З GitHub (так його встановлює застосунок у робочих збірках):

```bash
npm install git+https://github.com/NizhynTech/nt-prro-core.git
```

`dist/` не зберігається в репозиторії: npm збирає пакет скриптом `prepare` під час встановлення, тож у збірці має бути доступ до репозиторію (для приватного — токен або SSH-ключ). Щоб закріпити версію, додайте тег: `...nt-prro-core.git#v0.0.1`.

Для розробки разом із застосунком під'єднайте локальну теку пакета, не змінюючи `package.json`:

```bash
# у теці застосунку
npm link ../path/to/nt-prro-core
```

З приватного реєстру:

```bash
npm install tax-register-core
```

Без реєстру, з архіву:

```bash
# у теці пакета
npm pack
# у теці застосунку
npm install ../path/to/nt-prro-core-0.0.1.tgz
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
}), {
  // UID нових документів. Без нього — crypto.randomUUID(), якщо платформа його має
  // (у браузері лише в безпечному контексті).
  createUid: () => uuid(),
});
```

Сервіс не має подій. Після кожної зміни (збереження документа, ініціалізації, вимкнення ПРРО тощо) застосунок сам повідомляє свої екрани, якщо їм треба оновитися.

Для тестів і короткочасних процесів є `InMemoryTaxContextStorage`, який зберігає дані в пам'яті.

## Основні поняття

### Ідентифікатор ПРРО

Усі методи приймають фіскальний номер ПРРО (`taxConfig.taxRegister.fiscalNumber`) як рядок або число. Інших ідентифікаторів сервіс не знає. Зв'язок ПРРО з сутностями застосунку (магазином, точкою продажу, касою) застосунок зберігає сам.

### Конфігурація застосунку

`TaxRegisterService<TConfig>` зберігає конфігурацію ПРРО застосунку разом із контекстом і повертає її без змін з `getTaxConfig`, `getTaxContext` і `getAllTaxConfigs`. Від неї потрібен лише фіскальний номер (`TaxRegisterConfig`):

```ts
interface AppTaxConfig extends ITaxConfig {
  pointOfSaleId: string; // власні поля застосунку
}

const context = new TaxRegisterService<AppTaxConfig>(storage);
const config = await context.getTaxConfig(fiscalNumber); // AppTaxConfig
```

Без параметра типу використовується `ITaxConfig` з пакета.

### Контекст і журнал

Контекст — це останній знімок даних сервера. Журнал — документи, створені після цього знімка. Поточний стан (`getState`) і підсумки (`getLastTotals`) завжди обчислюються з обох частин, тому після збереження кожного документа вони одразу актуальні, без запиту на сервер.

`initContext` записує новий знімок і **очищає журнал**, тому викликайте його, коли сервер уже має всі документи журналу. Метод не втрачає документів сам: у таких випадках він оновлює лише час сервера й повертає `false`:

- у журналі є документ, якого сервер ще не отримав: локальний номер останнього документа журналу не менший за `NextLocalNum` у переданому стані сервера (або цей номер не вдається прочитати). `force = true` цю перевірку **не** пропускає: спершу передайте документи на сервер або приберіть їх (`clearOfflineDocuments`, `removeContext`);
- без `force = true` — у **збереженому стані сервера** активна офлайн послідовність (`OfflineNextLocalNum` більше 1).

Новий контекст створюється вимкненим (`disabled = true`). Увімкніть його через `setDisabled(id, false)`, коли застосунок готовий працювати з цим ПРРО. Вимкнені ПРРО не потрапляють у `getAllTaxConfigs()`.

Якщо стан сервера, з яким ініціалізовано контекст, має `Closed: true` (реєстрацію ПРРО скасовано, а зміну ще не закрито), ПРРО вимкнений, доки збережений стан це повідомляє: `isDisabled` повертає `true`, `setDisabled(id, false)` відхиляється, а `validateNextDocument` не дозволяє жодного нового документа, зокрема Z-звіту, закриття зміни й початку офлайн сесії.

### Офлайн сесія

Офлайн документи мають фіскальний номер виду `<OfflineSessionId>.<номер в сесії>.<контрольне число>`. Сервіс розпізнає їх за цим форматом і веде лічильник `OfflineNextLocalNum`:

- документ «Початок офлайн сесії» (`DOCTYPE` 102) отримує номер `1` у сесії;
- кожен наступний документ сесії — наступний номер;
- після збереженого документа «Завершення офлайн сесії» (`DOCTYPE` 103) наступна сесія знову починається з `1`.

Ідентифікатор сесії та «секретне число» (`OfflineSessionId`, `OfflineSeed`) приходять від сервера: у квитанції на онлайн відкриття зміни та у відповіді на пакет із завершенням сесії. Окремого методу для них немає. Вони зберігаються разом із документом, який їх приніс: квитанцію передають у `saveDocument`, відповідь — у `completeOfflineSession`. Обидва записують журнал один раз, тож документ і нові дані сесії не можуть зберегтися окремо.

Чинні дані сесії `getState` бере з найновішого документа журналу, з яким їх збережено, а якщо такого немає — зі стану сервера, з яким ініціалізовано контекст.

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

// Перевіряє документ (як validateNextDocument) і будує його заголовок з контексту.
const head = await context.createDocumentHead(id, {
  docType: TaxDocumentType.SALE_GOODS,
  docSubType: 0,
  cashier: signer.subjectFullName,
  checkTotal: order.total.toFixed(2), // CHECKTOTAL/SUM, як у тілі чека
});

const xml = buildCheckXml(head, order); // тіло формує застосунок

// Онлайн (head.OFFLINE = false): після того як сервер прийняв документ, разом із квитанцією.
const savedXml = await context.saveDocument(id, xml, ticketXml);
// Офлайн (head.OFFLINE = true): одразу після створення, без квитанції.
await context.saveDocument(id, xml);
```

`createDocumentHead` бере з контексту все, крім того, що знає лише застосунок:

| Поле | Звідки |
| --- | --- |
| `DOCTYPE`, `DOCSUBTYPE` | `docType`, `docSubType` запиту. Для Z-звіту `docType` не передають |
| `UID` | `createUid` з опцій сервісу |
| `ORDERDATE`, `ORDERTIME` | Час пристрою або, з `useServerTimeCorrection`, оцінений час сервера |
| `ORDERNUM` | `NextLocalNum` поточного стану |
| `TIN`, `IPN`, `ORGNM`, `POINTNM`, `POINTADDR`, `CASHDESKNUM` | `TaxObject` у знімку стану сервера (`CASHDESKNUM` — `NumLocal` цього ПРРО в `TransactionsRegistrars`); значення з `issuer` запиту їх замінюють |
| `CASHREGISTERNUM` | Фіскальний номер ПРРО |
| `CASHIER` | `cashier` запиту: оператор, чиїм ключем підписують документ |
| `TESTING` | Ознака поточної зміни; для відкриття зміни — `testing` запиту |
| `OFFLINE`, `ORDERTAXNUM`, `PREVDOCHASH` | У відкритій офлайн сесії: чинні дані сесії, наступний номер у сесії, `checkTotal` запиту для контрольного числа і, з третього документа сесії, геш останнього документа журналу |

Метод відхиляє запит, якщо документ не можна створити (ті самі перевірки, що й `validateNextDocument`), якщо немає обов'язкових за схемою даних продавця (`TIN`, `ORGNM`, `POINTNM`, `CASHDESKNUM`), касира, даних офлайн сесії, або якщо `checkTotal` не у форматі `0.00`. «Початок офлайн сесії» і «Завершення офлайн сесії» він не будує: для них є `startOfflineSession` і `createOfflineSessionEnd`.

Заголовок дійсний, доки не збережено наступний документ: будуйте, надсилайте й зберігайте документи одного ПРРО по одному.

`saveDocument` перевіряє, що `ORDERNUM` документа дорівнює очікуваному наступному номеру, і відхиляє документ з іншим номером. Повертає XML у тому вигляді, в якому його збережено.

Квитанцію сервера передають такою, як її отримано, у вигляді XML (`extractTicketXml`); розбирає її сервіс. Тоді в тому самому записі журналу:

- квитанцію перевіряють: її `UID` і `ORDERNUM` мають збігатися з документом, інакше документ не зберігається;
- у документ записується фіскальний номер з квитанції (`ORDERTAXNUM`); номер, який уже є в документі, замінюється;
- XML квитанції зберігається з документом (`ticketXml`);
- для онлайн відкриття зміни `OFFLINESESSIONID` і `OFFLINESEED` з квитанції стають чинними даними офлайн сесії. Квитанція без обох значень залишає попередні.

Квитанція — загальна структура: в офіційному прикладі є всі елементи одразу, зокрема `ERRORCODE` поруч із фіскальним номером. Тому `ERRORCODE` не враховується, якщо квитанція містить фіскальний номер. Квитанція без фіскального номера з ненульовим `ERRORCODE` — це відмова сервера: документ не зберігається, а `saveDocument` повертає помилку у форматі `Код помилки: …`. Офлайн документ квитанції не має, тож `saveDocument` з квитанцією його не приймає.

Якщо документ не вдалося зареєструвати онлайн (будь-яка помилка, крім відмови сервера), передайте його в `startOfflineSession(id, originalXml)`. Документ ще не збережений і має наступний локальний номер. Метод спершу перевіряє, чи можна почати офлайн сесію, а тоді одним записом журналу зберігає три документи:

- сам документ, позначений як відкликаний (`<REVOKED>true</REVOKED>`): підсумки та системи, які отримують документи, його не враховують; якщо сервер його все ж зареєстрував, під час надсилання пакета його буде відкликано і там;
- «Початок офлайн сесії» з даними продавця і `UID` документа, номер у сесії `1`;
- той самий документ, перетворений на офлайн: у заголовку змінюються лише локальний номер, дата й час, офлайн фіскальний номер і `OFFLINE`; тіло документа лишається без змін. Номер у сесії `2`.

Повертає XML офлайн копії: її фіскальний номер, дату й час застосунок друкує в чеку.

```ts
const offlineXml = await context.startOfflineSession(id, originalXml);
```

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
// Пакети формує prepareOfflinePackage, див. «Пакети офлайн документів».
await sendOfflinePackages(xmls);
```

`getOfflineDocuments` бере лише документи останньої офлайн сесії і кидає помилку, якщо документа з номером, якого чекає сервер, немає в журналі: пропустити документи не можна.

### 4. Завершення офлайн сесії

```ts
// Будує «Завершення офлайн сесії», але не зберігає його.
const endXml = await context.createOfflineSessionEnd(id, signer.subjectFullName);
const response = await api.sendOfflineEndPackage(endXml); // { OfflineSessionId, OfflineSeed }

// Зберігає документ завершення разом із даними наступної сесії одним записом журналу.
// Викликайте лише після успішної відповіді.
await context.completeOfflineSession(id, endXml, response);
```

`createOfflineSessionEnd` бере дані продавця з «Початку офлайн сесії» цієї сесії, як вони там записані, тож обидва документи сесії збігаються; касира — з параметра. Документ має наступні локальний номер і номер у сесії та геш останнього документа сесії. Сесію має бути відкрито, інакше `Код помилки: 15 OfflineSessionNotOpened …`.

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

## Помилки

Сервіс нічого не логує. Про відмову він повідомляє лише винятком із причиною: перевірка документа, невідповідний номер, квитанція іншого документа, відсутній офлайн документ тощо. Логувати й показувати помилки має застосунок там, де він їх перехоплює.

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
| `TAX_DOCUMENT_STAGE__<фіскальний номер>` | Черга XML документів |

### Кілька компаній

Розмежування даних — відповідальність сховища. Якщо застосунок працює з кількома компаніями, передайте сховище, уже прив'язане до поточної компанії, або додайте до ключів префікс компанії, щоб ПРРО різних компаній не мали спільних ключів.

## Інтеграція

### Angular

Сервіс не має декораторів Angular. Його можна зареєструвати через фабрику або успадкувати:

```ts
import { EventEmitter, Injectable } from '@angular/core';
import { TaxRegisterService } from 'tax-register-core';

@Injectable({ providedIn: 'root' })
export class AppTaxRegisterService extends TaxRegisterService<AppTaxConfig> {
  // Події стану — справа застосунку: тут вони надсилаються після кожної зміни.
  readonly stateChanged = new EventEmitter<string>();

  constructor(storage: CompanyStorage, settings: SettingsService) {
    super(
      storage,
      () => ({
        ...settings.taxOfflineSettings,
        useServerTimeCorrection: settings.usePrroServerTimeCorrection,
      }),
      { createUid: () => UUID.UUID() },
    );
  }

  override async saveDocument(id: string, xml: string, ticketXml?: string) {
    const savedXml = await super.saveDocument(id, xml, ticketXml);
    this.stateChanged.emit(id);
    return savedXml;
  }
}
```

### Підключення локальної копії

Під час розробки пакет можна підключити до застосунку без реєстру:

```bash
# у теці застосунку
npm install ../path/to/nt-prro-core
```

npm створює посилання на теку пакета, а застосунок використовує її `dist/`. Після змін у пакеті виконайте `npm run build`.

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
| `initContext(config, state, totals, serverState, force?)` | Записує знімок даних сервера й очищає журнал. Повертає `false` і нічого, крім часу сервера, не перезаписує, якщо в журналі є документ, якого сервер ще не має, або (без `force`) збережений стан сервера має активну офлайн послідовність |
| `saveTaxConfig(config)` / `getTaxConfig(id)` | Зберігає або повертає конфігурацію ПРРО |
| `getTaxContext(id)` | Повертає збережений контекст або `null` |
| `getAllTaxConfigs()` | Конфігурації всіх увімкнених ПРРО |
| `hasContext(id)`, `isDisabled(id)`, `setDisabled(id, disabled)` | Наявність і стан контексту. ПРРО зі скасованою реєстрацією (`Closed`) завжди вимкнений |
| `removeContext(id)` | Видаляє контекст і журнал |
| `getServerTime(id)` | Поточний час сервера, оцінений за різницею з часом пристрою під час синхронізації |

**Стан і документи**

| Метод | Опис |
| --- | --- |
| `getState(id)` | Поточний стан ПРРО з урахуванням журналу |
| `getLastTotals(id)` | Підсумки поточної зміни з урахуванням журналу |
| `validateNextDocument(id, docType, docSubType?)` | Перевірки перед створенням документа (див. вище) |
| `createDocumentHead(id, request)` | Перевіряє документ і будує його `CHECKHEAD` з контексту; від застосунку — лише тип, касир, сума чека й ознака тестової зміни для її відкриття |
| `saveDocument(id, xml, ticketXml?)` | Додає документ до журналу; з XML квитанції сервера — також фіскальний номер, квитанцію й дані офлайн сесії з відкриття зміни. Повертає збережений XML |
| `startOfflineSession(id, originalXml)` | Продовжує документ офлайн після невдалої онлайн спроби: відкликаний документ, «Початок офлайн сесії» і офлайн копія одним записом журналу. Повертає XML офлайн копії |
| `getDocuments(id)` | Журнал документів (`TaxJournalDocument[]`: `DocumentItem`, а також `ticketXml` і `offlineCredentials`, якщо вони є). `NumFiscal` — рядок, як записано в документі, без втрати нулів на початку й цифр |
| `getLastDocHash(id)` | SHA-256 останнього документа журналу в кодуванні Windows-1251, для `PREVDOCHASH`; `null`, якщо журнал порожній |
| `getStagedDocumentBatch(limit?)` / `acknowledgeStagedDocuments(xmls)` | Черга документів: отримати порцію (за замовчуванням 50, не більше 500) і видалити передані |

**Офлайн режим**

| Метод | Опис |
| --- | --- |
| `offlineSettings` | Поточні нормалізовані налаштування |
| `createOfflineSessionEnd(id, cashier)` | Будує «Завершення офлайн сесії» для відкритої сесії, не зберігаючи його |
| `completeOfflineSession(id, endXml, nextSession)` | Зберігає документ завершення сесії разом із даними наступної сесії одним записом журналу |
| `getOfflineDocuments(id, serverOfflineNextLocalNum)` | Документи поточної сесії, яких ще немає на сервері |
| `revokeLastOnline(id, serverNextLocalNum, serverOfflineNextLocalNum)` | Додає `REVOKELASTONLINEDOC` у «Початок офлайн сесії», коли це допустимо. Повертає `true`, якщо документ змінено |
| `clearOfflineDocuments(id)` | Видаляє офлайн документи з журналу й скидає лічильник |

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

- `TaxRegisterConfig`, `ITaxConfig` та пов'язані типи (`TaxConfigRegister`, `Cashier`, `CashierPrivateKey`).
- Моделі Фіскального сервера: `TransactionsRegistrarStateResponse`, `LastShiftTotalsResponse`, `ShiftTotals`, `DocumentItem` тощо.
- Команди Фіскального сервера та типи відповідей (див. «Команди Фіскального сервера»).
- Пакети офлайн документів: `prepareOfflinePackage`, `readOfflinePackageResponse`, `parseOfflineSessionState`, `OfflineDocumentTooLargeError`, `MAX_OFFLINE_REQUEST_BYTES`, `MAX_OFFLINE_PACKAGE_DOCUMENTS`, `OFFLINE_PACKAGE_DOCUMENT_LIMIT`.
- `decodeBase64ToBinaryString`, `base64ByteLength`: Base64 без DOM.
- Формування XML: `TaxDocumentUtility`, `ITaxOrder`, `ICheckPay`, `ICheckPaySys`, `ICheckTax`, `ICheckProduct`, `CHECKHEAD`, `ICheckDocument`.
- Правила документів (див. «Правила документів»), `TaxTicket`, `DocumentIssuer`, `OfflineDocumentNumbering`, `API_MAX_OFFLINE_MONTHLY_DURATION_MINUTES`.
- `crc32`, `encodeUtf8`.
- `parseXml(xml, { keepText })`: `keepText: true` або список назв залишає значення текстом, а не числами.
- Константи типів документів: `TaxDocumentType`, `TaxDocumentSubType`.
- `normalizeTaxOfflineSettings`, `DEFAULT_TAX_OFFLINE_SETTINGS`, `API_MAX_OFFLINE_SESSION_DURATION_MINUTES`, `API_MAX_OFFLINE_PACKAGE_DOCUMENTS`.
- `parseXml`: перетворює XML фіскального документа на об'єкт без DOM.
- `encodeWin1251`: байти тексту в кодуванні Windows-1251.

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
