import * as Y from 'yjs'
import * as t from 'lib0/testing'
import * as api from '../src/api.js'
import * as encoding from 'lib0/encoding'
import * as promise from 'lib0/promise'
import * as redis from 'redis'
import * as protocol from '../src/protocol.js'
import { prevClients, store } from './utils.js'

const redisPrefix = 'ytests'

/**
 * @param {t.TestCase} tc
 */
const createTestCase = async tc => {
  await promise.all(prevClients.map(c => c.destroy()))
  prevClients.length = 0
  const redisClient = redis.createClient({ url: api.redisUrl })
  await redisClient.connect()
  // flush existing content
  const keysToDelete = await redisClient.keys(redisPrefix + ':*')
  keysToDelete.length > 0 && await redisClient.del(keysToDelete)
  await redisClient.quit()
  const client = await api.createApiClient(store, redisPrefix)
  prevClients.push(client)
  const room = tc.testName
  const docid = 'main'
  const stream = api.computeRedisRoomStreamName(room, docid, redisPrefix)
  const ydoc = new Y.Doc()
  ydoc.on('update', update => {
    const m = encoding.encode(encoder => {
      encoding.writeVarUint(encoder, 0) // sync protocol
      encoding.writeVarUint(encoder, 2) // update message
      encoding.writeVarUint8Array(encoder, update)
    })
    client.addMessage(room, docid, Buffer.from(m))
  })
  return {
    client,
    ydoc,
    room,
    docid,
    stream
  }
}

const createWorker = async () => {
  const worker = await api.createWorker(store, redisPrefix, {})
  worker.client.redisMinMessageLifetime = 10000
  worker.client.redisTaskDebounce = 5000
  prevClients.push(worker.client)
  return worker
}

/**
 * @param {t.TestCase} tc
 */
export const testUpdateApiMessages = async tc => {
  const { client, ydoc, room, docid } = await createTestCase(tc)
  ydoc.getMap().set('key1', 'val1')
  ydoc.getMap().set('key2', 'val2')
  const { ydoc: loadedDoc } = await client.getDoc(room, docid)
  t.compare(loadedDoc.getMap().get('key1'), 'val1')
  t.compare(loadedDoc.getMap().get('key2'), 'val2')
}

/**
 * @param {t.TestCase} tc
 */
export const testWorker = async tc => {
  const { client, ydoc, stream, room, docid } = await createTestCase(tc)
  await createWorker()
  ydoc.getMap().set('key1', 'val1')
  ydoc.getMap().set('key2', 'val2')
  let streamexists = true
  while (streamexists) {
    streamexists = (await client.redis.exists(stream)) === 1
  }
  const { ydoc: loadedDoc } = await client.getDoc(room, docid)
  t.assert(loadedDoc.getMap().get('key1') === 'val1')
  t.assert(loadedDoc.getMap().get('key2') === 'val2')
  let workertasksEmpty = false
  while (!workertasksEmpty) {
    workertasksEmpty = await client.redis.xLen(client.redisWorkerStreamName) === 0
  }
}

/**
 * Test isSmallerRedisId comparison function
 * @param {t.TestCase} _tc
 */
export const testIsSmallerRedisId = _tc => {
  // Basic comparisons
  t.assert(api.isSmallerRedisId('1-0', '2-0') === true, '1-0 < 2-0')
  t.assert(api.isSmallerRedisId('2-0', '1-0') === false, '2-0 not < 1-0')
  t.assert(api.isSmallerRedisId('1-0', '1-0') === false, '1-0 not < 1-0 (equal)')

  // Sub-sequence comparisons
  t.assert(api.isSmallerRedisId('1-0', '1-1') === true, '1-0 < 1-1')
  t.assert(api.isSmallerRedisId('1-5', '1-10') === true, '1-5 < 1-10')
  t.assert(api.isSmallerRedisId('1-10', '1-5') === false, '1-10 not < 1-5')

  // Large numbers
  t.assert(api.isSmallerRedisId('1000000000000-0', '1000000000001-0') === true, 'large numbers work')

  // Default sub-sequence (no dash)
  t.assert(api.isSmallerRedisId('1', '2') === true, '1 < 2 (no sub-sequence)')
  t.assert(api.isSmallerRedisId('1', '1-1') === true, '1 < 1-1')
}

/**
 * Test computeRedisRoomStreamName encoding
 * @param {t.TestCase} _tc
 */
export const testComputeRedisRoomStreamName = _tc => {
  // Basic encoding
  const name1 = api.computeRedisRoomStreamName('myroom', 'mydoc', 'prefix')
  t.assert(name1 === 'prefix:room:myroom:mydoc', 'basic stream name')

  // Special characters should be URL encoded
  const name2 = api.computeRedisRoomStreamName('room/with/slashes', 'doc:with:colons', 'test')
  t.assert(name2.includes('room%2Fwith%2Fslashes'), 'slashes are encoded')
  t.assert(name2.includes('doc%3Awith%3Acolons'), 'colons are encoded')

  // Unicode characters
  const name3 = api.computeRedisRoomStreamName('日本語', 'émoji🎉', 'prefix')
  t.assert(name3.startsWith('prefix:room:'), 'unicode room name encoded')
}

/**
 * Test getDoc with non-existent document
 * @param {t.TestCase} tc
 */
export const testGetDocNonExistent = async tc => {
  const { client } = await createTestCase(tc)
  const { ydoc, awareness, redisLastId, storeReferences, docChanged } = await client.getDoc('nonexistent-room', 'nonexistent-doc')

  t.assert(ydoc instanceof Y.Doc, 'Returns a Y.Doc')
  t.assert(redisLastId === '0', 'Last ID is 0 for non-existent doc')
  t.assert(storeReferences === null, 'No store references')
  t.assert(docChanged === false, 'Doc not changed')
  t.assert(awareness.getLocalState() === null, 'Awareness local state is null')
}

/**
 * Test addMessage with various message types
 * @param {t.TestCase} tc
 */
export const testAddMessageTypes = async tc => {
  const { client, room, docid } = await createTestCase(tc)

  // Test sync update message
  const syncUpdate = encoding.encode(encoder => {
    encoding.writeVarUint(encoder, protocol.messageSync)
    encoding.writeVarUint(encoder, protocol.messageSyncUpdate)
    encoding.writeVarUint8Array(encoder, new Uint8Array([1, 2, 3, 4]))
  })
  await client.addMessage(room, docid, Buffer.from(syncUpdate))

  // Test sync step 2 message (should be converted to update)
  const syncStep2 = encoding.encode(encoder => {
    encoding.writeVarUint(encoder, protocol.messageSync)
    encoding.writeVarUint(encoder, protocol.messageSyncStep2)
    encoding.writeVarUint8Array(encoder, new Uint8Array([5, 6, 7, 8]))
  })
  await client.addMessage(room, docid, Buffer.from(syncStep2))

  // Verify messages were added
  const stream = api.computeRedisRoomStreamName(room, docid, redisPrefix)
  const streamLen = await client.redis.xLen(stream)
  t.assert(streamLen === 2, 'Both messages were added')
}

/**
 * Test addMessage with empty sync step 2 (should be skipped)
 * @param {t.TestCase} tc
 */
export const testAddMessageEmptySyncStep2 = async tc => {
  const { client, room, docid } = await createTestCase(tc)

  // Empty sync step 2 (less than 4 bytes)
  const emptySyncStep2 = new Uint8Array([protocol.messageSync, protocol.messageSyncStep2, 0])
  await client.addMessage(room, docid, Buffer.from(emptySyncStep2))

  // Verify no message was added
  const stream = api.computeRedisRoomStreamName(room, docid, redisPrefix)
  const streamExists = await client.redis.exists(stream)
  t.assert(streamExists === 0, 'Empty sync step 2 was not added')
}

/**
 * Test getMessages with empty streams array
 * @param {t.TestCase} tc
 */
export const testGetMessagesEmpty = async tc => {
  const { client } = await createTestCase(tc)
  const startTime = Date.now()
  const messages = await client.getMessages([])
  const elapsed = Date.now() - startTime

  t.assert(messages.length === 0, 'Empty array returned')
  t.assert(elapsed >= 40, 'Waited at least ~50ms')
}

/**
 * Test multiple documents in the same room
 * @param {t.TestCase} tc
 */
export const testMultipleDocsInRoom = async tc => {
  const { client, ydoc, room } = await createTestCase(tc)

  // Create doc1
  ydoc.getMap().set('doc1key', 'doc1value')

  // Create a second document in the same room
  const ydoc2 = new Y.Doc()
  ydoc2.on('update', update => {
    const m = encoding.encode(encoder => {
      encoding.writeVarUint(encoder, 0)
      encoding.writeVarUint(encoder, 2)
      encoding.writeVarUint8Array(encoder, update)
    })
    client.addMessage(room, 'doc2', Buffer.from(m))
  })
  ydoc2.getMap().set('doc2key', 'doc2value')

  // Retrieve both docs
  const { ydoc: loaded1 } = await client.getDoc(room, 'main')
  const { ydoc: loaded2 } = await client.getDoc(room, 'doc2')

  t.assert(loaded1.getMap().get('doc1key') === 'doc1value', 'Doc1 data correct')
  t.assert(loaded2.getMap().get('doc2key') === 'doc2value', 'Doc2 data correct')
  t.assert(loaded1.getMap().get('doc2key') === undefined, 'Docs are isolated')
}

/**
 * Test worker with update callback
 * @param {t.TestCase} tc
 */
export const testWorkerWithCallback = async tc => {
  const { client, ydoc, room, docid } = await createTestCase(tc)

  let callbackCalled = false
  let callbackRoom = ''
  let callbackDocContent = ''

  const worker = await api.createWorker(store, redisPrefix, {
    updateCallback: async (r, doc) => {
      callbackCalled = true
      callbackRoom = r
      callbackDocContent = doc.getMap().get('callbackTest')
    }
  })
  worker.client.redisMinMessageLifetime = 10000
  worker.client.redisTaskDebounce = 5000
  prevClients.push(worker.client)

  // Add some data
  ydoc.getMap().set('callbackTest', 'callbackValue')

  // Wait for worker to process
  const stream = api.computeRedisRoomStreamName(room, docid, redisPrefix)
  let streamExists = true
  const maxWait = Date.now() + 30000
  while (streamExists && Date.now() < maxWait) {
    streamExists = (await client.redis.exists(stream)) === 1
    await promise.wait(100)
  }

  t.assert(callbackCalled, 'Callback was called')
  t.assert(callbackRoom === room, 'Callback received correct room')
  t.assert(callbackDocContent === 'callbackValue', 'Callback received correct doc')
}

/**
 * Test API client destruction
 * @param {t.TestCase} tc
 */
export const testApiDestroy = async tc => {
  const client = await api.createApiClient(store, redisPrefix + '-destroy-test')
  t.assert(client._destroyed === false, 'Client not destroyed initially')

  await client.destroy()
  t.assert(client._destroyed === true, 'Client marked as destroyed')
}
