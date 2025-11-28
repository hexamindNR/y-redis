import * as t from 'lib0/testing'
import * as Y from 'yjs'
import * as encoding from 'lib0/encoding'
import * as promise from 'lib0/promise'
import * as redis from 'redis'
import * as api from '../src/api.js'
import { createSubscriber } from '../src/subscriber.js'
import { prevClients, store } from './utils.js'

const redisPrefix = 'ytests-subscriber'

/**
 * Clean up Redis before each test
 */
const cleanup = async () => {
  await promise.all(prevClients.map(c => c.destroy()))
  prevClients.length = 0
  const redisClient = redis.createClient({ url: api.redisUrl })
  await redisClient.connect()
  const keysToDelete = await redisClient.keys(redisPrefix + ':*')
  keysToDelete.length > 0 && await redisClient.del(keysToDelete)
  await redisClient.quit()
}

/**
 * Test basic subscribe/unsubscribe
 * @param {t.TestCase} _tc
 */
export const testSubscribeUnsubscribe = async _tc => {
  await cleanup()
  const subscriber = await createSubscriber(store, redisPrefix)
  prevClients.push(subscriber.client)

  const stream = 'test-stream'
  const handler = () => {}

  // Subscribe
  const { redisId } = subscriber.subscribe(stream, handler)
  t.assert(redisId === '0', 'Initial redis ID is 0')
  t.assert(subscriber.subs.has(stream), 'Stream is in subs map')
  t.assert(subscriber.subs.get(stream)?.fs.has(handler), 'Handler is registered')

  // Unsubscribe
  subscriber.unsubscribe(stream, handler)
  t.assert(!subscriber.subs.has(stream), 'Stream removed after unsubscribe')
}

/**
 * Test multiple handlers on same stream
 * @param {t.TestCase} _tc
 */
export const testMultipleHandlers = async _tc => {
  await cleanup()
  const subscriber = await createSubscriber(store, redisPrefix)
  prevClients.push(subscriber.client)

  const stream = 'multi-handler-stream'
  const handler1 = () => {}
  const handler2 = () => {}

  subscriber.subscribe(stream, handler1)
  subscriber.subscribe(stream, handler2)

  const sub = subscriber.subs.get(stream)
  t.assert(sub?.fs.size === 2, 'Both handlers registered')

  // Unsubscribe one handler
  subscriber.unsubscribe(stream, handler1)
  t.assert(subscriber.subs.has(stream), 'Stream still exists with one handler')
  t.assert(subscriber.subs.get(stream)?.fs.size === 1, 'One handler remaining')

  // Unsubscribe second handler
  subscriber.unsubscribe(stream, handler2)
  t.assert(!subscriber.subs.has(stream), 'Stream removed after all handlers unsubscribed')
}

/**
 * Test ensureSubId updates nextId correctly
 * @param {t.TestCase} _tc
 */
export const testEnsureSubId = async _tc => {
  await cleanup()
  const subscriber = await createSubscriber(store, redisPrefix)
  prevClients.push(subscriber.client)

  const stream = 'ensure-sub-id-stream'
  const handler = () => {}

  subscriber.subscribe(stream, handler)

  // Manually set the current ID to simulate progress
  const sub = subscriber.subs.get(stream)
  if (sub) {
    sub.id = '100-0'
  }

  // Try to set a smaller ID - should update nextId
  subscriber.ensureSubId(stream, '50-0')
  t.assert(subscriber.subs.get(stream)?.nextId === '50-0', 'nextId set for smaller ID')

  // Try to set a larger ID - should not update nextId
  subscriber.ensureSubId(stream, '150-0')
  t.assert(subscriber.subs.get(stream)?.nextId === '50-0', 'nextId unchanged for larger ID')
}

/**
 * Test subscriber receives messages
 * @param {t.TestCase} _tc
 */
export const testSubscriberReceivesMessages = async _tc => {
  await cleanup()

  // Create an API client to publish messages
  const apiClient = await api.createApiClient(store, redisPrefix)
  prevClients.push(apiClient)

  // Create subscriber
  const subscriber = await createSubscriber(store, redisPrefix)
  prevClients.push(subscriber.client)

  const room = 'test-room'
  const docid = 'test-doc'
  const stream = api.computeRedisRoomStreamName(room, docid, redisPrefix)

  /**
   * @type {Array<{stream: string, messages: Array<Uint8Array>}>}
   */
  const receivedMessages = []

  subscriber.subscribe(stream, (s, msgs) => {
    receivedMessages.push({ stream: s, messages: msgs })
  })

  // Publish a message
  const ydoc = new Y.Doc()
  ydoc.getMap().set('test', 'value')
  const update = Y.encodeStateAsUpdate(ydoc)
  const message = encoding.encode(encoder => {
    encoding.writeVarUint(encoder, 0) // sync
    encoding.writeVarUint(encoder, 2) // update
    encoding.writeVarUint8Array(encoder, update)
  })
  await apiClient.addMessage(room, docid, Buffer.from(message))

  // Wait for message to be received
  const maxWait = Date.now() + 5000
  while (receivedMessages.length === 0 && Date.now() < maxWait) {
    await promise.wait(100)
  }

  t.assert(receivedMessages.length > 0, 'Received at least one message batch')
  t.assert(receivedMessages[0].stream === stream, 'Received on correct stream')
}

/**
 * Test subscriber destroy
 * @param {t.TestCase} _tc
 */
export const testSubscriberDestroy = async _tc => {
  await cleanup()
  const subscriber = await createSubscriber(store, redisPrefix)

  const stream = 'destroy-test-stream'
  subscriber.subscribe(stream, () => {})

  t.assert(subscriber.client._destroyed === false, 'Client not destroyed initially')

  subscriber.destroy()
  t.assert(subscriber.client._destroyed === true, 'Client destroyed after destroy()')
}

/**
 * Test unsubscribe non-existent handler (should not throw)
 * @param {t.TestCase} _tc
 */
export const testUnsubscribeNonExistent = async _tc => {
  await cleanup()
  const subscriber = await createSubscriber(store, redisPrefix)
  prevClients.push(subscriber.client)

  const handler = () => {}

  // Unsubscribe from non-existent stream - should not throw
  subscriber.unsubscribe('non-existent-stream', handler)
  t.assert(true, 'No error thrown for non-existent stream')

  // Subscribe then unsubscribe different handler
  subscriber.subscribe('test-stream', () => {})
  subscriber.unsubscribe('test-stream', handler) // Different handler
  t.assert(subscriber.subs.has('test-stream'), 'Stream still exists (different handler)')
}

/**
 * Test ensureSubId on non-existent stream (should not throw)
 * @param {t.TestCase} _tc
 */
export const testEnsureSubIdNonExistent = async _tc => {
  await cleanup()
  const subscriber = await createSubscriber(store, redisPrefix)
  prevClients.push(subscriber.client)

  // Should not throw
  subscriber.ensureSubId('non-existent-stream', '100-0')
  t.assert(true, 'No error for ensureSubId on non-existent stream')
}
