// hooks/stop.js
// Fires when the agent session stops. Future: session-end consolidation
// (extract experiences from the just-finished session, prompt review).
"use strict";
const { emitEmpty } = require("./lib/shared");
emitEmpty();
