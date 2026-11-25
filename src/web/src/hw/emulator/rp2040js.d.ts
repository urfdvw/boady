/**
 * Types for the parts of the vendored rp2040js that boady uses. The vendored
 * code is compiled with its own settings (vendor/rp2040js/tsconfig.json) and
 * typechecked separately (`npm run typecheck`), so our stricter options do not apply to it.
 */
declare module "@vendor/rp2040js" {
  export const bootromB1: Uint32Array;
  export enum LogLevel {
    Debug,
    Info,
    Warn,
    Error,
  }
  export class ConsoleLogger {
    constructor(level: LogLevel, throwOnError?: boolean);
  }
  export interface Peripheral {}
  export interface GPIOPin {
    padValue: number;
    setInputValue(value: boolean): void;
    /** boady addition (D42) */
    releaseInput(): void;
    /** boady addition (D42) */
    readonly padLevel: boolean;
    readonly outputEnable: boolean;
  }
  export class RP2040 {
    readonly flash: Uint8Array;
    readonly qspi: GPIOPin[];
    readonly gpio: GPIOPin[];
    readonly peripherals: { [index: number]: Peripheral };
    readonly usbCtrl: unknown;
    readonly core: { PC: number };
    logger: unknown;
    loadBootrom(bootrom: Uint32Array): void;
  }
  export class Simulator {
    readonly rp2040: RP2040;
    execute(): void;
    stop(): void;
  }
  export class USBCDC {
    constructor(usb: unknown);
    readonly txFIFO: { readonly full: boolean };
    onDeviceConnected: () => void;
    onSerialData: (buffer: Uint8Array) => void;
    sendSerialByte(data: number): void;
  }
}
