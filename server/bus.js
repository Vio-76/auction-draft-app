/**
 * Tiny event bus. Any successful state mutation calls markChanged(); the WebSocket hub
 * (ws.js) listens for 'changed' and re-pushes fresh payloads to every connected client.
 * This decouples the logic/action layer from the transport.
 */
const { EventEmitter } = require('node:events');

const bus = new EventEmitter();
function markChanged() { bus.emit('changed'); }

module.exports = { bus, markChanged };
