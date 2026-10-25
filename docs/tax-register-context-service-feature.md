# TaxRegister service - Feature Description

## Scope and status

This document describes the agreed online and offline document flow for a tax register. It is intended for implementation and testing. Business-flow rules come from the user's requirements. API field meanings are grounded in the official API description "Опис АРІ Фіскального Сервера", revision [`official/578893.docx`](official/578893.docx), especially **"Запит стану ПРРО"**, **"Запит підсумків останньої зміни"**, **"Запит надсилання пакета офлайн документів"**, and **"Реєстрація пристрою"**. Revision 578893 supersedes the earlier revision [`official/523167.docx`](official/523167.docx): it adds the command "Реєстрація пристрою" (`DeviceRegister`) and the section on preventing simultaneous use of one register on several devices, and broadens "Сторнування останнього чека"; the remaining text is unchanged. XML element rules are grounded in the official schemas [`check01.xsd`](official/schemas/check01.xsd), [`zrep01.xsd`](official/schemas/zrep01.xsd), and [`ticket01.xsd`](official/schemas/ticket01.xsd) and the official examples in [`official/examples`](official/examples/). These are unmodified copies of the official files; the schemas and examples are encoded in Windows-1251. Behaviour that has not yet been agreed is listed under **Flow details still to define**; an implementation or test must not silently invent those decisions.

The offline flow is the main focus. It covers entering an offline session, maintaining its document sequence, submitting packages, recovering from uncertain results, and completing synchronization. Remaining details are explicitly marked as open.

## Context-scoped multi-register service

One service must support multiple tax registers through separate `TaxRegisterContext` instances. Every register-specific operation receives its target context explicitly, or uses a handle permanently bound to that context. This applies to initialization, document creation/registration, totals calculation, offline start/continuation, package upload, recovery, and full synchronization. The service must not rely on a mutable, service-wide "current register".

A context is identified by its register fiscal number, `context.NumFiscal`, within the application's company/storage scope. All callers addressing the same register in that scope must resolve to the same logical working context and operation guard; duplicate handles must not create independent journals or counters for the same register. The identity belongs to the context, not to `TransactionsRegistrarStateResponse`, whose API response has no register `NumFiscal` field. The API does not permit using one register on several devices at the same time; see **Single-device use and device registration**.

The following requirements apply independently to each context:

- Working state, totals baseline, documents, both number sequences, session credentials, current recovery session, and activity are isolated from every other register. Persistent storage and cleanup are scoped by context identity too.
- A busy or unfinished offline session in context A blocks the applicable operations only on A. It does not make B busy, stop B's allowed operations, or prevent B's full synchronization. All callers of A must observe A's same activity/guard.
- An operation retains its originating context across all asynchronous requests, responses, and retries. Changing a UI selection or starting work for another register must not redirect a response or overwrite another context. Correlate responses with their originating request/context, including the request `UID` where supplied.
- State/totals request `NumFiscal`, document register identity, session credentials, and applicable signing/transport settings must come from the target context or its bound configuration. Each offline package contains documents from exactly one register and its selected offline session; do not add an invented `NumFiscal` field to `SendOflPackage`.
- Completing full synchronization replaces state/totals and clears documents only for the target context. Shared service or transport dependencies are allowed, but mutable register state must not leak through them.

Throughout the flow below, `context`, `serverShiftState`, `serverLastShiftTotals`, and the active `OfflineSessionContext` refer to the same explicitly selected register. "Global" document numbering means register-wide, not service-wide or application-wide. Different registers may legitimately have identical global or offline document numbers.

## Single-device use and device registration

Revision 578893 states that using one register (fiscal number) on several devices at the same time is not permitted ("Одночасне використання ПРРО з одним і тим самим фіскальним номером на декількох пристроях є недопустимим"). It names the consequences: the current local document number would have to be checked before every fiscal document; missing local numbers would require downloading the missing documents to build a correct Z-report; and if one device works offline while another works online or offline, part of the documents is rejected because of incorrect local numbers.

The flow in this document relies on all documents of a register coming from one device. The revocation decision compares `serverShiftState.NextLocalNum` with `OfflineBegin.NumLocal`, full synchronization compares the server and local next numbers, and package resumption trusts the server's next offline number. A server position caused by another device's documents is not covered by these rules.

The API's remedy is the command "Реєстрація пристрою" (`DeviceRegister`, see **Device registration (`DeviceRegister`)**):

1. Determine the device's unique identifier: a 64-character value, for example the SHA-256 of a network card's MAC address.
2. Send `DeviceRegister` with the register's `NumFiscal` and this identifier. The request is JSON signed with the user's KEP.
3. Compare the `DeviceId` returned by the server with the identifier sent. A different value usually means the same register is registered on another device.
4. Decide on further work based on that comparison.
5. To register this device regardless of the identifier currently registered, send the request with `Forced: true`.

Device registration is per context: use the context's `NumFiscal`, apply the result only to that context, and treat a mismatch as a device conflict of that register only. A rejection with `ErrorCode` 7 (`CheckLocalNumberInvalid`) can be a symptom of such a conflict. When to register the device, how to derive a stable identifier, and what to do after a conflict are listed under **Flow details still to define**.

## Models and API terminology

The TypeScript below defines the contract used by this description; it is not a mandatory storage layout. API models keep the API's field names; local models make journal and workflow state explicit. Full document XML and signing remain their own contracts; the official totals and tax-object structures are transcribed under **Official data structures**.

### `TransactionsRegistrarStateResponse`: the complete register-state response

In this document, **`TransactionsRegistrarStateResponse` means the complete response object** returned by `TransactionsRegistrarState` in "Запит стану ПРРО". `serverShiftState: TransactionsRegistrarStateResponse` is a fresh server response. The context stores the last synchronized response unchanged in `context.serverSnapshot.state`; counters and shift flags are derived from it and the journal, and only the offline credentials in force are stored separately in `context.working` (see **Source of truth**). A server response is never edited locally.

The object also contains a property called `ShiftState`. Therefore, `serverShiftState.ShiftState` means only **0 = shift not open, 1 = shift open**. It is not an online/offline flag. Neither a closed shift nor an open shift alone proves whether an offline session has ended. There is no `{ ShiftState: { ... } }` envelope around the API response.

These are normalized service-facing types. Identifiers and seeds are preserved as strings; offline sequence numbers are canonical positive decimal strings (`'1'`, `'2'`, ...). Global document numbers are positive safe integers. Decode numeric/string wire representations without losing precision; reject malformed counters rather than treating them as 0 or 1. Nullable fields represent unavailable values, not default values. The API uses placeholders rather than specifying every primitive type and every closed-shift null case; the nullable metadata below deliberately accommodates absence without inventing a fiscal value.

```ts
// ShiftTotals and TaxObjectItem: official structures, see "Official data structures".

type GlobalLocalNum = number;        // Positive safe integer; XML ORDERNUM.
type OfflineLocalNum = string;      // Positive decimal integer, canonicalized.
type ApiIdentifier = string;        // Preserve exactly; not a counter.
type ShiftOpenStatus = 0 | 1;

interface CommandResponseMetadata {
  UID: string;                      // Echoes the request UID.
  Timestamp?: string;               // Common API response metadata, ISO 8601.
}

interface OfflineSessionCredentials {
  OfflineSessionId: ApiIdentifier;
  OfflineSeed: string;               // Secret input to offline fiscal-number calculation.
}

interface TransactionsRegistrarStateResponse extends CommandResponseMetadata {
  ShiftState: ShiftOpenStatus;
  ShiftId: ApiIdentifier | null;
  OpenShiftFiscalNum: string | null;
  ZRepPresent: boolean;
  Testing: boolean;
  Name: string | null;
  SubjectKeyId: string | null;        // API: null when the shift is not open.
  FirstLocalNum: number;             // API: 0 when the shift is not open.
  NextLocalNum: GlobalLocalNum;
  LastFiscalNum: string | null;       // API: null when the shift is not open.
  OfflineSupported: boolean;
  ChiefCashier: boolean;
  OfflineSessionId: ApiIdentifier | null;
  OfflineSeed: string | null;
  OfflineNextLocalNum: OfflineLocalNum | null;
  OfflineSessionDuration: number | null;          // Minutes.
  OfflineSessionsMonthlyDuration: number | null; // Minutes, current month.
  OfflineSessionRolledBack: boolean | null;
  OfflineSessionRollbackCmdUID: string | null;
  Closed: boolean;                  // Register registration cancelled while shift remains open.
  TaxObject?: TaxObjectItem;         // Requested with IncludeTaxObject.
}

interface TransactionsRegistrarStateRequest {
  Command: 'TransactionsRegistrarState';
  NumFiscal: string;                // Register fiscal number, not a document number.
  UID: string;
  IncludeTaxObject?: boolean;
  OfflineSessionId?: ApiIdentifier;
  OfflineSeed?: string;
}
```

The request's `OfflineSessionId` and `OfflineSeed` are optional for a general state query but **both are required when querying recovery state for the offline session being uploaded**. Use that session's credentials, not newly issued credentials belonging to the next session. The request is signed with the user's qualified electronic signature, as required by the API.

The API describes null offline fields as offline mode being prohibited and also limits their population to a query signed by the shift-opening operator, a senior user, or a manager. Offline readiness therefore requires `context.serverSnapshot.state.OfflineSupported === true`, a non-null `context.working.offline` (valid session credentials), and a valid non-null `deriveState(context).offlineNextLocalNum`. A missing/null value must never be replaced with a fabricated session ID, seed, or `'1'`, or interpreted as proof of completed recovery. Session credentials are also refreshed from the receipt of every successful online shift opening (see **Offline credentials from shift opening**).

`OfflineSessionRolledBack` means cancellation of an offline-session closure; `OfflineSessionRollbackCmdUID` identifies the request associated with that cancellation. Preserve these response fields. Their effect on recovery is an open protocol decision below; do not interpret them as ordinary successful closure.

### Totals and package responses

```ts
interface LastShiftTotalsRequest {
  Command: 'LastShiftTotals';
  NumFiscal: string;
  UID: string;
}

interface LastShiftTotals extends CommandResponseMetadata {
  ShiftState: ShiftOpenStatus;
  ZRepPresent: boolean;
  Testing: boolean;
  Opened: string | null;
  OpenName: string | null;
  OpenSubjectKeyId: string | null;
  Closed: string | null;             // Closing date/time, NOT TransactionsRegistrarStateResponse.Closed's boolean.
  CloseName: string | null;
  CloseSubjectKeyId: string | null;
  ZRepFiscalNum: string | null;
  Totals: ShiftTotals | null;        // API describes Totals for an open shift.
}

// "Запит надсилання пакета офлайн документів": JSON signed with the user's KEP, posted to /cmd.
interface SendOfflinePackageRequest {
  Command: 'SendOflPackage';
  UID: string;                      // Unique request ID; a new one for every prepared command.
  Documents: string[];              // One element per document: Base64 of the KEP-signed document, ordered by NumLocal.
}

const MAX_OFFLINE_PACKAGE_DOCUMENTS = 100;      // API maximum ("Пакет офлайн документів").
const DEFAULT_OFFLINE_PACKAGE_DOCUMENTS = 50;   // Application default package size.
// packageDocumentLimit: configured per application, 1..MAX_OFFLINE_PACKAGE_DOCUMENTS; DEFAULT_OFFLINE_PACKAGE_DOCUMENTS when not configured.
const MAX_OFFLINE_REQUEST_BYTES = 200_000;       // Conservative client limit, inclusive.

interface PreparedOfflinePackage {
  readonly NumFiscal: string;                   // Local routing metadata, not a new API field.
  readonly UID: string;                         // The UID inside this prepared command.
  readonly documentNumLocals: readonly GlobalLocalNum[];
  readonly uncompressedBody: Uint8Array;        // The KEP-signed SendOflPackage command: the exact /cmd request body, before compression.
}

interface OfflineDocumentTooLargeError extends Error {
  readonly code: 'OFFLINE_DOCUMENT_TOO_LARGE';
  readonly NumFiscal: string;
  readonly NumLocal: GlobalLocalNum;
  readonly OfflineSessionId: ApiIdentifier;
  readonly OfflineLocalNum: OfflineLocalNum;
  readonly measuredBytes: number;               // Complete one-document request body size.
  readonly limitBytes: typeof MAX_OFFLINE_REQUEST_BYTES;
  readonly retryable: false;                    // No automatic retry of the same oversize failure.
}

// SendOflPackage success for a package without OfflineEnd: the plain-text body "OK" (not JSON, no UID).
type OfflinePackageAcceptedResponse = 'OK';

// SendOflPackage success for the package containing OfflineEnd: JSON with the next session's credentials.
interface OfflineSessionState extends OfflineSessionCredentials {
  UID?: string;                     // Not always returned; when present it must equal the request UID.
}

// Command error in resultAsJson=true mode (HTTP 200). Without that parameter the server answers with a
// non-2xx status and the text "Код помилки: <code> <name>\r\n<description>".
interface CommandErrorResponse extends CommandResponseMetadata {
  ErrorCode: number;                // API ErrorCode, e.g. 10 = PackageValidationError.
  ErrorMessage: string;
}

// Normalized successful outcomes; kind is local, not a tax-API JSON property.
type OfflinePackageResult =
  | { kind: 'accepted' }
  | { kind: 'session-ended'; state: OfflineSessionState };
```

`LastShiftTotals` is a separate response, not a field supplied inside `TransactionsRegistrarStateResponse`. Its `Totals` uses the API's `ShiftTotals` structure (see **Official data structures**): `Real` (sales), `Ret` (returns), `ServiceInput`, `ServiceOutput`, and applicable `Cash`/`Currency` totals, including their detailed payment/tax breakdowns. Retain the complete server totals; the flow must not reduce them to a single cash balance. Nullable closed-shift metadata is normalized conservatively. A `LastShiftTotals` HTTP 204 or a closed shift without `Totals` gives `serverSnapshot.totals = null` (see **Initial state and full synchronization**); an open shift without `Totals` is still open (see **Absent state/totals**).

`OfflineSessionState` is the local name for the successful end-package response. On the wire, `OfflineSessionId` and `OfflineSeed` are top-level JSON fields, optionally with `UID`; there is no property named `OfflineSessionState`. The returned credentials belong to the **next** offline session. An ordinary package acknowledgement is `OfflinePackageAcceptedResponse`: the plain-text body `"OK"`, which carries no `UID` and no replacement credentials. This is the server's behaviour for `SendOflPackage`; the API's JSON response description for the command lists `UID`, `OfflineSessionId`, and `OfflineSeed`, and its "Пакет офлайн документів" section describes the `"OK"` answer. Packages are sent only with the `SendOflPackage` command (see **Package transport: the `SendOflPackage` command**); the binary `/pck` endpoint is not used by this flow.

Normalize the response in the context of the package sent. A response to an end-only package that lacks either valid session credential is not a successful `OfflineSessionState` and must not be downgraded to an ordinary `'accepted'` acknowledgement. Leave the end unsaved and reconcile the uncertain result through a fresh state request.

Both state and last-totals requests can return HTTP 204 (no data). This is not a populated `TransactionsRegistrarStateResponse` or `LastShiftTotals`, nor permission to clear documents. Normalize errors separately from these success models. In `resultAsJson=true` mode, HTTP 200 can contain `ErrorCode` and `ErrorMessage`; inspect the body before constructing a success result. Validation-error handling remains as specified below.

### Document receipt (`TICKET`)

```ts
// Receipt (TICKET, ticket01.xsd) of a document registered online; fields used by this flow.
interface DocumentTicket {
  UID: string;                        // UID of the registered document.
  ORDERNUM: GlobalLocalNum;
  ORDERTAXNUM?: string;               // Fiscal number assigned by the server.
  OFFLINESESSIONID?: ApiIdentifier;   // Offline session ID (issued for "Відкриття зміни").
  OFFLINESEED?: string;               // Its secret seed.
  ERRORCODE?: number;                 // API ErrorCode; absent or 0 on success.
  ERRORTEXT?: string;
}
```

The API issues the offline session identifier in the response to the shift-opening document ("Ідентифікатор офлайн сесії надається Сервером у відповідь на документ «Відкриття зміни»"), and its scenario "Новий екземпляр ПРРО" states that this response carries the session ID and the "секретне число". The receipt fields are `OFFLINESESSIONID` and `OFFLINESEED` ([`ticket01.xsd`](official/schemas/ticket01.xsd)). Their handling is specified in **Offline credentials from shift opening**.

### Device registration (`DeviceRegister`)

```ts
// "Реєстрація пристрою" (revision 578893): JSON signed with the user's KEP.
interface DeviceRegisterRequest {
  Command: 'DeviceRegister';
  NumFiscal: string;                // Register fiscal number.
  DeviceId: string;                 // 64-character device identifier, e.g. SHA-256 of a MAC address.
  Forced: boolean;                  // true = replace the identifier registered on the server.
  UID: string;
}

interface DeviceRegisterResponse extends CommandResponseMetadata {
  DeviceId: string;                 // Identifier registered on the Fiscal Server for this register.
}
```

The procedure is described in **Single-device use and device registration**.

### Local documents and working context

```ts
type DocumentKind =
  | 'check' | 'cash-input' | 'cash-output' | 'report'
  | 'shift-open' | 'shift-close' | 'offline-begin' | 'offline-end';

interface TaxRegisterDocument {
  NumLocal: GlobalLocalNum;          // Same number as ORDERNUM in the XML.
  kind: DocumentKind;                // Business category, not the XML root element name.
  xml: string;
  Offline: boolean;
  OfflineSessionId: ApiIdentifier | null;
  OfflineLocalNum: OfflineLocalNum | null; // This document's assigned offline number.
  testing: boolean;                  // Value of the XML TESTING element (false when absent), set when the entry is saved.
  REVOKELASTONLINEDOC?: true;         // Only on the current session's offline-begin.
}

interface TaxRegisterContext {
  readonly NumFiscal: string;        // Register identity within the application's storage scope.
  serverSnapshot: ServerSnapshot;    // Last synchronized server state; replaced only by full sync or an applied refresh.
  working: WorkingState;             // Offline credentials in force.
  documents: TaxRegisterDocument[];  // Journal since that snapshot, ordered by NumLocal.
}

// Server responses exactly as received. Never edited locally.
interface ServerSnapshot {
  readonly state: TransactionsRegistrarStateResponse;
  readonly totals: LastShiftTotals | null; // Totals baseline; null = HTTP 204, no shift data.
  readonly receivedAt: string;       // ISO 8601 local time at which the pair was received.
}

// The only values stored outside the snapshot and the journal.
interface WorkingState {
  offline: OfflineCredentialsInForce | null; // null = no usable offline credentials; offline work is not possible.
}

// Session ID and seed always change together, in one update.
interface OfflineCredentialsInForce {
  readonly sessionId: ApiIdentifier;
  readonly seed: string;
}

// Computed from the snapshot and the journal on every read; never stored.
interface DerivedState {
  nextLocalNum: GlobalLocalNum;                 // Next global number to assign.
  offlineNextLocalNum: OfflineLocalNum | null;  // Next offline number to assign; null = unknown.
  offlineSessionOpen: boolean;                  // An offline session is open locally.
  shift: { open: boolean; zRepPresent: boolean; testing: boolean };
}

declare function deriveState(context: TaxRegisterContext): DerivedState; // Pure; see "Source of truth".

// Runtime view of the existing session being closed, not a new document.
interface OfflineSessionContext extends OfflineSessionCredentials {
  readonly NumFiscal: string;        // Must match the target TaxRegisterContext.NumFiscal.
  originalNumLocal: GlobalLocalNum;
  beginNumLocal: GlobalLocalNum;
}

type RegisterActivity =
  | 'idle' | 'uploading' | 'submitting-end' | 'synchronizing';
```

`TaxRegisterContext` describes an initialized context for one immutable `NumFiscal`. Do not construct a ready context with invented state or totals before initialization succeeds. `RegisterActivity` tracks work in progress separately **per context identity**, shared by all callers of that context, not as one service-wide flag. `'idle'` does not by itself mean synchronized or eligible to start a new offline session. `RegisterActivity` is the work-in-progress part of the lifecycle state defined in **Register lifecycle state machine**. Restart handling of in-progress work remains open (see **Failed or interrupted closing**).

`OfflineSessionContext` identifies the current session by its existing credentials and the original/begin documents. Its representation need not be an additional persisted record, but recovery must retain the association with the session being uploaded even after `context.working.offline` receives credentials for the next session.

### Source of truth

Three stored parts make up a context, and each value has exactly one source:

- `context.serverSnapshot` holds what the server last reported during a full synchronization or an applied refresh (see **Journal refresh points**). It is replaced as a whole, never field by field. Server-only fields such as `SubjectKeyId`, `LastFiscalNum`, and the offline durations are read from it and describe the moment of that synchronization, not the present.
- `context.documents`, the journal, is the evidence of every document saved since that snapshot.
- `context.working` holds only the offline credentials in force: the one value that changes between synchronizations and that no document carries.

The counters and shift flags are not stored. `deriveState(context)` computes them on every read from the journal entries' fields (`NumLocal`, `kind`, `OfflineSessionId`, `OfflineLocalNum`, `testing`), never by parsing document XML, and falls back to the snapshot when the journal holds no relevant document:

| Derived value | Rule |
| --- | --- |
| `nextLocalNum` | Last journal entry's `NumLocal + 1`; with an empty journal, `serverSnapshot.state.NextLocalNum`. |
| `offlineSessionOpen` | The latest `offline-begin` or `offline-end` entry in the journal is an `offline-begin`. With neither in the journal: `Number(serverSnapshot.state.OfflineNextLocalNum) > 1` (see transition T2 for that case at initialization; open: R31 in **Unresolved review findings**). |
| `offlineNextLocalNum` | Latest `offline-end`: `'1'`. Latest `offline-begin`: the last offline entry's `OfflineLocalNum + 1`. Neither: `serverSnapshot.state.OfflineNextLocalNum` (open: R32, for credentials replaced by a shift-opening receipt). |
| `shift` | A fold over the journal in order, starting from the snapshot's flags (`open: ShiftState === 1`, `zRepPresent: ZRepPresent`, `testing: Testing`). A `shift-open` entry sets `open: true`, `zRepPresent: false`, and `testing` to the entry's `testing`; a `report` entry sets `zRepPresent: true`; a `shift-close` entry sets `open: false`. Each entry changes only the flags it names, so a Z-report after a shift opening keeps that opening's `testing`. With no such entry, the result is the snapshot's flags. |

An `offline-end` entry proves its session closed because the end document is saved only after the server accepted it. The derivation is deliberately wrong in one window: when the end was accepted but its document was not saved (transition T17), the journal still shows the session open until full synchronization clears it. In that window the lifecycle state (`synchronizing`) decides what the context may do, not the derived values.

`context.working.offline` is set from the snapshot at initialization, at every full synchronization, and at every applied refresh: `{ sessionId: state.OfflineSessionId, seed: state.OfflineSeed }` when both are present and valid, otherwise `null`. Replace it only as a whole, never one value of the pair.

### When the offline credentials change

| Source | When | Effect |
| --- | --- | --- |
| `TransactionsRegistrarStateResponse` | Initialization, full synchronization, applied refresh | Becomes part of the snapshot; `working.offline` is set from it. |
| Receipt of a shift opening registered online (`OFFLINESESSIONID`, `OFFLINESEED`) | Between synchronizations | Replaces `working.offline` (see **Offline credentials from shift opening**). |
| Successful end-session response (`OfflineSessionId`, `OfflineSeed`) | When the end is accepted, before full synchronization | Replaces `working.offline` with the next session's credentials. |

Nothing else changes them. A shift closing never touches them, and neither does a shift opening created offline: one offline session may contain any number of shift closings and openings ("В межах офлайн сесії може бути відкрито і закрито необмежену кількість змін"), and every document of the session uses the same session ID and seed for its `ORDERTAXNUM` and control number. An online shift opening cannot happen while an offline session is open, because documents are then created offline, so the two replacement events never conflict.

The receipt and the end response arrive between synchronizations, so their credentials are kept in `working` rather than in the snapshot. The snapshot is never edited, and re-querying the state after each event is not a reliable substitute: the response's "Offline…" fields are null unless the request is signed by the shift opener, a senior user, or a manager.

**Seed for recovery requests.** While a session is uploaded or its end reconciled, `working.offline` is still that session's: neither replacement event can happen before its end succeeds, and a lost end response replaces nothing. Recovery state requests therefore always have the session's seed. After a successful end, `working.offline` holds the next session's credentials, and the completed session's credentials must not be sent again (see R08 in **Unresolved review findings**).

### Consistency check

On load and at the start of every recovery attempt, check the stored parts against each other:

- the journal's `NumLocal` values are consecutive, and the first is `serverSnapshot.state.NextLocalNum` (or the journal is empty);
- within each offline session in the journal, `OfflineLocalNum` values are consecutive from `'1'`;
- when `offlineSessionOpen` is true, the open session's `OfflineSessionId` equals `working.offline.sessionId`.

A failed check moves the context to `halted` with reason `inconsistent-local-state` (transition T24); the context does not repair or guess. The open-session check is skipped in `synchronizing`, where the window described above is expected.

The document model is a projection of the required journal data, not the complete check/report XML schema. `kind = 'report'` denotes a fiscal Z-report (`ZRep`), not an arbitrary local/display report; `kind = 'check'` includes applicable sale/return check subtypes. `Offline === false` means its offline session ID and document number are null. Every offline document has its session ID and assigned `OfflineLocalNum`; `OfflineBegin` has `'1'`. The post-save `deriveState(context).offlineNextLocalNum` is not the assigned number of the just-saved document: take the derived value before saving; after saving, the derived value is the next number. `testing` is filled from the document's `TESTING` element when the entry is saved, so no later rule needs to read the XML for it. The `REVOKELASTONLINEDOC` property and its XML element represent the same marker and must agree when sending. A `CHECK` XML wrapper alone does not make a shift-control document financially significant.

A storno check (`DOCTYPE` 0, `DOCSUBTYPE` 5, `ORDERSTORNUM` holding the fiscal number of the storned check) is a `'check'` and a financial document; it can be registered online or offline ("Сторнування попереднього чека"). Revision 578893 ("Сторнування останнього чека") allows storno when the customer refuses the last operation registered on the register (for currency-exchange operations, not necessarily the last one) or when a check with a wrong sum was registered; revision 523167 limited the customer-refusal case to currency-exchange operations. The server registers the storno with a zero storned amount. This flow removes the technical duplicate created when an offline session starts with `REVOKELASTONLINEDOC`, not with storno.

An end document can exist as an in-memory draft with assigned numbers while being sent. It is **not** in `context.documents`, so the derived counters do not move, until the successful response permits saving it. This model does not introduce a persisted pending-end document.

### State ownership and invariants

| Value | Meaning and permitted updates |
| --- | --- |
| `context.NumFiscal` | Immutable target-register identity. Used to scope requests, runtime activity, storage, and cleanup; never replaced by a state response. |
| `context.serverSnapshot` | Server state and totals from the last full synchronization or applied refresh, with the time they were received. Replaced as a whole only by those two transitions; never edited. |
| `serverShiftState: TransactionsRegistrarStateResponse` | Fresh response used to reconcile server progress. Reading it must not overwrite the snapshot or the working state, or clear the journal. |
| `deriveState(context).nextLocalNum` | Next global number available locally. Derived, never stored: saving a document moves it on; preparing an unsaved end does not. |
| `deriveState(context).offlineNextLocalNum` | Next number for the locally active or next offline session. Derived, never stored: saving an offline document moves it on; a saved `OfflineEnd` makes it `'1'`. |
| `context.working.offline` (`sessionId`, `seed`) | The offline credentials in force for the locally active or next offline session; the only stored value besides the snapshot and the journal. `null` means offline work is not possible. Set from the snapshot at initialization, full synchronization, and applied refresh; replaced by the receipt of a successful online shift opening and by a successful end-session response; always replaced as a whole and never fabricated (see **When the offline credentials change**). Handling of a shift-opening receipt without credentials is an open item. |
| `deriveState(context).shift` | Shift flags. Folded over the journal's shift-opening, Z-report, and shift-closing entries, starting from the snapshot's flags. |
| `serverShiftState.NextLocalNum` | Next global number expected by the server, not a local allocation counter. |
| `serverShiftState.OfflineNextLocalNum` | Server upload position for the session queried. It can be `'1'` while the local session is already open with documents saved. |
| `context.serverSnapshot.totals` | Unmodified server baseline until full sync; working totals are calculated from this baseline plus applicable journal documents (see **The totals fold**). |
| `context.documents` | Saved journal, including the uncertain original and recreated operation; cleared only by a completed full sync or an applied refresh (see **Journal refresh points**). |

This offline-flow contract specifies changes to the journal, the snapshot, and `context.working.offline`; everything else is derived. All other server fields, including `FirstLocalNum`, `UID`, and `Timestamp`, are read from `context.serverSnapshot.state` and describe the last synchronization, not the latest local change.

`deriveState(context).offlineSessionOpen` indicates an open local offline sequence. `serverShiftState.OfflineNextLocalNum === '1'` alone does **not** prove that the local session is complete: it can mean no package has reached the server yet. Completion requires session reconciliation (see **Session reconciliation**), not a test of `serverShiftState.ShiftState` or the offline counter alone.

## Initial state and full synchronization

The initial context is `context = { NumFiscal: registerNumFiscal, serverSnapshot: { state: serverShiftState, totals: serverLastShiftTotals, receivedAt }, working: { offline: <set from that snapshot> }, documents: [] }`, using independently obtained `TransactionsRegistrarStateResponse` and `LastShiftTotals` responses requested with `NumFiscal = registerNumFiscal`. Initialize each register's context independently. After receiving these values, that register can operate offline if the offline-readiness conditions above are satisfied. Later shift openings refresh its session credentials as described in **Offline credentials from shift opening**.

If `LastShiftTotals` returns HTTP 204 (no shift data, for example a register that has never opened a shift), initialize with `serverSnapshot.totals = null`. The same applies to a closed shift whose response has no `Totals`. No baseline is needed in either case: there is no current shift, and the totals of the next shift start from zero at its shift-opening document (see **The totals fold**). Nothing is fabricated. An HTTP 204 from the state query itself still prevents initialization (see **Absent state/totals**).

An existing unfinished offline session blocks full synchronization that would replace that context's local state and clear its documents; other registers' contexts are unaffected. Requesting server state for recovery is still allowed: reading that state is distinct from replacing the local working state.

Clear `context.documents` only when full synchronization completes: session reconciliation confirms the register has returned to online operation, local-number validation succeeds, and both `serverShiftState: TransactionsRegistrarStateResponse` and `serverLastShiftTotals: LastShiftTotals` have been received (an HTTP 204 for `LastShiftTotals` counts as received and gives `totals = null`, as at initialization). Then replace `context.serverSnapshot` with these server values, set `context.working.offline` from the new snapshot, and set `context.documents = []` as one logical completed transition. Do not partially replace the totals baseline and leave the old contributing journal to be counted again. A `TransactionsRegistrarStateResponse` response alone, or an `OfflineSessionState` response alone, is insufficient for this cleanup.

"Online" in this description means reconciled completion of the offline session, not `TransactionsRegistrarStateResponse.ShiftState === 0` or `1`. For an ordinary confirmed end, validate `serverShiftState.NextLocalNum === deriveState(context).nextLocalNum`. The lost-response and rollback cases still require the explicit decisions listed below; do not substitute this ordinary equality check for those decisions.

### Journal refresh points

Full synchronization after an offline session is not the only point at which the journal may be cleared. A register that works online for a long time would otherwise keep every document since its last offline session. To keep the journal bounded, a context performs a refresh at these refresh points:

- after a shift closing is registered online;
- after a Z-report is registered online.

A refresh re-fetches the baseline and trims the journal:

1. The context must be in state `online`. A refresh never runs in any other state: not while a document's outcome is unconfirmed, an offline session is open, or any closing or synchronization activity is in progress.
2. Request `TransactionsRegistrarState` and `LastShiftTotals` for `context.NumFiscal`. New operations are not blocked while the requests run.
3. Apply the result only if all of these hold:
   - `serverShiftState.NextLocalNum === deriveState(context).nextLocalNum`, so the server has every journaled document;
   - no document was saved since the requests were sent (`deriveState(context).nextLocalNum` is unchanged);
   - the new state does not lose offline credentials: if `context.working.offline` is not `null`, the response's `OfflineSessionId`, `OfflineSeed`, and `OfflineNextLocalNum` are all present.
4. If they hold, replace `context.serverSnapshot` with the new responses, set `context.working.offline` from the new snapshot, and set `context.documents = []` in one logical transition, exactly as in a full synchronization. Otherwise discard both responses and keep the journal unchanged; the next refresh point tries again.

A failed or discarded refresh is not an error for the operation that reached the refresh point; that document is already registered. Trimmed documents remain available from the server ("Запит чека", "Запит Z-звіту"); keeping a separate local archive is outside this flow.

## Operations during closing and synchronization

Block new operations on the target context whenever its `RegisterActivity` is `'uploading'`, `'submitting-end'`, or `'synchronizing'`. A new operation on that context must throw an error; it must not create a `TaxRegisterDocument` or allocate a number. This includes the synchronization stage after successful end-session submission. Operations on another context follow that other context's own state and activity; there is no service-wide busy rejection merely because one register is closing.

The error for a blocked operation is a local rejection. Return it directly; it must not trigger the API/key-error fallback or start another offline session. These restrictions apply to new operations, not the recovery requests and package sends that make up the active closing flow.

The point at which operations become available after a closing/synchronization attempt exits with an error remains to be defined; it appears as open transitions in **Register lifecycle state machine**.

## Register lifecycle state machine

Each context has exactly one lifecycle state. It is the single authority for which operations the context accepts and which background work it performs. All callers of a context observe the same state, and states of different contexts are independent. The rules in the other sections describe what happens inside each transition; this section defines when each transition may happen.

```ts
type RegisterLifecycleState =
  | { state: 'uninitialized' }
  | { state: 'online' }
  | { state: 'unconfirmed'; originalNumLocal: GlobalLocalNum }
  | { state: 'offline-open'; session: OfflineSessionContext }
  | { state: 'uploading'; session: OfflineSessionContext }
  | { state: 'submitting-end'; session: OfflineSessionContext; endDraftNumLocal: GlobalLocalNum }
  | { state: 'synchronizing' }
  | { state: 'halted'; reason: HaltReason; session: OfflineSessionContext | null };

type HaltReason =
  | 'package-validation-error'   // Tax validation error in a SendOflPackage response.
  | 'document-too-large'         // OfflineDocumentTooLargeError.
  | 'unresolved-server-state'    // Unexpected gap or server position during recovery.
  | 'inconsistent-local-state';  // The consistency check failed; session is null when none is open.
```

| State | Meaning | `RegisterActivity` | Offline indicator (`deriveState(context).offlineSessionOpen`) |
| --- | --- | --- | --- |
| `uninitialized` | No ready context; the state response and the totals response (or its HTTP 204) have not both been received. | `'idle'` | not evaluated |
| `online` | No open offline session; documents are registered online. | `'idle'` | false |
| `unconfirmed` | An online attempt failed with an API or key error, its outcome is unknown, and an offline session could not be started. | `'idle'` | false |
| `offline-open` | An offline session is open; documents are created offline. | `'idle'` | true |
| `uploading` | Recovery and ordinary package submission are running. | `'uploading'` | true |
| `submitting-end` | The unsaved `OfflineEnd` draft is being submitted or its outcome reconciled. | `'submitting-end'` | true |
| `synchronizing` | The session ended; full synchronization is pending. | `'synchronizing'` | false (`OfflineEnd` saved) or true (end accepted without a saved end document) |
| `halted` | Recovery stopped on an error that must not be retried automatically, or the stored parts are inconsistent. An open session stays unfinished. | `'idle'` | true for the recovery reasons; as derived for `inconsistent-local-state` |

### Operations allowed in each state

| State | New fiscal document (check, cash input/output, Z-report, shift opening/closing) | Totals calculation and reading stored state | Recovery requests and package sends |
| --- | --- | --- | --- |
| `uninitialized` | Rejected locally. | Not available. | Not applicable. |
| `online` | Registered online (see **Online result handling**). | Allowed. | Not applicable. |
| `unconfirmed` | Rejected locally. | Allowed. | Only the requests that resolve the outcome. |
| `offline-open` | Created offline (see **Continue an offline session**). | Allowed. | Started by the upload transition. |
| `uploading`, `submitting-end`, `synchronizing` | Rejected locally (see **Operations during closing and synchronization**). | Allowed. | Only the active closing flow. |
| `halted` | Open: see **Failed or interrupted closing**. | Allowed. | Only an explicitly started recovery attempt. |

A local rejection never triggers the API/key-error fallback and never starts an offline session. A context never leaves a state other than through a transition below.

### Transitions

| # | From | Event | Guard | Actions | To |
| --- | --- | --- | --- | --- | --- |
| T1 | `uninitialized` | `TransactionsRegistrarStateResponse` received, and `LastShiftTotals` received or HTTP 204 | The state does not show an unfinished offline session (that case is T2) | Build the context with `documents = []` (see **Initial state and full synchronization**). | `online` |
| T2 | `uninitialized` | The state query returns HTTP 204, or the state shows an unfinished offline session with no local documents | — | Open: see **Absent state/totals** and **Other server states**. | open |
| T3 | `online` | Document registered | — | Save the document; for a shift opening, store the receipt's credentials in `working.offline`. | `online` |
| T3a | `online` | Refresh point reached (shift closing or Z-report registered online) | — | Run the refresh (see **Journal refresh points**); apply it only when its conditions hold. New operations are not blocked. | `online` |
| T4 | `online` | Tax validation error | — | Return the error. | `online` |
| T5 | `online` | API or key error | Context is offline-eligible | Save the original, then save `OfflineBegin` and the recreated document together (see **Start an offline session**). | `offline-open` |
| T6 | `online` | API or key error | Context is not offline-eligible | Return the error; the original's outcome is unknown. Whether it is saved and whether its number is consumed: see **Validation rejection** and **Unconfirmed online outcome**. | `unconfirmed` |
| T7 | `unconfirmed` | Outcome of the original resolved | — | Open: see **Unconfirmed online outcome**. | `online` |
| T8 | `offline-open` | New document | — | Append it offline with the derived next numbers. | `offline-open` |
| T9 | `offline-open` | Upload started | Trigger: see **Upload trigger** | Set activity to `'uploading'`; request fresh server state with the session's credentials. | `uploading` |
| T10 | `uploading` | Fresh state confirms the session already ended and local-number validation passes | — | Do not resend the session. | `synchronizing` |
| T11 | `uploading` | All ordinary documents accepted, or none pending | — | Prepare the unsaved `OfflineEnd` draft. | `submitting-end` |
| T12 | `uploading` | API or key error, or uncertain result, in a state request or package send | — | Restart from the fresh server-state request. | `uploading`; leaving `uploading` instead is open (see **Failed or interrupted closing**) |
| T13 | `uploading` | Tax validation error in a package response | — | Return the error; no automatic restart. | `halted` (`package-validation-error`) |
| T14 | `uploading` | A single document does not fit the byte limit | — | Throw `OfflineDocumentTooLargeError`; send nothing further. | `halted` (`document-too-large`) |
| T15 | `uploading` | Unexpected gap or server position | — | Stop; do not skip documents. | `halted` (`unresolved-server-state`) |
| T16 | `submitting-end` | `{ kind: 'session-ended' }` | — | Save the end document and replace `working.offline` with the new credentials, in one commit. | `synchronizing` |
| T17 | `submitting-end` | Error or uncertain result; fresh state confirms completion and local-number validation passes | — | Do not save the end document. | `synchronizing` |
| T18 | `submitting-end` | Error or uncertain result; fresh state confirms the end was not accepted | — | Leave the end unsaved; resume from the server's next offline number. | `uploading` |
| T19 | `submitting-end` | Error or uncertain result; the state request also fails | — | Leave the end unsaved. | `submitting-end`; leaving it is open (see **Failed or interrupted closing**) |
| T20 | `submitting-end` | Tax validation error, or the end draft does not fit the byte limit | — | Return the error; leave the end unsaved. | `halted` (`package-validation-error` or `document-too-large`) |
| T21 | `synchronizing` | State and totals received and validation passes | — | Replace `serverSnapshot`, set `working.offline` from the new snapshot, and clear `documents` in one logical transition. | `online` |
| T22 | `synchronizing` | Either request fails | — | Retain everything. | `synchronizing`; leaving it is open (see **Failed or interrupted closing**) |
| T23 | `halted` | Explicitly started recovery attempt | Reason is not `inconsistent-local-state` | Request fresh server state and repeat all checks. | `uploading` |
| T24 | Any state except `uninitialized` | Context loaded, or a recovery attempt starts | The consistency check fails (see **Consistency check**) | Do not repair or guess; keep all stored parts unchanged. | `halted` (`inconsistent-local-state`) |

Events not listed for a state are rejected locally and do not change the state. A context halted with `inconsistent-local-state` is left only through operator remediation, which this document does not define (see R24 in **Unresolved review findings**). The lost end-response comparison (**Lost end-response validation**), closure rollback (**Closure rollback**), and device conflicts (**Device registration and conflicts**) are open; when decided, they are added as transitions here rather than as rules elsewhere.

## Numbering and terminology

Each register has a global sequence of local document numbers. Each offline session also has its own sequence, maintained in parallel.

| Term | Meaning |
| --- | --- |
| Global local number | `TaxRegisterDocument.NumLocal`: a document's position in the register's overall sequence, equal to XML `ORDERNUM`; also called `localNum`. |
| Offline document number | `TaxRegisterDocument.OfflineLocalNum`: its position within its own offline session. `OfflineBegin` has `'1'`. |
| Local next offline number | `deriveState(context).offlineNextLocalNum`: the next offline number to assign. After saving offline document `'1'`, this value is `'2'`. |
| Local next global number | `deriveState(context).nextLocalNum`: the next global number to assign to a locally created document. |
| Server next global number | `serverShiftState.NextLocalNum`: the next global number expected by the server. It may differ from the local value while documents are stored offline. |
| Server next offline number | `serverShiftState.OfflineNextLocalNum`: the next document to upload for the session supplied in `TransactionsRegistrarStateRequest`. |
| Original document | The document involved in the failed online attempt. |
| Recreated document | A new offline document representing the same financial or non-financial operation as the original. |
| Financial document | A check, cash input/output document, or fiscal Z-report (`ZRep`). Only financial documents are eligible for `REVOKELASTONLINEDOC`. |
| End-session document | The `endOfflineSession` / `OfflineEnd` document, sent as a separate final package containing only this document. |
| `OfflineSessionState` | Successful end-package response model. Replace `context.working.offline` with `{ sessionId, seed }` from the response. No counter is returned; the saved `OfflineEnd` makes the derived next offline number `'1'`. |

All documents follow the sequential global numbering. Documents within an offline session also follow sequential offline numbering. Adding an offline document advances both sequences for that session. After its end succeeds, the returned session ID and seed establish the next offline sequence starting at 1; the global sequence does not restart.

The indicator that an offline session is open locally is `deriveState(context).offlineSessionOpen`. Preparing or attempting to send an end-session document does not close the session locally. Save that document only after a successful end-session response from the server, and in the same commit replace `context.working.offline` with the returned session ID and seed. Saved documents keep the completed session's ID and assigned numbers; they do not become documents of the next session. An unfinished session must not permit a new offline session, and a closed session does not remove the requirement to block new operations during synchronization.

## Online result handling

Attempt to register the document with the tax API, then follow the applicable outcome:

| Outcome | Required flow |
| --- | --- |
| Successful registration | Save the document XML in `context.documents`; the derived next number moves on. For a shift-opening document, also store the receipt's offline credentials (see **Offline credentials from shift opening**). |
| HTTP 200 with a tax validation error in the response body | Return the tax validation error. Do not start an offline session or recreate the transaction as an offline document. |
| API or key error during the online flow | If the context is offline-eligible, start the offline-session flow described below; otherwise the context enters `unconfirmed` (transition T6 in **Register lifecycle state machine**). The original document may or may not have reached and been accepted by the server. |

HTTP 200 alone does not establish successful registration; the response body must be considered. The tax validation outcome is excluded from the API/key-error fallback path.

Whether a validation-rejected document is saved or consumes a global local number has not yet been specified.

### Offline credentials from shift opening

On every successful online registration of a shift-opening document (`OpenShift`, `DOCTYPE` 100), replace `context.working.offline` with the receipt's `OFFLINESESSIONID` and `OFFLINESEED` as `sessionId` and `seed`, in the same commit that saves the document. Preserve both values exactly as strings. The receipt carries no offline counter: the next offline number stays derived, and where it comes from after the credentials are replaced is part of the open item below.

- The rule applies to shift openings registered online. A shift-opening document created offline has no individual receipt; the credentials of its session are replaced by the end-session response (`OfflineSessionState`).
- Apply the update only to the originating context, like every other response.
- A receipt that lacks either credential, and the source of the derived next offline number after the receipt replaces the credentials, are open items under **Flow details still to define** (see also R32 in **Unresolved review findings**).

## Start an offline session

When an API or key error occurs during the online flow and the initialized context is eligible to work offline:

1. Save the original `TaxRegisterDocument` in `context.documents` with its original `NumLocal`, `Offline = false`, and null offline identity/number fields.
2. Prepare `OfflineBegin` (`kind = 'offline-begin'`) with the next `NumLocal`, `Offline = true`, the current `context.working.offline.sessionId`, and `OfflineLocalNum = '1'`.
3. Recreate the original operation as a new `TaxRegisterDocument` with `Offline = true`, the same session ID as `OfflineBegin`, the following `NumLocal`, and `OfflineLocalNum = '2'` (see **Building the recreated document**). Save `OfflineBegin` and this recreated document together, in that order; the derived counters then give the next available values.

The original document remains in the sequence. The recreated document is appended with new numbers; it does not overwrite the original or reuse its global local number.

### Building the recreated document

Recreating means building the same operation again as an offline document: the header values that identify and number the document in the journal are recomputed for its new position, and everything that describes the operation is kept. Build it from the same operation data with the normal document builder, using the numbers that follow `OfflineBegin`: global number `OfflineBegin.NumLocal + 1` and offline number `'2'`. `OfflineBegin` is not yet in the journal at this point, so these values are not read from `deriveState`. Never edit the original's XML text in place; the original stays in the journal unchanged.

| Part | Recreated document |
| --- | --- |
| Document body: every element after the header (`CHECKTOTAL`, `CHECKPAY`, `CHECKTAX`, `CHECKBODY`, or the Z-report body) | Unchanged. The amounts, payments, taxes, and items are those of the original operation. |
| `DOCTYPE`, `DOCSUBTYPE`, and references such as `ORDERRETNUM` or `ORDERSTORNUM` | Unchanged. |
| Seller and register identity: `TIN`, `IPN`, `ORGNM`, `POINTNM`, `POINTADDR`, `CASHDESKNUM`, `CASHREGISTERNUM`, `CASHIER` | Same values as the original. |
| `TESTING` | Same as the rest of its shift (see **Offline document construction**). |
| `UID` | New: the recreated document is a new document. |
| `ORDERDATE`, `ORDERTIME` | New: the time of recreation, from the same clock as every other document, never earlier than `OfflineBegin`. |
| `ORDERNUM` | New: `OfflineBegin.NumLocal + 1`, the global number after `OfflineBegin`. |
| `OFFLINE` | `true`. |
| `ORDERTAXNUM` | New: the offline fiscal number generated locally, `<OfflineSessionId>.<OfflineLocalNum>.<control number>`, with `OfflineLocalNum = '2'`. The control number uses the new date, time, and `ORDERNUM`, and the unchanged total sum. |
| `PREVDOCHASH` | Absent: as document `'2'` it starts the hash chain (see **Offline document construction**). |

The same rules apply when the original is non-financial, for example a shift opening, which has no body.

Starting offline is one logical flow transition. Saving the two new documents together avoids exposing a completed offline start with its recreated document missing, or calculating totals from that intermediate state. The flow should not produce an error merely because these two documents are being established together. Steps 1–3 give the order of the entries, not separate saves: persist the original, `OfflineBegin`, the recreated document, and the new lifecycle state in one `ContextStore.commit` (see **Core and its ports**), so that either all of them are stored or none is. Starting offline does not change `context.working.offline`: the session uses the credentials already in force.

Recreation applies to non-financial operations too. For example, recreate and submit a shift-opening document offline even when its original online version was accepted. The same applies to other non-financial documents. They do not affect shift totals and are not revoked.

For an original document numbered 10:

| Document saved, in order | `NumLocal` | `OfflineLocalNum` | `deriveState(context).nextLocalNum` after saving | `deriveState(context).offlineNextLocalNum` after saving |
| --- | ---: | ---: | ---: | ---: |
| Original document from the failed online attempt | 10 | `null` | 11 | Unchanged (`'1'` before offline start) |
| `OfflineBegin` | 11 | `'1'` | 12 | `'2'` |
| Same operation recreated with the offline flag | 12 | `'2'` | 13 | `'3'` |
| Next document created during the offline session | 13 | `'3'` | 14 | `'4'` |

These are logical sequence values. `OfflineBegin` 11 and recreated document 12 are saved together; the row for 11 explains numbering within the pair, not a separately exposed saved state. These values do not imply that the server has accepted any of the documents.

## Continue an offline session

While the session is open and no closing or synchronization operation is in progress, create subsequent `TaxRegisterDocument` entries with `Offline = true` and `OfflineSessionId = context.working.offline.sessionId`. Assign `NumLocal = deriveState(context).nextLocalNum` and `OfflineLocalNum = deriveState(context).offlineNextLocalNum`, and append to `context.documents`; both derived counters then move on. Compare/increment offline decimal strings numerically, not lexicographically.

Do not send these documents individually to the tax API. Later recovery and package submission form a separate flow, during which new register operations are blocked as described above.

## Offline document construction

Every document with `Offline = true` (`OfflineBegin`, the recreated document, each later document of the session, and the `OfflineEnd` draft) must follow the header rules below. They come from the API sections "Структура фіскального номера офлайн документа", "Розрахунок контрольного числа", "Розрахунок гешу офлайн документа", and "Тестові документи", and from [`check01.xsd`](official/schemas/check01.xsd) and [`zrep01.xsd`](official/schemas/zrep01.xsd).

1. **Offline flag.** Include `<OFFLINE>true</OFFLINE>`. Documents registered online carry no `OFFLINE`, `ORDERTAXNUM`, or `PREVDOCHASH`; the server assigns their fiscal number in the receipt.
2. **Offline fiscal number.** `ORDERTAXNUM` is `<OfflineSessionId>.<OfflineLocalNum>.<control number>`, for example `82563.25.6127`, using the document's own session ID and assigned offline number.
3. **Control number.** Join these values with `,` in this order:
   1. the session's `OfflineSeed`;
   2. `ORDERDATE` (`DDMMYYYY`) and `ORDERTIME` (`HHMMSS`), exactly as written in the document;
   3. `ORDERNUM` (the global local number);
   4. `CASHREGISTERNUM` (register fiscal number), then `CASHDESKNUM` (register local number);
   5. for a check that has a total, its total sum formatted `0.00`; omitted for documents without one (`OfflineBegin`, `OfflineEnd`, shift opening/closing, Z-report);
   6. `PREVDOCHASH`, only when the document contains it.

   Compute the standard CRC-32 (reflected polynomial `0xEDB88320`, initial value and final XOR `0xFFFFFFFF`; the DamienG implementation the API references) over the ASCII bytes of that string. Reverse the byte order of the 32-bit result and read it as an unsigned integer: this is the value the API's example calls the unsigned decimal CRC32. The control number is that value modulo 10000 (leading zeros dropped), or 1 if the result is 0. Official test vector: `179625192271939,20082020,142338,10,4000002411,10,cdd68bb111f8993f3603f0179341571b35b73a07d5acee9b28fbfb714698e1b3` has the standard CRC-32 `0xA6BDDBBD`; byte-reversed it is `0xBDDBBDA6` = 3185294758, so the control number is **4758**. Using the standard value without the byte reversal gives 413, which is wrong.
4. **Previous-document hash (`PREVDOCHASH`).**
   - Value: lowercase hexadecimal SHA-256 of the immediately preceding document of the same offline session, in journal order.
   - Input: the API prefers the signed block but permits the raw XML when signing is not possible ("дозволяється використовувати для розрахунку геша безпосередньо блок XML"). As an application decision, this flow always hashes the raw XML encoded as Windows-1251, because offline documents can be created while signing is unavailable. The document later signed and uploaded must therefore contain exactly those bytes as its signed content: never re-serialize, reformat, or re-encode a journaled document. The only permitted change is the `REVOKELASTONLINEDOC` marker on `OfflineBegin`, whose hash is never used.
   - Chain start: the hash chain starts at offline document `'2'`, whatever its kind, including a non-financial recreated document such as a shift opening. `OfflineBegin` (offline number `'1'`) can still be extended with `REVOKELASTONLINEDOC` before upload, so its hash is not stable and is never used. Therefore neither `OfflineBegin` nor document `'2'` carries `PREVDOCHASH`, and every later document (offline number `'3'` and above), including the `OfflineEnd` draft, carries the hash of its predecessor.
   - `OfflineEnd`: the API text says that "Початок офлайн сесії" and "Завершення офлайн сесії" take no part in the hash sequence, but its control-number example is an `OfflineEnd` (`DOCTYPE` 103) that carries `PREVDOCHASH`. Follow the example. The hash of `OfflineEnd` itself is never used.
5. **Test documents.** Never put `TESTING` on `OfflineBegin` or `OfflineEnd`, even in a test shift ("Елемент «TESTING» не дозволяється для документів «Початок офлайн сесії» і «Завершення офлайн сесії»"). A shift holds only fiscal or only test documents, so every other document created offline, including the recreated one, carries the same `TESTING` value as the rest of its shift.
6. **Signature timestamp.** The KEP signature of an offline document needs no qualified timestamp ("Позначка часу не обов’язкова для КЕП документів, створених в режимі офлайн").
7. **Element order.** `CHECKHEAD` and `ZREPHEAD` are `xs:sequence` types. Their trailing elements are `VER, ORDERTAXNUM, OFFLINE, PREVDOCHASH, REVOKED, STORNED, TESTING` (check) and `VER, ORDERTAXNUM, OFFLINE, PREVDOCHASH, REVOKED, TESTING` (Z-report). Emit elements in schema order.

## Begin ending the session: reconcile the original attempt

Request `serverShiftState: TransactionsRegistrarStateResponse` with `TransactionsRegistrarStateRequest`, supplying `NumFiscal = context.NumFiscal` and the `OfflineSessionId` and `OfflineSeed` of that context's current `OfflineSessionContext`. The revocation decision is scoped to that register and session. Evaluate adding the marker only when `serverShiftState.OfflineNextLocalNum === '1'`, meaning it has not yet accepted documents from this offline session. Within that condition, compare `serverShiftState.NextLocalNum` with the current session's `OfflineBegin.NumLocal`.

`REVOKELASTONLINEDOC` may revoke only a financial document: a check, cash input/output document, or report. The eligible target is the original financial document immediately before `OfflineBegin`; the marker itself is placed on `OfflineBegin`. Shift-opening, shift-closing, and offline-session control documents are not financial documents for this rule.

A non-financial original is a normal skip condition, not an error. Leave the revocation marker absent and continue session recovery and package submission, including its recreated offline counterpart even if the original was accepted. Revocation is needed to keep financial shift totals consistent; non-financial documents do not affect those totals.

For the current session with `serverShiftState.OfflineNextLocalNum === '1'`, combine the original attempt's acceptance status with its `TaxRegisterDocument.kind`:

| Scenario | Example using original 10 and `OfflineBegin` 11 | Action in this reconciliation step |
| --- | --- | --- |
| The server accepted the original financial document, but the online flow reported an error | `serverShiftState.NextLocalNum === 11`, equal to `OfflineBegin.NumLocal` | Set `OfflineBegin.REVOKELASTONLINEDOC = true`, represented as `<REVOKELASTONLINEDOC>true</REVOKELASTONLINEDOC>` in its XML. |
| The original document is not financial | Even if `serverShiftState.NextLocalNum === 11` | Skip adding the marker without an error; still send the recreated non-financial document. |
| The server did not accept the original document | Server still expects 10, assuming no other server-side progress | Do nothing in this step. Do not add the revocation marker. |

Add `REVOKELASTONLINEDOC` only when all three conditions hold for the current offline session: the original document is financial, `serverShiftState.OfflineNextLocalNum === '1'`, and `serverShiftState.NextLocalNum === OfflineBegin.NumLocal`. The marker is added to that session's existing `OfflineBegin` document; this decision does not append a document or renumber the sequence.

**Marker placement in the XML.** `CHECKHEAD` in [`check01.xsd`](official/schemas/check01.xsd) is an `xs:sequence`, so element order is validated. `REVOKELASTONLINEDOC` is declared after `VEHICLERN` and before `CASHIER`. An `OfflineBegin` header has none of the optional elements between `CASHREGISTERNUM` and that position (`ORDERRETCASHREGNUM`, `ORDERRETDATE`, `ORDERRETNUM`, `ORDERSTORNUM`, `OPERTYPENM`, `VEHICLERN`), so the element goes immediately after `</CASHREGISTERNUM>`, as in the official example [`check01(Початок офлайн сесії).xml`](<official/examples/check01(Початок офлайн сесії).xml>). Remove any existing `REVOKELASTONLINEDOC` element, then insert `<REVOKELASTONLINEDOC>true</REVOKELASTONLINEDOC>` at that position.

- Never append the marker at the end of `CHECKHEAD`, and never add it to any document other than the current session's `OfflineBegin`.
- The marker changes the `OfflineBegin` XML, so the signed `OfflineBegin` in a package must be produced from the marked XML. This is safe: `OfflineBegin` takes no part in the hash chain, and the control number of the next document excludes the previous hash because the API expects this change ("попередній документ («Початок офлайн сесії») може бути змінений (може бути додано елемент «REVOKELASTONLINEDOC»)").

The comparison uses the server's **next global local number**. It does not use the last accepted number, the local next global number, or an offline document number.

"Do nothing" when the original was not accepted applies to the revocation decision. It does not declare the offline session complete or cancel later recovery. Do not retry the original document merely as part of this decision.

Once the server's next offline number advances beyond 1, skip marker addition and resume submission from that number. Preserve a marker already recorded for this session; later upload progress is not a reason to remove or recalculate it. Do not apply the decision to an earlier offline session. A failed attempt that leaves the server's next offline number at 1 remains eligible for the same check.

## Working totals

### Who uses the working totals

Working totals are the current shift's `ShiftTotals` as the register knows them locally. They are used for display and as the source figures of a Z-report the register creates itself. While offline this is the only source: the API lets the register create the Z-report on its own ("ПРРО (самостійно або на основі проекту, отриманого від Фіскального Сервера) створює XML документ Z-звіту"), and an offline session may contain Z-reports. A Z-report needs exact figures, so every field the fold produces must be exact. A field the fold cannot compute makes an offline Z-report impossible; it must not be filled with an estimate.

### Money arithmetic

All amounts are exact decimals with two fractional digits: the XML values (`DGDecimal2`, for example `CHECKTOTAL/SUM`) and the `decimal` members of `ShiftTotals`. Rules:

- Hold every amount as an integer number of hundredths (kopecks for money): parse `"1000.71"` as `100071`. Percentages such as `ShiftTotalsTax.Prc` are held as hundredths too.
- Parse amounts from their decimal text, never through binary floating point. This includes `LastShiftTotals` JSON: decode its numeric values without converting them to a floating-point number first.
- Add and compare only integers. Format back to two-digit text (`0.00`) only at the boundary: XML, display, or a control-number string.
- A value with more than two fractional digits, or one that is not a decimal number, is malformed. Reject it; do not round it silently.

### The totals fold

```ts
// Pure function: the same inputs always give the same result, and the inputs are never modified.
declare function computeWorkingTotals(
  baseline: LastShiftTotals | null,          // context.serverSnapshot.totals
  documents: readonly TaxRegisterDocument[], // context.documents, ordered by NumLocal
): ShiftTotals;
```

Compute the result in these steps:

1. **Shift boundary.** Find the latest shift-opening document (`kind = 'shift-open'`) in `documents`, whether registered online or created offline. If there is one, start from empty totals (all amounts 0, all counts 0, no payment-form or tax rows) and process only the documents after it; the baseline and all earlier documents belong to earlier shifts. If there is none and the baseline's shift is open (`ShiftState === 1`), start from `baseline.Totals` and process all documents. If there is none and the baseline is `null` or its shift is closed, there is no current shift: the result is empty totals. A baseline whose shift is open but which has no `Totals` is not defined (see **Absent state/totals**).
2. **Predecessor exclusion.** Skip the original financial document immediately before each `OfflineBegin` (see **Predecessor exclusion** below).
3. **Contributions.** Add each remaining document's contribution, in `NumLocal` order, according to the table below.

| Document | Contribution |
| --- | --- |
| Sale check: `kind = 'check'`, `DOCSUBTYPE` absent or 0 | To `Real`, as described in the check contribution rules below. |
| Return check: `kind = 'check'`, `DOCSUBTYPE` 1 | To `Ret`, as described in the check contribution rules below. |
| Cash input: `kind = 'cash-input'`, `DOCSUBTYPE` 2 or 3 | `ServiceInput += CHECKTOTAL/SUM` ("Службове внесення/Отримання авансу/Отримання підкріплення"). |
| Cash output: `kind = 'cash-output'`, `DOCSUBTYPE` 4 | `ServiceOutput += CHECKTOTAL/SUM` ("Службова видача/Інкасація"). |
| Z-report, shift closing, `OfflineBegin`, `OfflineEnd` | No amounts. |
| Storno check (`DOCSUBTYPE` 5); transfer, currency-exchange, cash-withdrawal, and pawnshop checks (`DOCTYPE` 1–4) | Not defined in this flow (see **Totals for other document types**). The fold reports these totals as unsupported instead of leaving the document out. |

**Check contribution** to the target `ShiftTotalsOrderType` (`Real` or `Ret`):

- `Sum += CHECKTOTAL/SUM`, `RndSum += RNDSUM`, `NoRndSum += NORNDSUM`, `PwnSumIssued += PWNSUMISSUED`, `PwnSumReceived += PWNSUMRECEIVED`, each when present, and `OrdersCount += 1`.
- `PayForm`: one row per `PAYFORMCD`; add each `CHECKPAY` row's `SUM` to the row with the same `PayFormCode`, taking `PayFormName` from `PAYFORMNM`.
- `Tax`: one row per combination of `TYPE`, `LETTER`, `PRC`, and `SIGN`; add `TURNOVER`, `TURNOVERDISCOUNT`, `SOURCESUM`, and `SUM` from each `CHECKTAX` row, taking `Name` from `NAME`.
- Fields that checks of these kinds do not carry (`TotalCurrencySum`, `TotalCurrencyCommission`, `TotalCurrencyCost`, and the counters of pawnshop checks) keep their starting value.

The grouping keys for `PayForm` and `Tax` are an application decision. Verify them against the server: after a full synchronization, the server's `LastShiftTotals.Totals` for a shift must equal the fold over that shift's documents.

### Predecessor exclusion

When processing the journal, skip the original financial document immediately before each `OfflineBegin` document. Process the recreated offline financial document according to its normal totals rules so that the original and recreated documents do not contribute twice for the same transaction. Do not mutate the server baseline on each calculation or add each document again to an already-derived result.

This exclusion applies when `OfflineBegin` and the recreated document have been saved together. It does not depend on the revocation marker already being added or the server's acceptance status already being known. If the server accepted the original, the reconciliation flow marks it for revocation; if it did not, that original was not registered. In both cases, local totals must exclude the original and use the recreated offline document.

For example, a sale of 100 appears as original document 10, followed by `OfflineBegin` 11 and recreated offline sale 12. The local contribution from this sequence is one sale of 100. Exclude document 10 from totals even before the server-state check; retain it in the document sequence with its number unchanged.

The exclusion is limited to the original financial document immediately preceding `OfflineBegin`. It does not skip earlier unrelated financial documents or non-financial control documents.

## Submit offline packages

Keep new operations on the target context blocked throughout its active upload and synchronization flow; reject such operations with an error. Other contexts remain independently operable.

1. Set this context's activity to `'uploading'`. Request fresh `serverShiftState: TransactionsRegistrarStateResponse` using `NumFiscal = context.NumFiscal` and its current `OfflineSessionContext` credentials. If this request fails, package submission cannot proceed from a fresh server position; retry handling starts with this request again for the same context.
2. Check whether the current session has already ended on the server. If session reconciliation and local-number validation confirm completion, proceed to full synchronization instead of resending the session. Neither `serverShiftState.ShiftState` nor an offline counter of `'1'` alone establishes this.
3. Otherwise, evaluate the current session's revocation decision only if `serverShiftState.OfflineNextLocalNum === '1'`. A non-financial original is skipped without an error; its recreated document remains in the sequence for upload.
4. Read `serverShiftState.OfflineNextLocalNum`. Select `context.documents` with `Offline = true` and the current session's `OfflineSessionId`, starting inclusively at the document whose `OfflineLocalNum` equals that counter. Exclude the original online document and documents of other sessions. An unexpected gap or server position is an unresolved recovery case, not permission to skip documents.
5. Build ordinary packages using the exact sizing and ordered packing rules below. Each package contains at most `packageDocumentLimit` documents (50 by default, never more than the API maximum of 100) and its complete uncompressed request body is at most `MAX_OFFLINE_REQUEST_BYTES` (200,000) bytes. Keep `OfflineEnd` separate.
6. Send the checked `PreparedOfflinePackage` commands one at a time, as described in **Package transport: the `SendOflPackage` command**. Each must produce a successful `OfflinePackageResult` of kind `'accepted'` before the next ordinary package is sent. An HTTP status alone is not the acknowledgement.
7. After all preceding offline documents have been accepted, prepare the unsaved `OfflineEnd` draft with the current session's ID and the next local global/offline numbers. Set activity to `'submitting-end'` and send it in its own final package, applying the same byte-size check. This package contains exactly one document, even when the preceding package has unused count or byte capacity. Only a successful `'session-ended'` result provides the `OfflineSessionState` needed by the next step.

For example, with the default limit, 101 pending documents before the end-session document are sent as packages of 50, 50, and 1, then the end document alone, if the byte-size limit permits those packages; 51 documents are sent as 50 and 1. With a configured limit of 100, the same 101 documents are sent as 100 and 1. The byte limit can end a package earlier than the count limit.

If the server's next offline number shows that all preceding documents are already accepted, there are no ordinary packages to resend. Send only the end-session document in its separate package.

If an API/key error interrupts package submission, restart the send process from the server-state request. Rebuild the remaining packages from the server's newly reported next offline number. Restarting the process does not mean blindly resending previously accepted documents.

If a package response reports a tax validation error, in any of the error forms listed under **Package transport: the `SendOflPackage` command**, return that error. Do not automatically restart submission for that validation error or start another offline session.

### Package transport: the `SendOflPackage` command

Every offline package, including the final end-only package, is sent with the API command "Запит надсилання пакета офлайн документів" (`SendOflPackage`). The binary `/pck` package format is not used.

To prepare one command:

1. Take the package's documents in `NumLocal` order, each as its final XML (Windows-1251, including any `REVOKELASTONLINEDOC` change). Sign each document separately with KEP, as the API requires for every document in a package.
2. Put the Base64 encoding of each signed document in `Documents`, one array element per document. Set `Command: 'SendOflPackage'` and a new unique `UID`. Add no other fields; in particular, no `NumFiscal`.
3. Serialize the JSON to UTF-8 and sign it with the user's KEP. The API requires `SendOflPackage` to be "JSON, засвідчений КЕП користувача", and the whole package to be signed by the sender. These signed bytes are `PreparedOfflinePackage.uncompressedBody`.
4. POST the signed bytes to the command endpoint `<address>/cmd` (see "Адреси Фіскального Сервера") with `Content-Type: application/octet-stream`. Optional `Content-Encoding: gzip` or `deflate` does not change the size check. Any intermediary transport must deliver exactly these signed bytes to the Fiscal Server.

Normalize the response as follows:

| Response | Result |
| --- | --- |
| Successful status with the plain-text body `"OK"` (after trimming whitespace), for a package without `OfflineEnd` | `{ kind: 'accepted' }` |
| Successful status with JSON containing `OfflineSessionId` and `OfflineSeed` (and, if present, a `UID` equal to the request's), for the package with `OfflineEnd` | `{ kind: 'session-ended', state }` |
| `"OK"` for the package with `OfflineEnd`, or credentials for a package without it | Not an acknowledgement: the response does not match the package sent. Handle as an uncertain result and reconcile through a fresh state request. |
| Server-reported error: HTTP 200 with `ErrorCode`/`ErrorMessage` (`resultAsJson=true`), or a non-2xx status with the text `Код помилки: <code> <name>\r\n<description>` | Not an acknowledgement. `ErrorCode` 9 (`DocumentValidationError`) and 10 (`PackageValidationError`) are tax validation errors; the classification of other codes is the open item on error classification. |
| No response, timeout, or HTTP 5xx | Outcome uncertain: handle as an API error and restart from the server-state request. |

Because `"OK"` carries no `UID`, an acknowledgement is matched to its package by the rule that a context has at most one package request in flight: a response belongs to the single outstanding request of that context. A JSON response whose `UID` is present and differs from the request's `UID` is not an acknowledgement, and its credentials must not be used. An end-package response without both credentials is handled as described under **Totals and package responses**.

### Exact byte-counting

The API's "Обмеження" section states `200 Kb` and checks original data size when compression is used. It does not define a precise byte constant or an explicit signing-stage boundary. This feature therefore adopts **200,000 bytes of the signed `SendOflPackage` command (the uncompressed `/cmd` request body)** as a conservative client-side limit. This is an application decision, not a claim that the server's exact threshold is 200,000 rather than 204,800 bytes. The 100-document maximum comes from "Пакет офлайн документів". The default package size of 50 documents (`DEFAULT_OFFLINE_PACKAGE_DOCUMENTS`) is an application decision below that maximum; a configured `packageDocumentLimit` may be between 1 and 100.

For every candidate package:

1. Use the final document content, including any permitted `REVOKELASTONLINEDOC` change, valid hash-chain fields, and required document signatures. Use the actual document encoding required by the API (XML text is Windows-1251); never measure JavaScript XML string length as a substitute for encoded bytes.
2. Base64-encode each signed document, serialize the complete `SendOflPackage` JSON with its actual `UID` to UTF-8, and sign it, as described in **Package transport: the `SendOflPackage` command**. Do not estimate only the sum of raw XML sizes.
3. Materialize the signed command as `uncompressedBody: Uint8Array` before optional HTTP `gzip`/`deflate`. Its exact measured size is `uncompressedBody.byteLength`, including Base64 expansion, JSON punctuation/escaping, certificates, signatures, and any timestamp data actually present. Count the byte view, not the capacity of its underlying buffer. HTTP headers, HTTP transfer framing, TLS overhead, wrapping added by an intermediary transport, and compressed length are not part of this measurement.
4. A non-empty package is size-valid only if `documentNumLocals.length <= packageDocumentLimit` and `uncompressedBody.byteLength <= 200_000`. Exactly 200,000 bytes is allowed; 200,001 is not. Compression cannot make an oversized uncompressed body acceptable.
5. Retain the verified bytes and send those exact bytes, or their compressed representation. Do not reserialize, change a UID/timestamp, modify XML, or re-sign after measuring without preparing and measuring the replacement body again. Treat a prepared body's contents as immutable, even though TypeScript's `readonly` property does not itself freeze a `Uint8Array`.

Serialization estimates may help select candidates, but cannot authorize sending. The final signed body must pass the exact check. Package construction must preserve each journaled document's XML bytes, which the hash chain uses (see **Offline document construction**); changing package boundaries alone must not re-create business documents or change their numbers. A signing failure is not an `OfflineDocumentTooLargeError` because no final size has been established.

### Ordered packing and a single oversized document

Starting at the server's inclusive next offline number, build each ordinary package from a contiguous prefix of the remaining documents in their existing order:

1. Prepare and measure a candidate containing the next document alone. If it exceeds the byte limit, apply the single-document error handling below.
2. While fewer than `packageDocumentLimit` documents are selected, try appending the next ordinary document and prepare/measure that complete candidate. If it fits, retain it as the latest verified package and continue. If it exceeds the limit, keep the previous fitting package; the extra document remains first in the next package. Never skip it to try a smaller later document.
3. When adding the next document would exceed a limit, or no ordinary documents remain, submit the last verified non-empty package. Wait for its successful acknowledgement before sending the next one. A multi-document candidate exceeding the byte limit is a packing boundary, not itself a document error.
4. Apply the same complete-body measurement to the final singleton `OfflineEnd` package, without combining it with ordinary documents.

If the complete request containing **one document alone** exceeds 200,000 bytes, throw `OfflineDocumentTooLargeError` with the originating register/session identity, that document's global/offline numbers, the actual complete-body size, and the limit. This rule applies equally to `OfflineBegin`, financial/non-financial documents, and the unsaved `OfflineEnd` draft.

- Do not send that request, the offending document, any later document, or the end package after the failure. Do not split an individual fiscal document, truncate its XML, renumber it, remove signatures, or switch transport automatically to evade the error.
- Return the local error to the caller. Do not treat it as a tax-server/API/key failure, start a new offline session, or automatically restart recovery with the same oversized request. A later explicitly initiated recovery attempt still begins with fresh server state and repeats the size checks.
- Retain the journal and totals baseline. Size checking/error handling itself does not save documents, allocate numbers, replace session credentials, or clear the journal. A permitted revocation marker already applied before sizing is not undone. An oversized end remains unsaved and the session remains unfinished.
- If earlier packages in this attempt were already accepted, preserve that fact; no rollback is implied. Stop at the oversized document. On a later recovery attempt use the server's reported next offline number, not a locally invented restart position.
- Affect only the originating context. Other registers remain independently operable. The existing open decision on releasing the failed context's busy guard is unchanged; this error does not authorize a new session or full-sync cleanup.

The error is specifically for uploadability of an existing document or end draft. It does not introduce an unagreed rule for rejecting or consuming numbers during initial business-document creation. Operator remediation of an already journaled oversized fiscal document remains outside this automatic flow; the service must not silently edit it.

## End-session document and uncertain results

Save the end-session document locally only after a successful server response to its submission. Do not save it before sending, after a failed attempt, after a validation error, or while the outcome is uncertain. The offline session must remain open locally until successful submission or server-state reconciliation confirms completion.

| Outcome | Required handling |
| --- | --- |
| Successful result is `{ kind: 'session-ended', state: endState }`, where `endState: OfflineSessionState` | Append the end document to `context.documents` and, in the same commit, replace `context.working.offline` with `{ sessionId: endState.OfflineSessionId, seed: endState.OfflineSeed }`; the derived next offline number becomes `'1'`. Set activity to `'synchronizing'`; clear documents only after full synchronization. |
| Submission reports an error, but a fresh `serverShiftState: TransactionsRegistrarStateResponse` confirms completed session reconciliation and local-number validation passes | Treat the end as accepted and proceed to full synchronization without adding the end document to `context.documents`. Clear documents only after both `TransactionsRegistrarStateResponse` and `LastShiftTotals` have been received. |
| A fresh server-state check confirms the end document was not accepted | Leave the end document unsaved. The current session must be sent before a new offline session can start. Resume submission using fresh server state and the next expected offline number. |
| The submission result is uncertain and the server-state request also fails | Leave the end document unsaved. Acceptance is unresolved, so full synchronization and document clearing cannot complete. The next recovery attempt starts with a fresh server-state request. |

Receiving `endState: OfflineSessionState` changes only the stored session credentials, together with saving the accepted end. It does not supply a complete `TransactionsRegistrarStateResponse` or `LastShiftTotals`, clear documents, or permit new operations during synchronization. Because the saved `OfflineEnd` is the latest session-control entry, the derived next offline number is `'1'` and is never recomputed from the completed session's documents. Failed or uncertain end attempts append no end document, so the derived numbers do not move.

### Edge-case comment: lost end-session response

The completion rule requires the server to be online and local numbers to agree. Because the end document remains unsaved if its successful response is not received, the comparison for recovery after a lost response still needs defining.

For example, an unsaved end draft has `NumLocal = 20`. Receiving `endState: OfflineSessionState` allows it to be saved, after which `deriveState(context).nextLocalNum` is 21. If that response is lost, the end remains unsaved and `deriveState(context).nextLocalNum` remains 20, even though `serverShiftState.NextLocalNum` may have advanced to 21. If the server did not accept it, both may still expect 20.

> Edge-case comment: when the server accepted the end but its successful response was lost, the server can be one global number ahead of the local journal. A simple equality check can therefore miss successful closure. The precise recovery comparison is intentionally left unresolved; this comment does not approve a new comparison rule or permit saving the end without a successful response.

## Core and its ports

The flow is implemented as a core plus a small set of ports. The core contains every decision in this document: the lifecycle state machine, numbering, offline document construction, the revocation decision, package selection and packing, response normalization, reconciliation, and the totals fold. Given the same inputs, it makes the same decisions. All input and output go through the ports below, so the core can be tested with fakes and has no direct access to the network, the signer, the clock, or storage. Every port call carries the target `NumFiscal`; no port holds a "current register".

```ts
// Raw transport. Interpreting the response (receipt, "OK", JSON, error forms) is the core's job.
interface FiscalServerPort {
  sendDocument(numFiscal: string, signedDocument: Uint8Array): Promise<FiscalExchange>;   // <address>/doc
  sendCommand(numFiscal: string, signedCommand: Uint8Array): Promise<FiscalExchange>;     // <address>/cmd
}

type FiscalExchange =
  | { kind: 'response'; httpStatus: number; contentType: string | null; body: Uint8Array }
  | { kind: 'no-response'; reason: 'timeout' | 'network' };     // Outcome unknown.

// KEP signing. The core chooses the key; the port only signs with the key it is given.
interface SignerPort {
  availableKeys(numFiscal: string): Promise<readonly SignerKey[]>;
  sign(key: SignerKey, content: Uint8Array): Promise<Uint8Array>; // Signed message with eContent; throws SigningFailure.
}

interface SignerKey {
  readonly subjectKeyId: string;     // Compared with the shift opener's key.
  readonly role: 'cashier' | 'senior-cashier' | 'manager';
}

interface SigningFailure extends Error {
  readonly transient: boolean;       // true: signer temporarily unavailable; false: key unusable (expired, revoked, wrong password).
}

// Time used for ORDERDATE/ORDERTIME and for offline durations.
interface ClockPort {
  documentTime(numFiscal: string): { ORDERDATE: string; ORDERTIME: string }; // DDMMYYYY, HHMMSS, estimated server time.
  monotonicMs(): number;             // For timeouts and intervals; never jumps backwards.
}

// Persistence of one context, written as a unit and owned by one writer at a time.
interface ContextStore {
  load(numFiscal: string): Promise<StoredContext | null>;
  commit(numFiscal: string, expectedVersion: number, next: StoredContext): Promise<'committed' | 'version-conflict'>;
  withExclusiveLock<T>(numFiscal: string, work: () => Promise<T>): Promise<T>; // Across tabs and processes on this device.
}

interface StoredContext {
  readonly version: number;
  readonly context: TaxRegisterContext;
  readonly lifecycle: RegisterLifecycleState;
}

// Reachability check that registers nothing (for example "Запит стану сервера").
interface ConnectivityProbe {
  probe(numFiscal: string): Promise<'reachable' | 'unreachable'>;
}

// Stable identifier of this device for DeviceRegister.
interface DeviceIdProvider {
  deviceId(): Promise<string>;       // 64 characters, unchanged for the life of this installation.
}
```

What each port guarantees and which rules use it:

| Port | Guarantees | Used by |
| --- | --- | --- |
| `FiscalServerPort` | Sends the given bytes unchanged and returns the raw exchange. It never retries, normalizes, or reinterprets a response, and it reports a missing response as `no-response`, not as an error code. | **Online result handling**, **Package transport: the `SendOflPackage` command**, state and totals requests, `DeviceRegister`. |
| `SignerPort` | Signs exactly the given bytes with the given key and reports whether a failure is transient. | Document and command signing; the same-operator check uses `subjectKeyId`. Key selection is a core rule: sign with the shift opener's key; when the server refuses a package because of the certificate, the API expects the package to be signed by a senior user or manager. Which responses count as such a refusal is open (see **Signer key selection**). |
| `ClockPort` | Returns the time written into new documents; the core ensures that a new document's time is not earlier than the previous document's. | **Offline document construction**, **Building the recreated document**, offline durations. |
| `ContextStore` | `commit` writes the snapshot, working state, journal, and lifecycle state together or not at all; a stale `expectedVersion` is rejected. `withExclusiveLock` admits one writer per `NumFiscal` across all tabs and processes of the device. | Every "one logical transition" in this document; **Context-scoped multi-register service**. |
| `ConnectivityProbe` | Reports reachability without registering anything. | **Upload trigger**. |
| `DeviceIdProvider` | Returns the same 64-character value on every call for one installation. | **Single-device use and device registration**. |

The interface names and shapes are a contract for structure; an implementation may split or merge them as long as each guarantee holds and the core stays free of direct I/O.

## Acceptance scenarios

These scenarios describe the agreed flow; they do not report results from running tests.

1. **Online success:** given successful tax registration, append the `TaxRegisterDocument` XML to `context.documents`; `deriveState(context).nextLocalNum` then returns the following number.
2. **Tax validation error:** given HTTP 200 containing a tax validation error, return the error without starting an offline session or creating an offline copy of the transaction. Do not infer a persistence or numbering rule for the rejected document from this scenario.
3. **Offline start:** given an API/key error on original document 10, save original 10, then save together `OfflineBegin` at global 11/offline 1 and the recreated operation at global 12/offline 2. Verify that original 10 remains and that the next global/offline numbers are 13 and 3. Do not expose an intermediate completed start or totals calculation with `OfflineBegin` present but its recreated document absent.
4. **Offline continuation:** given the session from scenario 3, save the next document at global 13/offline 3 with the offline flag and no individual API send. Verify that the next global/offline numbers are 14 and 4.
5. **Original financial document accepted:** given an original financial document 10 in the current session, server `OfflineNextLocalNum = '1'`, and server `NextLocalNum = 11`, add the revocation marker to that session's `OfflineBegin` 11, immediately after `</CASHREGISTERNUM>`. Cover checks, input/output documents, and reports. Preserve the document numbers, do not append a document for the marker, and verify that the marked `OfflineBegin` validates against `check01.xsd` and is signed from the marked XML.
6. **Original not accepted:** given the server did not accept original 10 and still expects 10, make no change for the revocation decision.
7. **Offline counter meaning:** verify that `OfflineLocalNum = '1'` and `'2'` leave `deriveState(context).offlineNextLocalNum` at `'2'` and `'3'` respectively. The post-save next-number value is never mistaken for the number of the document just saved.
8. **Ready state:** after receiving `serverShiftState: TransactionsRegistrarStateResponse` and `serverLastShiftTotals: LastShiftTotals` for the requested register, initialize `context` with its `NumFiscal`, those responses, and `documents = []`. Allow offline operation when `OfflineSupported`, session credentials, and the offline counter permit it. An unfinished offline session blocks a replacement full sync only for that context.
9. **Package count and order:** with the default limit and sizes that fit the byte limit, 101 pending offline documents before the end are sent as sequential packages of 50, 50, and 1, followed by the end document alone, and 51 documents as 50 and 1. With `packageDocumentLimit = 100`, the 101 documents are sent as 100 and 1. A configured limit above 100 is rejected. Never exceed `packageDocumentLimit`, send an empty package, or include the end document with other documents.
10. **Resume after an API/key error:** request fresh server state before retrying. If the server now expects offline document 51, rebuild packages starting at document 51, including it.
11. **Package validation error:** given a `SendOflPackage` response reporting a tax validation error (for example `ErrorCode` 10 `PackageValidationError`, either as HTTP 200 JSON in `resultAsJson=true` mode or as a non-2xx `Код помилки` text), return the error without automatically restarting the package-send process.
12. **Successful end:** for draft `NumLocal = 20`, append it only after receiving `endState: OfflineSessionState` via the `'session-ended'` result. Afterwards `deriveState(context).nextLocalNum` is 21, `deriveState(context).offlineNextLocalNum` is `'1'`, and `context.working.offline` holds the returned session ID and seed. Retain `context.documents` until full synchronization succeeds. Documents from the finished session must not make the derived offline counter return the old session's value.
13. **End accepted despite an error:** given server online status and a successful local-number validation after the failed attempt, perform full synchronization. Do not clear documents if the totals request fails. The precise numeric comparison is pending confirmation.
14. **End not accepted or outcome unknown:** leave the end document unsaved after any failed or uncertain submission, including when the follow-up state request fails. Do not append it or advance the local sequence for it. An unfinished session prevents a new offline session.
15. **Full-sync cleanup:** only after session reconciliation, local-number validation, `serverShiftState`, and `serverLastShiftTotals` are available, replace `context.serverSnapshot`, set `context.working.offline` from the new snapshot, and clear `context.documents` in one logical transition. Ordinary confirmed-end validation compares `serverShiftState.NextLocalNum` with `deriveState(context).nextLocalNum`; lost-response recovery remains open.
16. **Non-financial original:** even if the server accepted the original and its next global number equals `OfflineBegin.NumLocal`, skip adding the revocation marker when the original is non-financial. Recreate and send that operation offline, including a shift-opening document. Verify that no error is raised by the local revocation decision and the recreated document has no effect on financial shift totals.
17. **Totals exclude the original:** given original sale 10 for 100, `OfflineBegin` 11, and recreated offline sale 12 for 100, include only sale 12 in the local contribution. The result is one sale of 100 before and after adding the revocation marker; original 10 remains in the sequence. Apply the same predecessor-exclusion rule to input/output documents and reports.
18. **Totals exclusion boundary:** exclude only the financial document immediately preceding `OfflineBegin`. Do not exclude an earlier unrelated financial document or apply this exclusion to a non-financial predecessor.
19. **Busy register:** while uploading packages, submitting the end document, or synchronizing state and totals, a new register operation throws an error without creating a document or advancing numbering. The error does not trigger offline fallback.
20. **Revocation scope and progress:** when server `OfflineNextLocalNum > 1`, do not add or recalculate the current session's marker. Retain a marker already added to its `OfflineBegin`, and do not modify another session's documents. When the server still expects offline number 1, reevaluate the current session using the other eligibility conditions.
21. **Only the end remains:** if the server already accepted every ordinary offline document, send no ordinary packages and send the end document alone.
22. **End succeeded but totals sync failed:** retain the successfully saved end and other local documents and `context.working.offline` with the new session ID and seed; the derived next offline number stays `'1'`. Do not clear documents until full synchronization succeeds.
23. **Whole state versus shift-open flag:** deserialize a flat response into `serverShiftState: TransactionsRegistrarStateResponse`. Verify its `OfflineSessionId` and `OfflineSeed` are available independently of `serverShiftState.ShiftState`. For both scalar values 0 and 1, verify that this flag alone never decides offline completion or journal cleanup.
24. **Recovery request credentials:** every upload/recovery attempt sends `TransactionsRegistrarStateRequest` with the current `OfflineSessionContext.OfflineSessionId` and `.OfflineSeed`. Reading its response does not replace `context.serverSnapshot` or change `context.working`, consume a number, or clear documents.
25. **Different local and server positions:** given local `deriveState(context).offlineNextLocalNum = '3'` and server `OfflineNextLocalNum = '1'` for the same session, retain the open local session and select offline documents starting at `'1'`. Do not treat the server's counter as proof of closure.
26. **Unavailable state:** HTTP 204 is not a successful populated state/totals model. Null or unavailable offline credentials do not permit offline document creation or prove closure. Malformed counters are not silently coerced to 1. These cases cannot authorize full-sync cleanup.
27. **Package contents:** a recovery package contains only the selected session's offline documents, ordered by `NumLocal` and starting inclusively at the expected `OfflineLocalNum`. The original online document and documents of another session are excluded. Compare offline numbers numerically (for example, `'9'` precedes `'10'`).
28. **Response shapes:** normalize the plain-text `"OK"` for an ordinary package to `'accepted'` without changing credentials; do not expect JSON or a `UID` in it. Normalize the end response's top-level `OfflineSessionId` and `OfflineSeed` (with or without `UID`) to `OfflineSessionState`; do not expect a nested state object or a returned next-offline counter. An error body is not either success outcome, and neither is a JSON response whose `UID` is present and differs from the request's, nor a response that does not match the package sent (`"OK"` for the end package, credentials for an ordinary one). An end response missing required credentials leaves the end unsaved and requires reconciliation, not ordinary-acknowledgement handling.
29. **Stable totals baseline:** two calculations over the same `context.serverSnapshot.totals` and `context.documents` produce the same result and leave the baseline unchanged. A recovery state query or ordinary-package acknowledgement does not fold uploaded documents into the baseline while leaving them counted in the journal.
30. **Rollback metadata:** preserve `serverShiftState.OfflineSessionRolledBack` and `.OfflineSessionRollbackCmdUID`; do not infer a successful closure from rollback metadata or clear the journal. Expected continuation for a rolled-back session remains a pending scenario, not an invented success path.
31. **Independent register numbering:** initialize A and B with distinct `NumFiscal` values and `NextLocalNum = 10`. Saving A's document 10 advances only A's counter and journal; B can still save its own document 10. Totals and offline counters are isolated in the same way.
32. **Context-scoped busy guard:** start A's upload through one caller, then attempt a new A operation through another caller/handle. Reject the A operation without allocating a number. Allow an otherwise valid B operation; A's activity does not cause a busy error for B.
33. **Asynchronous response routing:** start requests for A and B, change the UI-selected register, and return responses out of order. Each result updates only its originating context. Include successful end responses and verify that new session ID/seed values never reach another register's context.
34. **Context-scoped synchronization and cleanup:** complete A's full synchronization while B has an unfinished offline session. Replace A's state/totals and clear only A's journal. B's state, documents, counters, credentials, totals, and activity remain unchanged, including in persistent storage.
35. **Context-scoped packages and recovery:** with pending offline documents for both A and B, including coinciding local/offline numbers, upload A. Use A's `NumFiscal` in recovery requests, A's session credentials, and only A's documents in packages. Retries remain bound to A; no decision uses B's state or document numbers.
36. **Exact byte boundary:** use prepared-body fixtures of 199,999, 200,000, and 200,001 bytes. The first two pass the byte check; the last cannot be sent. Count the actual `Uint8Array` view, including a subarray whose backing buffer is larger. A compressed body smaller than the limit does not make a 200,001-byte original valid.
37. **Count complete encoded/signed bodies:** use content with non-ASCII text and fixtures where raw XML or unsigned JSON fits, but Base64, JSON, signatures/certificates, or timestamp data push the complete body over the limit. The complete-body size determines packaging, including the outer command signature.
38. **Byte-limited ordered packing:** given fitting prepared bodies for documents 1-2 and an oversized candidate 1-3, send 1-2 and then retry packaging starting with 3. Do not skip 3 to include a smaller document 4. Keep the end separate even if spare capacity remains.
39. **Single oversized document:** given a singleton prepared body of 200,001 bytes, throw `OfflineDocumentTooLargeError` with the correct context identity, document numbers, `measuredBytes = 200001`, `limitBytes = 200000`, and `retryable = false`. Send neither that document nor later/end documents; do not mutate numbering, totals baseline, or journal as a consequence of the size error, start offline fallback, or automatically retry. Other contexts remain usable.
40. **Oversized end:** after preceding packages succeed, an end-only request over the limit fails locally. The end remains unsaved, local next numbers/session credentials are not advanced/reset, the journal remains, and full-sync cleanup does not occur.
41. **Size rejection after earlier acknowledgements:** when an earlier package was accepted before the singleton error is discovered, do not undo it or clear the journal. An explicit later attempt requests fresh server state and resumes at its reported position, rechecking sizes.
42. **Measured bytes are the sent bytes:** assert that the body checked for the limit is the exact uncompressed body passed to the transport, or is recovered byte-for-byte by decompressing the transmitted body. Re-signing, timestamp/UID changes, or revocation XML changes require a new measurement; a stale check cannot authorize sending changed bytes.
43. **Credentials from shift opening:** given a successful online `OpenShift` whose receipt contains `OFFLINESESSIONID = '82563'` and `OFFLINESEED = '179625192271939'`, `context.working.offline.sessionId` and `.seed` become those values in the same update that saves the document. Another context's credentials do not change. A receipt without credentials, and the source of the derived next offline number after the receipt, are pending specification.
44. **Offline header rules:** for original 10 followed by `OfflineBegin` 11 (offline `'1'`), recreated sale 12 (`'2'`), sale 13 (`'3'`), and the end draft 14 (`'4'`): every offline document has `<OFFLINE>true</OFFLINE>` and `ORDERTAXNUM = <session>.<offline number>.<control number>`; 11 and 12 have no `PREVDOCHASH`; 13 carries the SHA-256 of 12's Windows-1251 XML; the end draft carries the hash of 13; `OfflineBegin` and the end draft never contain `TESTING`, even in a test shift; original 10 has no `OFFLINE`, `ORDERTAXNUM`, or `PREVDOCHASH`.
45. **Control-number test vector:** the official string `179625192271939,20082020,142338,10,4000002411,10,cdd68bb111f8993f3603f0179341571b35b73a07d5acee9b28fbfb714698e1b3` yields control number 4758, not 413.
46. **`SendOflPackage` request:** every package is a KEP-signed JSON `{ Command: 'SendOflPackage', Documents, UID }` posted to `/cmd` as `application/octet-stream`, with one Base64 signed document per `Documents` element in `NumLocal` order and a new `UID` per prepared command. No request is sent to `/pck`.
47. **Device registration:** for context A, `DeviceRegister` is a KEP-signed JSON `{ Command: 'DeviceRegister', NumFiscal, DeviceId, Forced, UID }` with A's `NumFiscal` and a 64-character `DeviceId`. A returned `DeviceId` equal to the sent one confirms this device; a different one is a device conflict for A only and changes nothing in context B. The behaviour after a conflict is pending specification.
48. **Lifecycle state per context:** drive A through `online` → `offline-open` → `uploading` → `submitting-end` → `synchronizing` → `online` (T5, T9, T11, T16, T21) while B stays `online`. At every step `RegisterActivity` and the offline indicator match the state table, and B's state never changes.
49. **Operations by state:** a new fiscal document is registered online in `online`, created offline in `offline-open`, and rejected locally without allocating a number in `uninitialized`, `unconfirmed`, `uploading`, `submitting-end`, and `synchronizing`. A local rejection never starts an offline session.
50. **Halting transitions:** a package tax validation error (T13), a single oversized document (T14), and an unexpected server position (T15) each move the context to `halted` with the matching reason and no automatic retry; only an explicitly started recovery attempt (T23) leaves `halted`. Whether new documents are allowed in `halted` is pending specification.
51. **Offline not available:** given an API or key error while the context is not offline-eligible (for example `OfflineSupported = false`), no `OfflineBegin` is created and the context enters `unconfirmed` (T6). Resolution of the outcome is pending specification.
52. **Exact money arithmetic:** sales of `0.10` and `0.20` give `Real.Sum = 0.30` exactly (held as `30`), and three sales of `33.33` give `99.99`. An amount such as `"10.005"` is rejected as malformed, not rounded.
53. **Shift boundary in the fold:** given a baseline with `Real.Sum = 500.00` and a journal containing sale 10 (`100.00`), a Z-report, a shift closing, a new shift opening, and sale 14 (`40.00`), the working totals are `Real.Sum = 40.00` and `OrdersCount = 1`; neither the baseline nor sale 10 contributes. With no shift opening in the journal, the result is the baseline plus all contributing documents.
54. **Contributions by kind:** a sale adds to `Real`, a return to `Ret`, cash input (`DOCSUBTYPE` 2 or 3) to `ServiceInput`, and cash output (`DOCSUBTYPE` 4) to `ServiceOutput`. Two sales paid with the same `PAYFORMCD` produce one `PayForm` row with the summed amount; tax rows are summed per `TYPE`, `LETTER`, `PRC`, and `SIGN`. A storno check or a `DOCTYPE` 1–4 check makes the fold report unsupported totals instead of omitting the document.
55. **Pure fold:** calling `computeWorkingTotals` twice with the same baseline and documents returns equal results and leaves both inputs unchanged.
56. **Register without shift data:** given a state response and HTTP 204 from `LastShiftTotals`, the context initializes with `serverSnapshot.totals = null` and working totals are empty. After an online shift opening and a sale of `25.00`, the working totals are `Real.Sum = 25.00` with no baseline involved. An HTTP 204 from the state query still leaves the context `uninitialized`.
57. **Journal refresh:** in `online`, after a shift closing registered online with local and server `NextLocalNum` both 31, the refresh replaces the snapshot, sets `working.offline` from it, and empties the journal; working totals afterwards come from the new snapshot. The refresh is discarded and the journal kept when the server's `NextLocalNum` differs, when a document was saved while the requests ran, when the response would drop non-null offline credentials, or when either request fails. No refresh runs while an offline session is open. A discarded refresh does not report an error for the shift closing.
58. **Recreated document content:** for original sale 10 and recreated sale 12, the body elements (`CHECKTOTAL`, `CHECKPAY`, `CHECKTAX`, `CHECKBODY`), `DOCTYPE`, `DOCSUBTYPE`, seller and register identity, `CASHIER`, and `TESTING` are identical. Document 12 has a new `UID`, an `ORDERDATE`/`ORDERTIME` not earlier than `OfflineBegin`, `ORDERNUM = 12`, `<OFFLINE>true</OFFLINE>`, an `ORDERTAXNUM` with offline number `'2'` whose control number uses its own date, time, and number, and no `PREVDOCHASH`. The XML of original 10 in the journal is unchanged.
59. **Core behind ports:** run scenarios 3, 9, 12, and 22 with fake ports only (a scripted `FiscalServerPort`, a deterministic `SignerPort`, a fixed `ClockPort`, an in-memory `ContextStore`). The same scripted exchanges give the same requests, journal, and states on every run. A `no-response` exchange is handled as an uncertain result, never as an error code. A `commit` with a stale version is rejected and leaves the stored context unchanged, and a second writer for the same `NumFiscal` waits for `withExclusiveLock`.
60. **Derived counters:** with an empty journal, `deriveState` returns the snapshot's `NextLocalNum` and `OfflineNextLocalNum`. After original 10, `OfflineBegin` 11, and recreated 12 it returns `nextLocalNum = 13`, `offlineNextLocalNum = '3'`, and `offlineSessionOpen = true`; after the accepted end 14 is saved, `15`, `'1'`, and `false`, although the completed session's last offline number is 4. No counter is stored, and `deriveState` reads only journal fields, not XML.
61. **Credentials change only on two events:** an online shift opening's receipt and a successful end-session response replace `context.working.offline`. A shift closing, and a shift opening created inside an offline session, leave it unchanged, and every document of the session keeps the session's ID in `ORDERTAXNUM`. During upload and end reconciliation, recovery requests use the stored pair, which is still the uploaded session's.
62. **Consistency check:** a journal with a gap in `NumLocal`, a gap in an offline session's `OfflineLocalNum`, or an open session whose `OfflineSessionId` differs from `working.offline.sessionId` moves the context to `halted` (`inconsistent-local-state`, T24) on load, with all stored parts unchanged; an explicit recovery attempt does not leave this state (T23). In `synchronizing` after T17, an open session in the journal is not a failure.
63. **Derived shift flags:** after an online shift opening with `TESTING` true, `deriveState(context).shift` is `{ open: true, zRepPresent: false, testing: true }`; after a Z-report, `zRepPresent` becomes true; after a shift closing, `open` becomes false. With no shift document in the journal, the flags come from the snapshot.

Tests for fully specified cases should assert API request parameters/order, journal contents, both derived counters, session identity, totals contribution, and blocked-operation errors as applicable. Mark cases under the following open decisions as pending specification; do not make a guessed recovery algorithm authoritative by writing a passing test for it.

## Server behaviour to verify

Several rules rest on Fiscal Server behaviour that the official documentation does not state precisely. Verify each assumption below in a test shift on the real server before implementing the rules that depend on it, and record the observed requests and responses as test fixtures. A test shift can include an offline session: its documents carry `<TESTING>true</TESTING>`, except `OfflineBegin` and `OfflineEnd`, which must not carry `TESTING` (see **Offline document construction**).

| # | Assumption | Rules that depend on it | How to verify | Status |
| --- | --- | --- | --- | --- |
| V1 | A state query with a session's `OfflineSessionId` and `OfflineSeed` returns that session's upload position in `OfflineNextLocalNum`. | Revocation decision, package resumption, upload steps 1–4. | Send `OfflineBegin` plus one package, then query state with the session's credentials and without them; compare `OfflineNextLocalNum`. | Not verified |
| V2 | A package without `OfflineEnd` is answered with the plain-text `"OK"`; the package with `OfflineEnd` with JSON containing `OfflineSessionId` and `OfflineSeed`. | Response normalization, end-session handling. | Record both responses, including whether the JSON carries `UID`. | Reported by the user; record a fixture |
| V3 | A recreated shift opening whose original the server already accepted is rejected (`ShiftAlreadyOpened` or `PackageValidationError`). The same run shows whether a hash chain whose document `'2'` is a shift opening is accepted. | **Recreated non-financial documents**, hash-chain start. | Register an `OpenShift` online, then upload `OfflineBegin` and a recreated `OpenShift` as document `'2'`, followed by a sale. | Not verified |
| V4 | `OfflineEnd` with `PREVDOCHASH` is accepted. The official sources disagree: the control-number example carries it, the `OfflineEnd` example file does not. | **Offline document construction**, rule 4. | Close one session with `PREVDOCHASH` on `OfflineEnd` and another without it. | Not verified |
| V5 | The 200 Kb limit is measured on the signed `SendOflPackage` command body, and 200,000 bytes is at or below the real threshold. | **Exact byte-counting**. | Send packages of about 199,000, 204,000, and 205,000 signed bytes and record which are accepted. | Not verified |

When an assumption is confirmed, set its status and keep the rules. When it is refuted, the dependent rules must be changed before implementation, not worked around in code.

## Flow details still to define

Items marked "blocks a common path" affect every register in normal operation and must be decided before implementation.

- **Validation rejection:** whether the rejected original is saved and whether its global local number is consumed.
- **Session reconciliation** (blocks a common path): which server facts confirm that an offline session ended. The rules use it as a gate for full synchronization, upload step 2, and transitions T10 and T17, but only its local-number half is defined (`serverShiftState.NextLocalNum === deriveState(context).nextLocalNum` for an ordinary confirmed end). The server-side half is not: for example, whether a state request with the session's credentials reports the next session's `OfflineSessionId`, or another field shows that the end was registered (see also V1 in **Server behaviour to verify** and **Closure rollback**).
- **Lost end-response validation** (blocks a common path): the numeric mismatch is documented in the edge-case comment; the exact recovery comparison remains unspecified.
- **Failed or interrupted closing:** when the block on new operations is released after the closing/synchronization attempt exits with an error (transitions T12, T19, T22, and new documents in `halted`), and how closing resumes after an application restart, including which lifecycle state is restored. The end document must remain unsaved without a successful response, and a new offline session cannot start while the current one is unfinished.
- **Other server states:** how to handle an inconsistent server position outside the described original-attempt and package-resumption cases, including a position caused by another device's documents (see **Single-device use and device registration**).
- **Closure rollback:** how `TransactionsRegistrarStateResponse.OfflineSessionRolledBack` and `TransactionsRegistrarStateResponse.OfflineSessionRollbackCmdUID` affect recovery, including requests made with the completed session's credentials. The API names these fields but does not give a complete recovery algorithm. Do not assume that requesting state is sufficient proof of closure.
- **Absent state/totals:** initialization and synchronization policy when the state query returns HTTP 204, and when `LastShiftTotals` reports an open shift without usable `Totals`. Settled: a `LastShiftTotals` HTTP 204, or a closed shift without `Totals`, initializes with `serverSnapshot.totals = null` (see **Initial state and full synchronization**). Do not fabricate an empty baseline or clear existing documents to fill the remaining gap.
- **Revocation verification against the API:** the agreed flow uses `serverShiftState.NextLocalNum === OfflineBegin.NumLocal`; the API's "Відкликання останнього онлайн чека" procedure describes retrieving and comparing the last registered document with the saved original. Whether an additional identity check is required, or when the counter comparison is guaranteed equivalent, remains to be confirmed. Retain the agreed three-condition rule until that decision is made. The counter comparison is not reliable if another device used the register.
- **Recreated non-financial documents:** retain the agreed rule to submit the recreated operation even when its original was accepted. The API does not explicitly describe an exception allowing an accepted shift-opening document to be replayed; its shift-state validation makes this an integration case requiring confirmation. The local non-financial revocation skip itself must still not throw.
- **Shift-opening receipt without credentials:** the behaviour when a successful shift-opening receipt lacks `OFFLINESESSIONID`, `OFFLINESEED`, or both. Candidate behaviour, not yet agreed: keep the stored pair (never clear it or update only one value). This must also settle where the derived next offline number comes from after a receipt replaces the credentials. The receipt carries no counter, so with no session-control entry in the journal the derivation falls back to the snapshot's `OfflineNextLocalNum`, which describes the snapshot's session, not necessarily the receipt's. In particular, a register initialized with null offline fields has a null snapshot counter, so after the receipt the derived next offline number stays null and the register can never become offline-ready. The decision must state the counter's source in both cases (for example `'1'` for a newly issued session, as R32 proposes, or a fresh state request).
- **Device registration and conflicts** (blocks a common path): when each context sends `DeviceRegister` (for example at initialization, before opening a shift, before entering offline mode, or before uploading packages); how a stable 64-character device identifier is derived where a MAC address is not available; what the context does when the returned `DeviceId` differs (block work, warn, or re-register with `Forced: true`, and who may decide); whether the current local number is checked against the server before each fiscal document; and how an unfinished offline session is handled when a conflict is detected. The API forbids simultaneous use but leaves the decision after a mismatch to the register software.
- **Totals for other document types:** how storno checks (the API registers the storno "із нульовим значенням сторнованої суми", but does not say how the storned check's contribution changes), and transfer, currency-exchange, cash-withdrawal, and pawnshop checks (`DOCTYPE` 1–4) contribute to `ShiftTotals` (`Cash`, `Currency`, the pawnshop and transfer fields). Until defined, a shift containing them has no exact working totals and no offline Z-report.
- **Unconfirmed online outcome:** how a context in `unconfirmed` learns whether the original was registered (for example a state request comparing `NextLocalNum`, or "Запит відомостей про документ за локальним номером" for the original's `NumLocal`), what is saved in each case, and when the request is retried.
- **Signer key selection:** which responses count as a certificate refusal of a package (for example HTTP 401, or `ErrorCode` 2 `OperatorAccessToTransactionsRegistrarNotGranted`), whether the context then re-signs with a senior cashier's or manager's key automatically or asks the user, and which key signs recovery state requests so that the "Offline…" fields are filled (they are filled only for the shift opener, a senior user, or a manager).
- **Upload trigger:** what starts transition T9 (for example a periodic connectivity check with "Запит стану сервера" or "Запит стану ПРРО", application start, or an explicit user action), the retry interval, and how the user is informed. The API's scenario expects the register to return to online mode automatically and inform the user.
- **Error classification and offline-entry confirmation** (blocks a common path): the exact mapping of API/key failures to offline eligibility or retryability, and the API scenario's user confirmation before offline entry, need an integration decision. Preserve the explicit HTTP-200 tax-validation-error exclusion; do not classify every JSON `ErrorCode` as a retryable transport failure.

## Implementation boundaries

This is the offline-focused service orchestration and persistence contract, not a replacement for the full shift lifecycle or fiscal XML specification. Document creation/serialization and the tax transport must also satisfy the official API's XML schemas, signing rules, request-size limits, and applicable offline eligibility/duration restrictions. The offline fiscal-number, control-number, hash-chain, and testing rules are specified in **Offline document construction**; the `TaxRegisterDocument` projection does not redefine them. Adding a revocation marker changes XML and must be reflected in the document bytes prepared for upload. The conservative 200,000-byte complete-body limit, the `SendOflPackage` transport, the singleton end package, and the save-end-only-after-success policy are application requirements; the 100-document maximum is an API constraint, and the default of 50 documents per package is an application default that may be configured up to that maximum.

## Official data structures

TypeScript transcription of structures that the official API description defines as C# classes. `decimal` values have two fractional digits and are held as exact integer hundredths (see **Money arithmetic**); `int`/`long` values are integers. The API does not state nullability for these members; decode absent or null members without inventing values.

```ts
type Decimal = bigint;                // API decimal, held as exact hundredths: 1000.71 -> 100071n.

// "Запит доступних об'єктів": TaxObjectItem; also TransactionsRegistrarStateResponse.TaxObject.
interface TaxObjectItem {
  Entity: number;                     // Business unit record ID.
  TaxObjGuid: string;                 // Taxable object record ID.
  TaxObjId: number;                   // Taxable object record code.
  SingleTax: boolean;                 // Sole proprietor paying the single tax.
  Name: string;                       // Business unit name.
  Address: string;                    // Business unit address.
  Tin: string;                        // Taxpayer EDRPOU/DRFO code.
  Ipn: string;                        // VAT payer tax number.
  OrgName: string;                    // Business entity name.
  ChiefCashier: boolean;              // Senior cashier.
  TransactionsRegistrars: TransactionsRegistrarItem[]; // Registers of the business unit.
}

interface TransactionsRegistrarItem {
  NumFiscal: number;                  // Register fiscal number.
  NumLocal: number;                   // Register local number.
  Name: string;                       // Register name.
  Closed: boolean;                    // Registration cancelled while a shift is still open.
}

// "Структура об’єкту підсумків зміни": LastShiftTotals.Totals.
interface ShiftTotals {
  Real: ShiftTotalsOrderType;         // Sales.
  Ret: ShiftTotalsOrderType;          // Returns.
  Cash: ShiftTotalsCash;              // Cash withdrawal.
  Currency: ShiftTotalsCurrency;      // Foreign-currency operations.
  ServiceInput: Decimal;              // Service deposit / advance received / reinforcement received.
  ServiceOutput: Decimal;             // Service issue / cash collection.
}

interface ShiftTotalsOrderType {
  Sum: Decimal;                       // Total sum.
  PwnSumIssued: Decimal;              // Total issued to pawnshop clients.
  PwnSumReceived: Decimal;            // Total received from pawnshop clients.
  RndSum: Decimal;                    // Rounding, e.g. 0.71.
  NoRndSum: Decimal;                  // Total without rounding, e.g. 1000.71.
  TotalCurrencySum: Decimal;          // Total of money transfers.
  TotalCurrencyCommission: Decimal;   // Total commission on money transfers.
  OrdersCount: number;                // Number of checks.
  PwnOrdersCountIssued: number;       // Checks issuing money to pawnshop clients.
  PwnOrdersCountReceived: number;     // Checks receiving money from pawnshop clients.
  TotalCurrencyCost: number;          // Number of money-transfer operations.
  PayForm: ShiftTotalsPayForm[];      // Totals by payment form.
  Tax: ShiftTotalsTax[];              // Taxes and levies.
}

interface ShiftTotalsPayForm {
  PayFormCode: number;                // Payment form code.
  PayFormName: string;                // Payment form name.
  Sum: Decimal;                       // Payment sum.
}

interface ShiftTotalsTax {
  Type: number;                       // Tax/levy type code.
  Name: string;                       // Tax/levy type name.
  Letter: string;                     // Letter code of the tax/levy type and rate.
  Prc: Decimal;                       // Tax/levy percentage.
  Sign: boolean;                      // Tax/levy not included in the price.
  Turnover: Decimal;                  // Turnover the tax/levy is calculated on.
  TurnoverDiscount: Decimal;          // Same, after discounts.
  SourceSum: Decimal;                 // Source sum for the tax/levy calculation.
  Sum: Decimal;                       // Tax/levy sum.
}

interface ShiftTotalsCash {
  Sum: Decimal;                       // Total sum.
  Commission: Decimal;                // Total commission.
  OrdersCount: number;                // Number of checks.
}

interface ShiftTotalsCurrency {
  TotalInAdvance: Decimal;            // Advances received, national currency.
  TotalInAttach: Decimal;             // Reinforcements received, national currency.
  TotalSurrCollection: Decimal;       // Handed over for collection, national currency.
  Commission: Decimal;                // Conversion commission received.
  CalcDocsCnt: number;                // Settlement documents in the shift.
  AcceptedN: Decimal;                 // National currency accepted for transfer.
  IssuedN: Decimal;                   // National currency paid out for transfers.
  CommissionN: Decimal;               // Transfer commission in national currency.
  TransfersCnt: number;               // Transfer or transfer-payout operations.
  Details: TotalsCurrencyDetails[];   // Totals per foreign currency.
}

interface TotalsCurrencyDetails {
  ValCd: number;                      // Currency code.
  ValSymCd: string;                   // Currency symbol code.
  BuyValI: Decimal;                   // Foreign currency bought.
  SellValI: Decimal;                  // Foreign currency sold.
  BuyValN: Decimal;                   // National currency bought.
  SellValN: Decimal;                  // National currency sold.
  StorBuyValI: Decimal;               // Foreign currency returned by clients (storno).
  StorSellValI: Decimal;              // National currency issued to clients (storno), as described by the API.
  StorBuyValN: Decimal;               // National currency returned by clients (storno).
  StorSellValN: Decimal;              // National currency issued to clients (storno).
  CInValI: Decimal;                   // Foreign currency accepted (conversion).
  COutValI: Decimal;                  // Foreign currency issued (conversion).
  Commission: Decimal;                // Conversion commission.
  InAdvance: Decimal;                 // Advances received.
  InAttach: Decimal;                  // Reinforcements received.
  SurrCollection: Decimal;            // Handed over for collection.
  StorCInValI: Decimal;               // Foreign currency issued (conversion storno).
  StorCOutValI: Decimal;              // Foreign currency returned (conversion storno).
  StorCommission: Decimal;            // Commission returned (conversion storno).
}
```

## Unresolved review findings

Findings from the specification and design reviews that are not yet applied to this document. Each is a proposal, not an agreed rule: an implementation must not adopt one until it is moved into the sections above. Priority: P1 = decide before implementation, P2 = strongly recommended, P3 = document quality. Where a finding resolves an item under **Flow details still to define**, that item is named.

### P1

- **R01. Crash safety.** Several updates must be "one logical transition", but storage-failure guarantees and restart handling are undefined. Two crash windows lose fiscal data: after a document is sent but before it is saved (the server may hold it, so local numbering falls behind), and after a successful end-session response but before the new credentials are stored. Proposal: write every outgoing document and the `OfflineEnd` draft to a per-context outbox with a status (`sending`, `registered`, `unconfirmed`, `rejected`) before sending; on startup, replay unfinished outbox entries through the state machine. `ContextStore.commit` (see **Core and its ports**) already makes each transition atomic; the outbox closes the gap between sending a request and committing its result. The outbox record is not a journal document, so the rule "save the end only after success" still holds. Resolves part of **Failed or interrupted closing**.
- **R02. One error model.** Error handling is split across **Online result handling**, the `SendOflPackage` response table, and **Error classification and offline-entry confirmation**. The online table keys on "HTTP 200 with a tax validation error", but a document sent to `/doc` is rejected through a receipt with `ERRORCODE`, a non-2xx response with the text `Код помилки: …`, or a 4xx without a code; only `/cmd?resultAsJson=true` returns HTTP 200 with JSON errors. A validation error received as HTTP 400 would therefore be treated as an API error, start an offline session, and fail again in the package. Proposal: one result type (`Registered | ServerRejected(code) | TransportFailure | SigningFailure(transient | permanent) | LocalRejection`), a mapping from every response form to it, and a policy per result (offline-eligible, retry, halt). Classify by the reported `ErrorCode`, not by HTTP status.
- **R03. Overlapping package error rows.** The API's error responses, including HTTP 500 and 503, carry the `Код помилки` text. An HTTP 5xx with `Код помилки: 10 PackageValidationError` matches both the "server-reported error" row (return, no restart) and the "HTTP 5xx" row (uncertain, restart). Proposal: a parseable `ErrorCode` decides the result whatever the HTTP status; only responses without a code fall back to the status.
- **R04. Oversized online document.** An online document over the 200 Kb limit is answered with HTTP 416. Today that counts as an API error, so the flow starts an offline session whose recreated document is even larger and can never be uploaded. Proposal: measure each online document before sending; treat HTTP 416 as a server rejection that never starts an offline session.
- **R05. Key error while the server is reachable.** Any key error starts an offline session, although the API ties offline sessions to loss of connection. A permanently unusable key (expired, revoked, wrong password) cannot sign the packages later, so the session can never be closed and the register hits the 36-hour block. Proposal: only a transient `SigningFailure` may start an offline session; a permanent one is a local rejection.
- **R06. Offline duration limits.** The API limits offline work to 36 hours per session and 168 hours per calendar month, defines the session duration as the time between `OfflineBegin` and the last financially significant document before `OfflineEnd`, blocks the register when a limit is exceeded, and recommends informing the user. The document models the duration fields only. Proposal: offline readiness also requires `OfflineSessionDuration` and `OfflineSessionsMonthlyDuration` below their limits (null means offline is prohibited, not 0); while a session is open, compute the elapsed time from `OfflineBegin`, warn at a threshold, and refuse new financial offline documents that would exceed the limit.
- **R07. Same operator and signing key.** The API's scenario requires that, with an open shift and the server unavailable, the register checks that the shift was opened by the same user; otherwise work is impossible until the shift is closed. The "Offline…" state fields are filled only for requests signed by the shift opener, a senior user, or a manager. Proposal: offline readiness also requires the signing key's `subjectKeyId` to equal the shift opener's; recovery state requests, offline documents, and packages are signed with that key. Complements **Signer key selection**.
- **R08. State-request credentials and closure rollback.** The rule that every recovery state request carries the session's credentials may itself trigger a closure rollback: the API describes these parameters as naming the session "for which packages will be sent" and reports in the same response whether a closure was cancelled and by which request. Sending a completed session's credentials could reopen it. Proposal: after a successful end, never send the completed session's credentials; verify this behaviour together with V1 in **Server behaviour to verify**. Relates to **Closure rollback**.
- **R09. Full synchronization can erase valid credentials.** After an end-session success the context holds the next session's credentials. A full-sync state response signed by a user other than the shift opener, a senior user, or a manager returns null "Offline…" fields, and deriving `working` from it erases the valid credentials. Proposal: apply the same credential guard as **Journal refresh points**, or sign the full-sync state request with a key that receives the "Offline…" fields.
- **R10. Server-side unfinished session at initialization.** After lost local storage, a reinstall, or a crash after some packages were accepted, the server can report `OfflineNextLocalNum > 1` with a session the journal does not contain. Initialization would then show an open local offline sequence without documents. Proposal: such a state is `uninitialized` with a defined recovery (refuse to work, or require operator action) instead of `online` or `offline-open`. Resolves the second half of transition T2.
- **R31. Open session derived without evidence.** With no `offline-begin` or `offline-end` entry in the journal, `deriveState(context).offlineSessionOpen` falls back to `Number(serverSnapshot.state.OfflineNextLocalNum) > 1`. The context then reports an open session while the journal holds no `OfflineBegin` and none of that session's documents: upload step 4 has nothing to select, the revocation decision has no `OfflineBegin` to mark, and the open-session rule of the **Consistency check** has no entry to compare with `working.offline.sessionId`, so it passes. At initialization this is the case of transition T2 and R10; it can also follow a full synchronization or an applied refresh whose response reports a counter above 1. Proposal: derive `offlineSessionOpen` from the journal only, with `false` when it has no session-control entry; add a consistency rule that a snapshot counter above 1 with no session-control entry in the journal fails; and do not apply a full-synchronization or refresh response that reports one (the refresh is discarded; full synchronization stops with `unresolved-server-state`). Resolves part of **Other server states**.
- **R32. Fallback counter from another session.** After an online shift opening's receipt replaces `working.offline`, a journal with no `offline-begin` or `offline-end` entry makes `offlineNextLocalNum` fall back to the snapshot's `OfflineNextLocalNum`. That counter belongs to the snapshot's `OfflineSessionId`, which need not be the session in the receipt. The fiscal numbers themselves are safe, because `OfflineBegin` always takes `'1'` and later documents derive from the journal. But offline readiness and the R31 fallback then judge the new session by another session's counter, and a null snapshot counter makes the register permanently not offline-ready. Proposal: use the snapshot's counter only when `working.offline.sessionId === serverSnapshot.state.OfflineSessionId`; otherwise the credentials belong to a newly issued session without documents, so `offlineNextLocalNum` is `'1'` and `offlineSessionOpen` is `false`. Resolves the counter half of **Shift-opening receipt without credentials**.

### P2

- **R11. Richer journal entries.** `TaxRegisterDocument` lacks values the rules need: document `UID`, `DOCTYPE`/`DOCSUBTYPE`, `ORDERDATE`/`ORDERTIME`, `ORDERTAXNUM`, and a status (`testing` is already a field). The revocation and totals rules find the original by adjacency ("immediately before `OfflineBegin`"), and `OfflineSessionContext` need not be persisted. Proposal: add these fields and an explicit link from `OfflineBegin` to its original; make the `REVOKELASTONLINEDOC` property the single source and generate the XML from it.
- **R12. Mapping from `DocumentKind` to the official codes.** Proposal: a table — `check`: `CHECK`, `DOCTYPE` 0, `DOCSUBTYPE` absent/0 (sale), 1 (return), 5 (storno); `cash-input`: `DOCSUBTYPE` 2 or 3; `cash-output`: `DOCSUBTYPE` 4; `report`: `ZREP`; `shift-open` 100, `shift-close` 101, `offline-begin` 102, `offline-end` 103; `DOCTYPE` 1–4 (transfer, currency exchange, cash withdrawal, pawnshop) listed as not supported by this flow.
- **R13. Revocation identity check.** The API's revocation procedure compares the last registered document with the saved original; the API provides the means. Proposal: after the three counter conditions hold, request "Запит чека розширений" (or "Запит Z-звіту розширений" for a Z-report) by the original's `NumLocal` with `Type` = original XML, and set the marker only when the returned document's `UID` equals the saved original's `UID`; HTTP 204 or "document absent" means not accepted. Resolves **Revocation verification against the API**.
- **R14. Upload scheduling.** Proposal for **Upload trigger**: a per-context scheduler that probes with `ConnectivityProbe` at an interval with exponential backoff and jitter, also starts on application start and on an explicit user action, runs at most one upload per context, and informs the user when the register returns online.
- **R15. Packing without signing every candidate.** The packing loop signs a complete candidate after each added document: up to `packageDocumentLimit` signer round trips per package (50 by default). Proposal: measure the signature overhead once, choose package boundaries from the exact unsigned size plus that overhead and a margin, then sign once and verify the final bytes, removing the last document if the result is over the limit. "The measured bytes are the sent bytes" still holds.
- **R16. Time model.** Proposal: state the time zone of `ORDERDATE`/`ORDERTIME` (the API's fields carry none), how the server-time estimate is derived from response `Timestamp` values, and what happens when the device clock moves backwards.
- **R17. Windows-1251 encodability.** XML text fields must be Windows-1251. A document containing a character outside that encoding is journaled offline without a check, then fails when the next document's hash is computed and when the package is signed, so the session can be neither continued nor sent. Proposal: encode each document when it is built, before it is sent or journaled, and reject the operation locally if a character cannot be represented.
- **R18. Receipt qualification.** Proposal: take credentials or a fiscal number from a receipt only when `ERRORCODE` is absent or 0 and its `UID` and `ORDERNUM` equal those of the sent document.
- **R19. Lossless decoding of identifiers.** The API shows `OfflineSessionId` and `OfflineSeed` as unquoted numbers, and the schema allows up to 128 digits. A JSON parser that converts them to floating-point numbers corrupts every later control number. Proposal: read these values from the response text exactly as written; a value that cannot be read losslessly is malformed.
- **R20. `LastShiftTotals` signing.** The API requires `LastShiftTotals` to be a KEP-signed JSON command, like the state request; the document states signing only for the state request. Proposal: one sentence stating it, with the same key policy.
- **R21. End package validation error.** After a tax validation error on the end package, **Submit offline packages** says not to restart automatically, while the end-session outcome table can lead back to resuming submission. Proposal: after `ErrorCode` 9 or 10 on the end package, return the error and stay in `halted`; resumption applies only to non-validation failures and to an explicitly started attempt.
- **R22. Security.** `OfflineSeed` lets anyone compute valid control numbers. Proposal: store it encrypted at rest, never log it, and redact it in diagnostics. For `DeviceIdProvider` where no MAC address is available: a random 32-byte value stored once (64 hex characters); state what happens when that storage is cleared (a new identifier, a device conflict, and who may re-register with `Forced: true`).
- **R23. Test harness.** Proposal: a fake Fiscal Server that enforces local and offline numbering, control numbers, the hash chain, package limits, and credential issuance, with fault injection (accept then drop the response, time out before accepting, HTTP 5xx, a chosen `ErrorCode`); property-based tests for the numbering invariants; fixtures recorded during **Server behaviour to verify**.
- **R24. Observability and remediation.** Proposal: a per-context audit trail of lifecycle transitions with request `UID`s and without secrets, a diagnostics view, and a documented hand-off for `halted` states: what the operator sees and may do. The document currently places operator remediation outside the automatic flow without describing it.

### P3

- **R25. Structure for an AI reader.** The same rule is stated in several places (end-session handling appears in about five), which is where contradictions arise. Proposal: order the document as glossary and invariants, types, state machine, algorithms with pre- and postconditions, error model, persistence and concurrency, open decisions, scenarios; give each rule an ID and use MUST/SHOULD; move rationale into notes.
- **R26. Open-item register.** Proposal: give each item under **Flow details still to define** an ID, options, a candidate default, an owner, the scenarios it blocks, and whether it blocks implementation.
- **R27. Scenarios as fixtures.** Proposal: rewrite the acceptance scenarios as Given/When/Then with explicit starting state, server exchanges, and expected requests, each linked to rule IDs; optionally keep them in a separate machine-readable file.
- **R28. Numeric offline counters.** `OfflineLocalNum` is a string while `GlobalLocalNum` is a number, which needs the extra rule "compare numerically, not lexicographically". Proposal: hold both counters as (branded) integers and convert to text only at the API boundary.
- **R29. Separate technical design document.** Internal types, ports, persistence, and concurrency are design rather than requirements. Proposal: move them into a separate design document that must conform to this one, keeping the behaviour (state machine, rules, wire contracts) here.
- **R30. Hash-chain start is not labeled as an application decision (medium).** The official text starts the hash sequence "з першого розрахункового документа (чека на оплату або Z-звіту)", and that first settlement document carries no `PREVDOCHASH` ("Для першого розрахункового документа офлайн сесії елемент “PREVDOCHASH” не створюється"). The rule in **Offline document construction** (chain start) starts the chain at offline document `'2'` whatever its kind, because `OfflineBegin` can still be extended with `REVOKELASTONLINEDOC`, and presents this as plain fact. The two readings differ when document `'2'` is not a payment check or Z-report, for example a recreated shift opening. Proposal: label the rule as an application decision and quote the official wording next to it. V3 in **Server behaviour to verify** already tests the case where document `'2'` is a shift opening.

### Drafting decisions to confirm

These rules are already in the sections above. They were chosen while drafting where the requirement left a detail open, and they stay in force unless changed. Each needs confirmation by the requirement owner.

- **D01. Mismatched package response.** `"OK"` for the package with `OfflineEnd`, or credentials for a package without it, is not an acknowledgement and is handled as an uncertain result reconciled through a fresh state request (**Package transport: the `SendOflPackage` command**). Alternative: treat it as a protocol error and halt.
- **D02. Package error classes.** `ErrorCode` 9 and 10 in a package response are tax validation errors; no response, a timeout, or HTTP 5xx is an uncertain result that restarts from the state request. Other error codes stay under **Error classification and offline-entry confirmation**. See also R03 for 5xx responses that carry an error code.
- **D03. Totals grouping keys.** `PayForm` rows are grouped by `PAYFORMCD`; `Tax` rows by `TYPE`, `LETTER`, `PRC`, and `SIGN` (**The totals fold**). The API does not define them; verify against the server's `LastShiftTotals` after a full synchronization.
- **D04. Unsupported document types in totals.** A storno check or a `DOCTYPE` 1–4 check makes the fold report unsupported totals instead of leaving the document out. Alternative: leave them out with a warning, which would make an offline Z-report inexact.
- **D05. Non-blocking refresh.** A journal refresh does not block new operations; its result is applied only if no document was saved while it ran (**Journal refresh points**). Alternative: block operations for the duration of the refresh.
- **D06. Credential guard on refresh.** A refresh is discarded when the response would replace non-null offline credentials with null fields, which happens when the state request is not signed by the shift opener, a senior user, or a manager. R09 proposes the same guard for full synchronization.
- **D07. Refresh points.** A refresh runs after both a shift closing and a Z-report registered online. Alternative: only after a shift closing.
- **D08. Package size configuration.** The 50-document default can be configured from 1 to 100, and a value above 100 is rejected (**Submit offline packages**). Alternative: a fixed limit of 50.
- **D09. Recreated document identity and time.** The recreated document gets a new `UID` and the time of recreation as `ORDERDATE`/`ORDERTIME`, in addition to the new `ORDERNUM`, `ORDERTAXNUM`, and hash-chain position (**Building the recreated document**).
- **D10. Lifecycle states `unconfirmed` and `halted`.** An API or key error without offline eligibility enters `unconfirmed` and blocks new fiscal documents; a package validation error, an oversized document, or an unexpected server position enters `halted`, which only an explicitly started recovery attempt leaves (**Register lifecycle state machine**). Whether new documents are allowed in `halted` is still open.
- **D11. Derived shift flags.** `deriveState(context).shift` is a fold over the journal's shift-opening, Z-report, and shift-closing entries in order, starting from the snapshot's flags, with `testing` from the latest shift-opening entry's `testing` field (**Source of truth**).
- **D13. Only credentials stored.** `context.working` stores only the offline credentials in force; counters and shift flags are derived from the journal and the snapshot, and a consistency check halts the context on a mismatch (**Source of truth**, **Consistency check**).
- **D12. Port shapes.** The interfaces in **Core and its ports** are a structural proposal; their names and method shapes may change as long as each stated guarantee holds.
