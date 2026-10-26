import {
  CheckExtCommand,
  LastShiftTotalsCommand,
  ObjectsCommand,
  OperatorsCommand,
  SendOflPackageCommand,
  ServerStateCommand,
  ShiftDocumentsCommand,
  ShiftsCommand,
  TransactionsRegistrarStateCommand,
  ZRepExtCommand,
} from './tax-commands.js';

describe('Fiscal Server commands', () => {
  it('ServerState', () => {
    expect(new ServerStateCommand().toString()).toBe(
      '{"Command":"ServerState"}',
    );
  });

  it('TransactionsRegistrarState with and without the optional fields', () => {
    expect(new TransactionsRegistrarStateCommand('4000123456').toString()).toBe(
      '{"Command":"TransactionsRegistrarState","NumFiscal":"4000123456"}',
    );
    expect(
      new TransactionsRegistrarStateCommand(
        '4000123456',
        '1234',
        '987654321',
        true,
      ).toString(),
    ).toBe(
      '{"Command":"TransactionsRegistrarState","NumFiscal":"4000123456",' +
        '"OfflineSessionId":"1234","OfflineSeed":"987654321","IncludeTaxObject":true}',
    );
  });

  it('LastShiftTotals', () => {
    const command = new LastShiftTotalsCommand('4000123456');

    expect(command.Command).toBe('LastShiftTotals');
    expect(command.toString()).toBe(
      '{"Command":"LastShiftTotals","NumFiscal":"4000123456"}',
    );
  });

  it('Shifts covers whole local calendar days', () => {
    const command = new ShiftsCommand(
      '4000123456',
      new Date(2026, 9, 1, 15, 30),
      new Date(2026, 9, 3, 8, 0),
    );

    expect(command.toString()).toBe(
      '{"Command":"Shifts","NumFiscal":"4000123456",' +
        `"From":"/Date(${Date.UTC(2026, 9, 1)})/",` +
        `"To":"/Date(${Date.UTC(2026, 9, 3, 23, 59, 59)})/"}`,
    );
  });

  it('Documents', () => {
    expect(new ShiftDocumentsCommand('4000123456', 77, 4000001).toString()).toBe(
      '{"Command":"Documents","NumFiscal":"4000123456","ShiftId":"77",' +
        '"OpenShiftFiscalNum":"4000001"}',
    );
  });

  it('CheckExt by fiscal number or by local number', () => {
    expect(
      new CheckExtCommand({
        registrarNumFiscal: '4000123456',
        numFiscal: '4000001',
        type: 'Visualization',
        acquireCabinetUrl: true,
      }).toString(),
    ).toBe(
      '{"Command":"CheckExt","RegistrarNumFiscal":"4000123456",' +
        '"NumFiscal":"4000001","Type":"Visualization","AcquireCabinetUrl":true}',
    );
    expect(
      new CheckExtCommand({
        registrarNumFiscal: '4000123456',
        numLocal: 15,
        type: 'OriginalXml',
        acquireCabinetUrl: false,
      }).toString(),
    ).toBe(
      '{"Command":"CheckExt","RegistrarNumFiscal":"4000123456",' +
        '"NumLocal":15,"Type":"OriginalXml","AcquireCabinetUrl":false}',
    );
  });

  it('ZRepExt', () => {
    expect(
      new ZRepExtCommand('4000123456', '4000009', 'OriginalXml').toString(),
    ).toBe(
      '{"Command":"ZRepExt","RegistrarNumFiscal":"4000123456",' +
        '"NumFiscal":"4000009","Type":"OriginalXml"}',
    );
    expect(
      new ZRepExtCommand('4000123456', null, 'OriginalXml', 15).toString(),
    ).toBe(
      '{"Command":"ZRepExt","RegistrarNumFiscal":"4000123456",' +
        '"NumLocal":15,"Type":"OriginalXml"}',
    );
  });

  it('Objects', () => {
    expect(new ObjectsCommand().toString()).toBe('{"Command":"Objects"}');
  });

  it('SendOflPackage', () => {
    expect(new SendOflPackageCommand(['QQ==', 'Qg=='], 'uid-1').toString()).toBe(
      '{"Command":"SendOflPackage","Documents":["QQ==","Qg=="],"UID":"uid-1"}',
    );
  });

  it('Operators', () => {
    expect(new OperatorsCommand().toString()).toBe('{"Command":"Operators"}');
  });
});
