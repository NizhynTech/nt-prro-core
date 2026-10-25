// Errors the Fiscal Server returns for a rejected document or command. The response text is
// "Код помилки: <code> <name>" on the first line and the message on the following lines.

export enum TaxErrorEnum {
  OperatorAccessToTransactionsRegistrarNotGranted = 2,
  ShiftAlreadyOpened = 4,
  ShiftNotOpened = 5,
  LastDocumentMustBeZRep = 6,
  CheckLocalNumberInvalid = 7,
  ZRepAlreadyRegistered = 8,
  DocumentValidationError = 9,
  OfflineSessionNotOpened = 15,
  ServerError = 500,
}

export class TaxError {
  constructor(originalError: string) {
    this._parseTaxError(originalError);
  }

  originalError: string;
  error: TaxErrorEnum;
  text: string;
  errorCode: string;
  errorNumberCode: number;

  private _parseTaxError(taxError: string) {
    if (!taxError || taxError.length == 0) {
      return null;
    }

    const lines = taxError.split(/\r?\n/);
    if (lines.length == 0) {
      return;
    }

    // A single line is not in the server's format: it is reported as a server error.
    if (lines.length < 2) {
      this.originalError = taxError;
      this.error = TaxErrorEnum[TaxErrorEnum[500]];
      this.text = taxError;
      this.errorCode = '500';
      this.errorNumberCode = 500;

      return;
    }

    const headerValues = lines[0].split(/(\s+)/).reverse();
    const messageParts: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (i == 0) {
        continue;
      }

      messageParts.push(lines[i]);
    }

    this.originalError = taxError;
    this.error = TaxErrorEnum[TaxErrorEnum[+headerValues[2]]];
    this.text = messageParts.join('\n\r');
    this.errorCode = headerValues[2];
    this.errorNumberCode = +headerValues[2];
  }

  // For CheckLocalNumberInvalid: the local number the server expects, the last word of the
  // message. undefined for other errors or when the message has no number.
  getNextCheckLocalNumberFromError() {
    let nextCheckLocalNumber: number;
    if (this.error == TaxErrorEnum.CheckLocalNumberInvalid) {
      const errorTextParts = this.text.split(' ');
      const _nextCheckLocalNumber = +errorTextParts.pop();
      if (!isNaN(_nextCheckLocalNumber)) {
        nextCheckLocalNumber = _nextCheckLocalNumber;
      }
    }

    return nextCheckLocalNumber;
  }
}

// A failed document send with an HTTP status below 500 is the server rejecting the document:
// the user must resolve it. 5xx or no response (0) means the outcome is unknown and is handled
// like a connection error (offline fallback).
export function isDocumentRejectedByServer(httpStatusCode: number): boolean {
  return httpStatusCode > 0 && httpStatusCode < 500;
}
