import * as t from 'lib0/testing'
import * as Y from 'yjs'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import * as awarenessProtocol from 'y-protocols/awareness'
import * as protocol from '../src/protocol.js'

/**
 * Helper to create a sync update message
 * @param {Uint8Array} update
 * @returns {Uint8Array}
 */
const createSyncUpdateMessage = update => encoding.encode(encoder => {
  encoding.writeVarUint(encoder, protocol.messageSync)
  encoding.writeVarUint(encoder, protocol.messageSyncUpdate)
  encoding.writeVarUint8Array(encoder, update)
})

/**
 * Helper to create an awareness message
 * @param {awarenessProtocol.Awareness} awareness
 * @param {Array<number>} clients
 * @returns {Uint8Array}
 */
const createAwarenessMessage = (awareness, clients) => encoding.encode(encoder => {
  encoding.writeVarUint(encoder, protocol.messageAwareness)
  encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(awareness, clients))
})

/**
 * @param {t.TestCase} _tc
 */
export const testMergeMessagesEmpty = _tc => {
  const result = protocol.mergeMessages([])
  t.assert(result.length === 0, 'Empty array returns empty array')
}

/**
 * @param {t.TestCase} _tc
 */
export const testMergeMessagesSingleMessage = _tc => {
  const ydoc = new Y.Doc()
  ydoc.getMap().set('key', 'value')
  const update = Y.encodeStateAsUpdate(ydoc)
  const message = createSyncUpdateMessage(update)

  const result = protocol.mergeMessages([message])
  t.assert(result.length === 1, 'Single message returns single message')
  t.compare(result[0], message, 'Single message is unchanged')
}

/**
 * @param {t.TestCase} _tc
 */
export const testMergeMultipleSyncUpdates = _tc => {
  // Create updates from the same document (simulating incremental updates)
  const ydoc = new Y.Doc()

  // First update
  ydoc.getMap().set('key1', 'value1')
  const update1 = Y.encodeStateAsUpdate(ydoc)

  // Second update (incremental)
  ydoc.getMap().set('key2', 'value2')
  const update2 = Y.encodeStateAsUpdate(ydoc)

  const messages = [
    createSyncUpdateMessage(update1),
    createSyncUpdateMessage(update2)
  ]

  const result = protocol.mergeMessages(messages)
  // Result may contain sync + awareness message (awareness from internal Awareness object)
  t.assert(result.length >= 1, 'At least one message returned')

  // Find the sync message
  const syncMessage = result.find(m => m[0] === protocol.messageSync)
  t.assert(syncMessage !== undefined, 'Sync message present')

  // Verify the merged message contains both updates
  const decoder = decoding.createDecoder(syncMessage)
  const messageType = decoding.readVarUint(decoder)
  t.assert(messageType === protocol.messageSync, 'Message type is sync')

  const syncType = decoding.readVarUint(decoder)
  t.assert(syncType === protocol.messageSyncUpdate, 'Sync type is update')

  const mergedUpdate = decoding.readVarUint8Array(decoder)
  const verifyDoc = new Y.Doc()
  Y.applyUpdate(verifyDoc, mergedUpdate)
  t.assert(verifyDoc.getMap().get('key1') === 'value1', 'First update applied')
  t.assert(verifyDoc.getMap().get('key2') === 'value2', 'Second update applied')
}

/**
 * @param {t.TestCase} _tc
 */
export const testMergeAwarenessMessages = _tc => {
  const ydoc1 = new Y.Doc()
  const awareness1 = new awarenessProtocol.Awareness(ydoc1)
  awareness1.setLocalState({ user: 'user1', cursor: { x: 10, y: 20 } })

  const ydoc2 = new Y.Doc()
  const awareness2 = new awarenessProtocol.Awareness(ydoc2)
  awareness2.setLocalState({ user: 'user2', cursor: { x: 30, y: 40 } })

  const messages = [
    createAwarenessMessage(awareness1, [ydoc1.clientID]),
    createAwarenessMessage(awareness2, [ydoc2.clientID])
  ]

  const result = protocol.mergeMessages(messages)
  t.assert(result.length === 1, 'Awareness messages merge into one')

  // Verify the merged awareness contains both states
  const decoder = decoding.createDecoder(result[0])
  const messageType = decoding.readVarUint(decoder)
  t.assert(messageType === protocol.messageAwareness, 'Message type is awareness')

  const awarenessUpdate = decoding.readVarUint8Array(decoder)
  const verifyDoc = new Y.Doc()
  const verifyAwareness = new awarenessProtocol.Awareness(verifyDoc)
  verifyAwareness.setLocalState(null) // Clear local state to only count received states
  awarenessProtocol.applyAwarenessUpdate(verifyAwareness, awarenessUpdate, null)

  // Check that states from both ydoc1 and ydoc2 are present
  t.assert(verifyAwareness.states.has(ydoc1.clientID), 'First awareness state present')
  t.assert(verifyAwareness.states.has(ydoc2.clientID), 'Second awareness state present')
}

/**
 * @param {t.TestCase} _tc
 */
export const testMergeMixedMessageTypes = _tc => {
  // Create a sync update
  const ydoc = new Y.Doc()
  ydoc.getMap().set('data', 'test')
  const update = Y.encodeStateAsUpdate(ydoc)
  const syncMessage = createSyncUpdateMessage(update)

  // Create an awareness message
  const awDoc = new Y.Doc()
  const awareness = new awarenessProtocol.Awareness(awDoc)
  awareness.setLocalState({ user: 'testuser' })
  const awarenessMessage = createAwarenessMessage(awareness, [awDoc.clientID])

  const messages = [syncMessage, awarenessMessage]
  const result = protocol.mergeMessages(messages)

  t.assert(result.length === 2, 'Mixed messages produce two results (one sync, one awareness)')

  // Verify one is sync, one is awareness
  const types = result.map(m => decoding.readVarUint(decoding.createDecoder(m)))
  t.assert(types.includes(protocol.messageSync), 'Contains sync message')
  t.assert(types.includes(protocol.messageAwareness), 'Contains awareness message')
}

/**
 * @param {t.TestCase} _tc
 */
export const testMergeMessagesHandlesMalformed = _tc => {
  // Create a valid message
  const ydoc = new Y.Doc()
  ydoc.getMap().set('key', 'value')
  const update = Y.encodeStateAsUpdate(ydoc)
  const validMessage = createSyncUpdateMessage(update)

  // Create a malformed message (just random bytes)
  const malformedMessage = new Uint8Array([255, 255, 255])

  const messages = [validMessage, malformedMessage]

  // Should not throw - malformed messages should be logged and skipped
  const result = protocol.mergeMessages(messages)
  t.assert(result.length >= 1, 'Valid message still processed despite malformed one')
}

/**
 * @param {t.TestCase} _tc
 */
export const testEncodeSyncStep1 = _tc => {
  const ydoc = new Y.Doc()
  ydoc.getMap().set('test', 123)
  const sv = Y.encodeStateVector(ydoc)

  const encoded = protocol.encodeSyncStep1(sv)
  const decoder = decoding.createDecoder(encoded)

  const messageType = decoding.readVarUint(decoder)
  t.assert(messageType === protocol.messageSync, 'Message type is sync')

  const syncType = decoding.readVarUint(decoder)
  t.assert(syncType === protocol.messageSyncStep1, 'Sync type is step1')

  const decodedSv = decoding.readVarUint8Array(decoder)
  t.compare(new Uint8Array(decodedSv), new Uint8Array(sv), 'State vector matches')
}

/**
 * @param {t.TestCase} _tc
 */
export const testEncodeSyncStep2 = _tc => {
  const ydoc = new Y.Doc()
  ydoc.getMap().set('data', 'content')
  const diff = Y.encodeStateAsUpdate(ydoc)

  const encoded = protocol.encodeSyncStep2(diff)
  const decoder = decoding.createDecoder(encoded)

  const messageType = decoding.readVarUint(decoder)
  t.assert(messageType === protocol.messageSync, 'Message type is sync')

  const syncType = decoding.readVarUint(decoder)
  t.assert(syncType === protocol.messageSyncStep2, 'Sync type is step2')

  const decodedDiff = decoding.readVarUint8Array(decoder)
  t.compare(new Uint8Array(decodedDiff), new Uint8Array(diff), 'Diff matches')
}

/**
 * @param {t.TestCase} _tc
 */
export const testEncodeAwarenessUpdate = _tc => {
  const ydoc = new Y.Doc()
  const awareness = new awarenessProtocol.Awareness(ydoc)
  awareness.setLocalState({ name: 'TestUser', color: '#ff0000' })

  const encoded = protocol.encodeAwarenessUpdate(awareness, [ydoc.clientID])
  const decoder = decoding.createDecoder(encoded)

  const messageType = decoding.readVarUint(decoder)
  t.assert(messageType === protocol.messageAwareness, 'Message type is awareness')

  const awarenessData = decoding.readVarUint8Array(decoder)
  t.assert(awarenessData.length > 0, 'Awareness data is present')

  // Verify by applying to a new awareness
  const verifyDoc = new Y.Doc()
  const verifyAwareness = new awarenessProtocol.Awareness(verifyDoc)
  awarenessProtocol.applyAwarenessUpdate(verifyAwareness, awarenessData, null)

  const state = verifyAwareness.getStates().get(ydoc.clientID)
  t.assert(state?.name === 'TestUser', 'Name matches')
  t.assert(state?.color === '#ff0000', 'Color matches')
}

/**
 * @param {t.TestCase} _tc
 */
export const testEncodeAwarenessUserDisconnected = _tc => {
  const clientid = 12345
  const lastClock = 5

  const encoded = protocol.encodeAwarenessUserDisconnected(clientid, lastClock)
  const decoder = decoding.createDecoder(encoded)

  const messageType = decoding.readVarUint(decoder)
  t.assert(messageType === protocol.messageAwareness, 'Message type is awareness')

  const awarenessData = decoding.readVarUint8Array(decoder)

  // Decode the inner awareness update
  const innerDecoder = decoding.createDecoder(awarenessData)
  const changeCount = decoding.readVarUint(innerDecoder)
  t.assert(changeCount === 1, 'One change encoded')

  const decodedClientId = decoding.readVarUint(innerDecoder)
  t.assert(decodedClientId === clientid, 'Client ID matches')

  const clock = decoding.readVarUint(innerDecoder)
  t.assert(clock === lastClock + 1, 'Clock is incremented')

  const stateJson = decoding.readVarString(innerDecoder)
  t.assert(stateJson === 'null', 'State is null (disconnected)')
}

/**
 * @param {t.TestCase} _tc
 */
export const testMessageConstants = _tc => {
  // Verify message type constants match expected values
  t.assert(protocol.messageSync === 0, 'messageSync is 0')
  t.assert(protocol.messageAwareness === 1, 'messageAwareness is 1')
  t.assert(protocol.messageAuth === 2, 'messageAuth is 2')
  t.assert(protocol.messageQueryAwareness === 3, 'messageQueryAwareness is 3')

  // Verify sync message type constants
  t.assert(protocol.messageSyncStep1 === 0, 'messageSyncStep1 is 0')
  t.assert(protocol.messageSyncStep2 === 1, 'messageSyncStep2 is 1')
  t.assert(protocol.messageSyncUpdate === 2, 'messageSyncUpdate is 2')
}
