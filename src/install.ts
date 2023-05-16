import url from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { Readable } from 'node:stream'

import fetch from 'node-fetch'
import unzipper from 'unzipper'
import logger from '@wdio/logger'
import { execa } from 'execa'
import { transform } from 'camaro'

import findEdgePath from './finder.js'
import { DOWNLOAD_DIRECTORY, XML_TEMPLATE, BINARY_FILE } from './constants.js'
import { hasAccess, findByArchitecture } from './utils.js'
import type { EdgeVersion } from './types.js'

const __dirname = url.fileURLToPath(new URL('.', import.meta.url))
const log = logger('edgedriver')

export async function download (edgeVersion?: string) {
  const targetDir = path.resolve(__dirname, '..', '.bin')
  const binaryFilePath = path.resolve(targetDir, BINARY_FILE)

  if (await hasAccess(binaryFilePath)) {
    return binaryFilePath
  }

  if (!edgeVersion) {
    const edgePath = findEdgePath()
    log.info(`Trying to detect Microsoft Edge version from binary found at ${edgePath}`)
    const versionOutput = await execa(edgePath, ['--version'])
    edgeVersion = versionOutput.stdout.trim().split(' ').pop()
    log.info(`Detected Microsoft Edge v${edgeVersion}`)
  }

  const version = await fetchVersion(edgeVersion)
  log.info(`Downloading Edgedriver from ${version.url}`)
  const res = await fetch(version.url)

  if (!res.body) {
    throw new Error(`Failed to download binary (statusCode ${res.status})`)
  }

  await fsp.mkdir(targetDir, { recursive: true })
  await downloadZip(res.body, targetDir)
  await fsp.chmod(binaryFilePath, '755')
  return binaryFilePath
}

async function fetchVersion (edgeVersion: string) {
  const res = await fetch(DOWNLOAD_DIRECTORY)
  const xml = await res.text()
  const versions: EdgeVersion[] = (await transform(xml, XML_TEMPLATE)).map(({ name: xmlName, lastModified, url }: { name: string, lastModified: string, url: string }) => {
    const [version, name] = xmlName.split('/')
    return { name, version, url, lastModified }
  })

  const uniqueVersions = [...new Set(versions.map((v) => v.version))]
  const versionsSorted = uniqueVersions.sort((a, b) => a.localeCompare(b, undefined, { numeric:true })).reverse().map((v) => versions.filter((vv) => vv.version === v)).flat()
  const desiredVersion = versionsSorted.find((v) => v.version === edgeVersion && findByArchitecture(v.name))
  if (!desiredVersion) {
    throw new Error(`No version "${edgeVersion}" found, latest versions available are ${versionsSorted.slice(0, 10).map((v) => v.version).join(', ')}`)
  }

  return desiredVersion
}

function downloadZip(body: NodeJS.ReadableStream, targetDir: string) {
  const stream = Readable.from(body).pipe(unzipper.Parse())
  const promiseChain: Promise<string | void>[] = [
    new Promise((resolve, reject) => {
      stream.on('close', () => resolve())
      stream.on('error', () => reject())
    })
  ]

  stream.on('entry', (entry) => {
    const unzippedFilePath = path.join(targetDir, entry.path)
    const execStream = entry.pipe(fs.createWriteStream(unzippedFilePath))
    promiseChain.push(new Promise((resolve, reject) => {
      execStream.on('close', () => resolve(unzippedFilePath))
      execStream.on('error', reject)
    }))
  })

  return Promise.all(promiseChain)
}

/**
 * download on install
 */
if (process.argv[1] && process.argv[1].endsWith('/dist/install.js') && Boolean(process.env.EDGEDRIVER_AUTO_INSTALL)) {
  await download().then(
    () => log.info('Success!'),
    (err) => log.error(`Failed to install Edgedriver: ${err.stack}`)
  )
}