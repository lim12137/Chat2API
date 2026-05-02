const noop = (): void => {}

const asyncNoop = async (): Promise<void> => {}

export const app = {
  isPackaged: false,
  isQuitting: false,
  commandLine: {
    appendSwitch: noop,
  },
  on: noop,
  quit: noop,
  relaunch: noop,
  getVersion: (): string => '0.0.0',
  getPath: (): string => process.cwd(),
  requestSingleInstanceLock: (): boolean => true,
  whenReady: async (): Promise<void> => {},
}

export class BrowserWindow {}

export const safeStorage = {
  isEncryptionAvailable: (): boolean => false,
  encryptString: (value: string): Buffer => Buffer.from(value, 'utf-8'),
  decryptString: (value: Buffer): string => value.toString('utf-8'),
}

export const shell = {
  openExternal: asyncNoop,
}

export const ipcMain = {
  handle: noop,
  on: noop,
  removeHandler: noop,
}

export const net = {
  request: () => ({
    on: noop,
    write: noop,
    end: noop,
    setHeader: noop,
  }),
}

const electronDefault = {
  app,
  BrowserWindow,
  safeStorage,
  shell,
  ipcMain,
  net,
}

export default electronDefault
