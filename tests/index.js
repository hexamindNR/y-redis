/* eslint-env node */

import * as api from './api.tests.js'
import * as auth from './auth.tests.js'
import * as ws from './ws.tests.js'
import * as storage from './storage.tests.js'
import * as protocol from './protocol.tests.js'
import * as subscriber from './subscriber.tests.js'
import * as edgeCases from './edge-cases.tests.js'
import { runTests } from 'lib0/testing'

runTests({
  protocol,
  storage,
  api,
  subscriber,
  auth,
  ws,
  edgeCases
}).then(success => {
  process.exit(success ? 0 : 1)
})
