import { app, BrowserWindow } from 'electron'

import { join, resolve } from 'path'
import { execSync } from 'child_process'

/**
 * Managers
 **/
import { windowManager } from './managers/window'

/**
 * IPC Handlers
 **/
import { handleAppUpdates } from './handlers/update'
import { handleAppIPCs } from './handlers/native'

/**
 * Utils
 **/
import { setupMenu } from './utils/menu'
import { createUserSpace, getJanDataFolderPath } from './utils/path'
import { migrate } from './utils/migration'
import { cleanUpAndQuit } from './utils/clean'
import { setupCore } from './utils/setup'
import { setupReactDevTool } from './utils/dev'

import log from 'electron-log'

import { start } from 'cortexso'

const preloadPath = join(__dirname, 'preload.js')
const rendererPath = join(__dirname, '..', 'renderer')
const mainPath = join(rendererPath, 'index.html')

const mainUrl = 'http://localhost:3000'

const gotTheLock = app.requestSingleInstanceLock()

if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient('jan', process.execPath, [
      resolve(process.argv[1]),
    ])
  }
} else {
  app.setAsDefaultProtocolClient('jan')
}

const createMainWindow = () => {
  const startUrl = app.isPackaged ? `file://${mainPath}` : mainUrl
  windowManager.createMainWindow(preloadPath, startUrl)
}

log.initialize()
log.info('Starting jan from main thread..')

// replace all console.log to log
Object.assign(console, log.functions)

const cortexJsPort = 1338
const cortexCppPort = 3940
const host = '127.0.0.1'

app
  .whenReady()
  .then(() => {
    const dataFolderPath = join(getJanDataFolderPath(), 'jan.log')
    log.transports.file.resolvePathFn = () => dataFolderPath
  })
  .then(() => setupCore())
  .then(() => {
    if (!gotTheLock) {
      app.quit()
      throw new Error('Another instance of the app is already running')
    } else {
      app.on(
        'second-instance',
        (_event, commandLine, _workingDirectory): void => {
          if (process.platform === 'win32' || process.platform === 'linux') {
            // this is for handling deeplink on windows and linux
            // since those OS will emit second-instance instead of open-url
            const url = commandLine.pop()
            if (url) {
              windowManager.sendMainAppDeepLink(url)
            }
          }
          windowManager.showMainWindow()
        }
      )
    }
  })

  .then(() => killProcessesOnPort(cortexCppPort))
  .then(() => killProcessesOnPort(cortexJsPort))
  .then(() => {
    start('jan', host, cortexJsPort, cortexCppPort, getJanDataFolderPath())
  })
  .then(createUserSpace)
  .then(migrate)
  .then(setupMenu)
  .then(handleIPCs)
  .then(handleAppUpdates)
  .then(createMainWindow)
  .then(() => {
    if (!app.isPackaged) {
      setupReactDevTool()
      windowManager.mainWindow?.webContents.openDevTools()
    }
  })
  .then(() => {
    app.on('activate', () => {
      if (!BrowserWindow.getAllWindows().length) {
        createMainWindow()
      } else {
        windowManager.showMainWindow()
      }
    })
  })

app.on('open-url', (_event, url) => {
  windowManager.sendMainAppDeepLink(url)
})

app.once('quit', async () => {
  cleanUpAndQuit()
})

app.once('window-all-closed', async () => {
  await stopApiServer()
  cleanUpAndQuit()
})

async function stopApiServer() {
  // this function is not meant to be success. It will throw an error.
  try {
    await fetch(`http://${host}:${cortexJsPort}/v1/system`, {
      method: 'DELETE',
    })
  } catch (error) {
    // do nothing
  }
}

/**
 * Handles various IPC messages from the renderer process.
 */
function handleIPCs() {
  // Inject core handlers for IPCs
  // Handle native IPCs
  handleAppIPCs()
}

function killProcessesOnPort(port: number): void {
  try {
    console.log(`Killing processes on port ${port}...`)
    if (process.platform === 'win32') {
      killProcessesOnWindowsPort(port)
    } else {
      killProcessesOnUnixPort(port)
    }
  } catch (error) {
    console.error(
      `Failed to kill process(es) on port ${port}: ${(error as Error).message}`
    )
  }
}

function killProcessesOnWindowsPort(port: number): void {
  let result: string
  try {
    result = execSync(`netstat -ano | findstr :${port}`).toString()
  } catch (error) {
    console.log(`No processes found on port ${port}.`)
    return
  }

  const lines = result.split('\n').filter(Boolean)

  if (lines.length === 0) {
    console.log(`No processes found on port ${port}.`)
    return
  }

  const pids = lines
    .map((line) => {
      const parts = line.trim().split(/\s+/)
      return parts[parts.length - 1]
    })
    .filter((pid): pid is string => Boolean(pid) && !isNaN(Number(pid)))

  if (pids.length === 0) {
    console.log(`No valid PIDs found for port ${port}.`)
    return
  }
  const uniquePids = Array.from(new Set(pids))
  console.log('uniquePids', uniquePids)

  uniquePids.forEach((pid) => {
    try {
      execSync(`taskkill /PID ${pid} /F`)
      console.log(
        `Process with PID ${pid} on port ${port} has been terminated.`
      )
    } catch (error) {
      console.error(
        `Failed to kill process with PID ${pid}: ${(error as Error).message}`
      )
    }
  })
}

function killProcessesOnUnixPort(port: number): void {
  let pids: string[]

  try {
    pids = execSync(`lsof -ti tcp:${port}`)
      .toString()
      .trim()
      .split('\n')
      .filter(Boolean)
  } catch (error) {
    if ((error as { status?: number }).status === 1) {
      console.log(`No processes found on port ${port}.`)
      return
    }
    throw error // Re-throw if it's not the "no processes found" error
  }

  pids.forEach((pid) => {
    process.kill(parseInt(pid), 'SIGTERM')
    console.log(`Process with PID ${pid} on port ${port} has been terminated.`)
  })
}

/**
 * Suppress Node error messages
 */
process.on('uncaughtException', function (err) {
  log.error(`Error: ${err}`)
})
