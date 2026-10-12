// Wire format of the room websocket, shared by the service and every client (browser, tests).
// One binary frame = one message: a varuint type, then
//   SYNC       a y-protocols sync message (step 1, step 2 or update)
//   AWARENESS  a y-protocols awareness update
//   CONTROL    a JSON object (utf-8): hello, state, notice, conflict, ack, reset, error
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';

export const MSG_SYNC = 0;
export const MSG_AWARENESS = 1;
export const MSG_CONTROL = 2;

export function control(obj) {
  const e = encoding.createEncoder();
  encoding.writeVarUint(e, MSG_CONTROL);
  encoding.writeVarString(e, JSON.stringify(obj));
  return encoding.toUint8Array(e);
}

export function awarenessMessage(update) {
  const e = encoding.createEncoder();
  encoding.writeVarUint(e, MSG_AWARENESS);
  encoding.writeVarUint8Array(e, update);
  return encoding.toUint8Array(e);
}

export { encoding, decoding };
