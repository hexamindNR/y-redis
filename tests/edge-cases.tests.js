import * as t from 'lib0/testing'
import * as Y from 'yjs'
import * as encoding from 'lib0/encoding'
import * as promise from 'lib0/promise'
import * as redis from 'redis'
import * as api from '../src/api.js'
import { prevClients, store } from './utils.js'

const redisPrefix = 'ytests-edge'

/**
 * Clean up Redis before each test
 * @param {t.TestCase} tc
 */
const createTestCase = async tc => {
  await promise.all(prevClients.map(c => c.destroy().catch(() => {})))
  prevClients.length = 0
  const redisClient = redis.createClient({ url: api.redisUrl })
  await redisClient.connect()
  const keysToDelete = await redisClient.keys(redisPrefix + ':*')
  keysToDelete.length > 0 && await redisClient.del(keysToDelete)
  await redisClient.quit()
  const client = await api.createApiClient(store, redisPrefix)
  prevClients.push(client)
  const room = tc.testName
  const docid = 'main'
  const ydoc = new Y.Doc()
  ydoc.on('update', update => {
    const m = encoding.encode(encoder => {
      encoding.writeVarUint(encoder, 0)
      encoding.writeVarUint(encoder, 2)
      encoding.writeVarUint8Array(encoder, update)
    })
    client.addMessage(room, docid, Buffer.from(m))
  })
  return { client, ydoc, room, docid }
}

/**
 * Test document with special characters in room name
 * @param {t.TestCase} tc
 */
export const testSpecialCharsInRoomName = async tc => {
  const { client } = await createTestCase(tc)

  // Test various special characters
  const specialRooms = [
    'room/with/slashes',
    'room:with:colons',
    'room with spaces',
    'room?with=query&params',
    'room#with#hashes',
    'room%percent',
    'émoji🎉room',
    '日本語部屋',
    'room\twith\ttabs',
    'room"with"quotes'
  ]

  for (const room of specialRooms) {
    const ydoc = new Y.Doc()
    ydoc.getMap().set('key', 'value')
    const update = Y.encodeStateAsUpdate(ydoc)
    const message = encoding.encode(encoder => {
      encoding.writeVarUint(encoder, 0)
      encoding.writeVarUint(encoder, 2)
      encoding.writeVarUint8Array(encoder, update)
    })
    await client.addMessage(room, 'doc', Buffer.from(message))

    const { ydoc: loaded } = await client.getDoc(room, 'doc')
    t.assert(loaded.getMap().get('key') === 'value', `Room "${room}" works`)
  }
}

/**
 * Test document with special characters in docid
 * @param {t.TestCase} tc
 */
export const testSpecialCharsInDocId = async tc => {
  const { client, room } = await createTestCase(tc)

  const specialDocIds = [
    'doc/with/slashes',
    'doc:with:colons',
    'doc with spaces',
    'doc?query',
    '文書ID',
    'doc.with.dots',
    'doc-with-dashes',
    'doc_with_underscores'
  ]

  for (const docid of specialDocIds) {
    const ydoc = new Y.Doc()
    ydoc.getMap().set('test', docid)
    const update = Y.encodeStateAsUpdate(ydoc)
    const message = encoding.encode(encoder => {
      encoding.writeVarUint(encoder, 0)
      encoding.writeVarUint(encoder, 2)
      encoding.writeVarUint8Array(encoder, update)
    })
    await client.addMessage(room, docid, Buffer.from(message))

    const { ydoc: loaded } = await client.getDoc(room, docid)
    t.assert(loaded.getMap().get('test') === docid, `DocID "${docid}" works`)
  }
}

/**
 * Test large document with many updates
 * @param {t.TestCase} tc
 */
export const testLargeDocumentManyUpdates = async tc => {
  const { client, ydoc, room, docid } = await createTestCase(tc)

  // Add 100 updates
  const map = ydoc.getMap()
  for (let i = 0; i < 100; i++) {
    map.set(`key${i}`, `value${i}`)
  }

  const { ydoc: loaded } = await client.getDoc(room, docid)
  for (let i = 0; i < 100; i++) {
    t.assert(loaded.getMap().get(`key${i}`) === `value${i}`, `Key ${i} correct`)
  }
}

/**
 * Test document with large text content
 * @param {t.TestCase} tc
 */
export const testLargeTextContent = async tc => {
  const { client, ydoc, room, docid } = await createTestCase(tc)

  // Create a large string (100KB)
  const largeString = 'x'.repeat(100 * 1024)
  ydoc.getText().insert(0, largeString)

  const { ydoc: loaded } = await client.getDoc(room, docid)
  t.assert(loaded.getText().length === largeString.length, 'Large text content preserved')
}

/**
 * Test deeply nested document structure
 * @param {t.TestCase} tc
 */
export const testDeeplyNestedStructure = async tc => {
  const { client, ydoc, room, docid } = await createTestCase(tc)

  // Create nested maps 10 levels deep
  let currentMap = ydoc.getMap('root')
  for (let i = 0; i < 10; i++) {
    const nestedMap = new Y.Map()
    currentMap.set('nested', nestedMap)
    currentMap = nestedMap
  }
  currentMap.set('deepValue', 'found')

  const { ydoc: loaded } = await client.getDoc(room, docid)

  // Navigate to the deep value
  let loadedMap = loaded.getMap('root')
  for (let i = 0; i < 10; i++) {
    loadedMap = /** @type {Y.Map<any>} */ (loadedMap.get('nested'))
    t.assert(loadedMap instanceof Y.Map, `Level ${i} is a Y.Map`)
  }
  t.assert(loadedMap.get('deepValue') === 'found', 'Deep value found')
}

/**
 * Test rapid sequential updates
 * @param {t.TestCase} tc
 */
export const testRapidSequentialUpdates = async tc => {
  const { client, ydoc, room, docid } = await createTestCase(tc)

  // Rapid updates without waiting
  const map = ydoc.getMap()
  for (let i = 0; i < 50; i++) {
    map.set('counter', i)
  }

  // Small wait to ensure messages are queued
  await promise.wait(100)

  const { ydoc: loaded } = await client.getDoc(room, docid)
  t.assert(loaded.getMap().get('counter') === 49, 'Final value correct')
}

/**
 * Test concurrent document access
 * @param {t.TestCase} tc
 */
export const testConcurrentDocumentAccess = async tc => {
  const { client, room, docid } = await createTestCase(tc)

  // Create multiple documents simultaneously
  const docs = []
  for (let i = 0; i < 5; i++) {
    const ydoc = new Y.Doc()
    ydoc.on('update', update => {
      const m = encoding.encode(encoder => {
        encoding.writeVarUint(encoder, 0)
        encoding.writeVarUint(encoder, 2)
        encoding.writeVarUint8Array(encoder, update)
      })
      client.addMessage(room, docid, Buffer.from(m))
    })
    docs.push(ydoc)
  }

  // Concurrent updates
  docs.forEach((doc, i) => {
    doc.getMap().set(`doc${i}`, `value${i}`)
  })

  await promise.wait(100)

  const { ydoc: loaded } = await client.getDoc(room, docid)
  for (let i = 0; i < 5; i++) {
    t.assert(loaded.getMap().get(`doc${i}`) === `value${i}`, `Concurrent doc ${i} correct`)
  }
}

/**
 * Test array operations
 * @param {t.TestCase} tc
 */
export const testArrayOperations = async tc => {
  const { client, ydoc, room, docid } = await createTestCase(tc)

  const arr = ydoc.getArray('items')
  arr.push(['item1', 'item2', 'item3'])
  arr.insert(1, ['inserted'])
  arr.delete(2, 1)

  const { ydoc: loaded } = await client.getDoc(room, docid)
  const loadedArr = loaded.getArray('items')
  t.assert(loadedArr.length === 3, 'Array length correct')
  t.assert(loadedArr.get(0) === 'item1', 'First item correct')
  t.assert(loadedArr.get(1) === 'inserted', 'Inserted item correct')
  t.assert(loadedArr.get(2) === 'item3', 'Third item correct')
}

/**
 * Test text operations with formatting
 * @param {t.TestCase} tc
 */
export const testTextOperations = async tc => {
  const { client, ydoc, room, docid } = await createTestCase(tc)

  const text = ydoc.getText('content')
  text.insert(0, 'Hello World')
  text.format(0, 5, { bold: true })
  text.insert(5, ' Beautiful')

  const { ydoc: loaded } = await client.getDoc(room, docid)
  const loadedText = loaded.getText('content')
  t.assert(loadedText.toString() === 'Hello Beautiful World', 'Text content correct')
}

/**
 * Test empty document retrieval
 * @param {t.TestCase} tc
 */
export const testEmptyDocumentRetrieval = async tc => {
  const { client } = await createTestCase(tc)

  const { ydoc, docChanged, storeReferences } = await client.getDoc('empty-room', 'empty-doc')
  t.assert(ydoc instanceof Y.Doc, 'Returns Y.Doc for empty room')
  t.assert(docChanged === false, 'Empty doc not marked as changed')
  t.assert(storeReferences === null, 'No store references for empty doc')
}

/**
 * Test binary data in document
 * @param {t.TestCase} tc
 */
export const testBinaryData = async tc => {
  const { client, ydoc, room, docid } = await createTestCase(tc)

  const binaryData = new Uint8Array([0, 1, 2, 255, 254, 253])
  ydoc.getMap().set('binary', binaryData)

  const { ydoc: loaded } = await client.getDoc(room, docid)
  const loadedBinary = loaded.getMap().get('binary')
  t.assert(loadedBinary instanceof Uint8Array, 'Binary data is Uint8Array')
  t.assert(loadedBinary.length === binaryData.length, 'Binary length correct')
  for (let i = 0; i < binaryData.length; i++) {
    t.assert(loadedBinary[i] === binaryData[i], `Binary byte ${i} correct`)
  }
}

/**
 * Test null and undefined values
 * @param {t.TestCase} tc
 */
export const testNullUndefinedValues = async tc => {
  const { client, ydoc, room, docid } = await createTestCase(tc)

  const map = ydoc.getMap()
  map.set('nullValue', null)
  map.set('number', 0)
  map.set('emptyString', '')
  map.set('false', false)

  const { ydoc: loaded } = await client.getDoc(room, docid)
  const loadedMap = loaded.getMap()
  t.assert(loadedMap.get('nullValue') === null, 'null preserved')
  t.assert(loadedMap.get('number') === 0, '0 preserved')
  t.assert(loadedMap.get('emptyString') === '', 'empty string preserved')
  t.assert(loadedMap.get('false') === false, 'false preserved')
}
