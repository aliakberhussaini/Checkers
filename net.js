/* NetCheckers — code-based multiplayer signaling for Neon Checkers.
 *
 * Single-player and its engine/AI stay 100% offline (SPEC.md). Real-time
 * play between two humans who don't know each other's address inherently
 * needs SOME rendezvous point; the actual move traffic still goes directly
 * peer-to-peer over a WebRTC data channel (native browser API — no library
 * needed for gameplay itself). PeerJS's free public broker is used only to
 * turn a 4-digit code into that first connection; once `onOpen` fires, the
 * broker is no longer involved.
 *
 * The prefix below namespaces our room codes within PeerJS's shared global
 * ID space; a 4-digit code (10,000 values) is not collision-proof against
 * unrelated PeerJS users worldwide, only unlikely in practice for a casual
 * feature like this.
 */
(function (global) {
  'use strict';

  var ID_PREFIX = 'neonckr-';

  function makeCode() {
    return String(Math.floor(1000 + Math.random() * 9000));
  }

  function idFor(code) {
    return ID_PREFIX + String(code);
  }

  function isValidCode(code) {
    return /^[0-9]{4}$/.test(String(code == null ? '' : code));
  }

  function sanitizeName(name) {
    var n = (typeof name === 'string') ? name.trim().slice(0, 18) : '';
    return n || 'Player';
  }

  /* Defensive check applied to every incoming 'move' message: reject
   * anything that isn't byte-for-byte one of the current position's own
   * legal moves, so a buggy or hostile peer can never desync or cheat. */
  function isLegalWireMove(move, state, Engine) {
    if (!move || !Array.isArray(move.from) || !Array.isArray(move.path) ||
        !Array.isArray(move.captures) || !state || !Engine) {
      return false;
    }
    var wire = JSON.stringify([move.from, move.path, move.captures]);
    var legal = Engine.legalMoves(state);
    for (var i = 0; i < legal.length; i++) {
      if (JSON.stringify([legal[i].from, legal[i].path, legal[i].captures]) === wire) {
        return legal[i]; // return the engine's own object, never the wire copy
      }
    }
    return false;
  }

  /* Thin PeerJS wrapper. Not unit-tested (needs a live browser + network);
   * covered by manual two-browser verification instead. Every handler in
   * `handlers` is optional: onOpen(theirName), onPeerMessage(msg),
   * onPeerClose(), onError(message).
   */
  function Session(handlers) {
    this.handlers = handlers || {};
    this.peer = null;
    this.conn = null;
    this.myName = '';
    this._sentHello = false;
  }

  Session.prototype._wireConn = function (conn) {
    var self = this;
    this.conn = conn;
    conn.on('open', function () { self._sendHello(); });
    conn.on('data', function (msg) {
      if (msg && msg.type === 'hello') {
        if (self.handlers.onOpen) self.handlers.onOpen(sanitizeName(msg.name));
        return;
      }
      if (self.handlers.onPeerMessage) self.handlers.onPeerMessage(msg);
    });
    conn.on('close', function () { if (self.handlers.onPeerClose) self.handlers.onPeerClose(); });
    conn.on('error', function (err) {
      if (self.handlers.onError) self.handlers.onError(String((err && err.message) || err));
    });
  };

  Session.prototype._sendHello = function () {
    if (this._sentHello) return;
    this._sentHello = true;
    this.send({ type: 'hello', name: this.myName });
  };

  Session.prototype.host = function (code, myName) {
    this.myName = sanitizeName(myName);
    var self = this;
    var peer = new global.Peer(idFor(code), { debug: 0 });
    this.peer = peer;
    peer.on('connection', function (conn) { self._wireConn(conn); });
    peer.on('error', function (err) {
      var msg = (err && err.type === 'unavailable-id')
        ? 'that code is already in use — try again'
        : String((err && err.message) || err);
      if (self.handlers.onError) self.handlers.onError(msg);
    });
  };

  Session.prototype.join = function (code, myName) {
    this.myName = sanitizeName(myName);
    var self = this;
    var peer = new global.Peer(undefined, { debug: 0 });
    this.peer = peer;
    peer.on('open', function () {
      var conn = peer.connect(idFor(code), { reliable: true });
      self._wireConn(conn);
    });
    peer.on('error', function (err) {
      var msg = (err && err.type === 'peer-unavailable')
        ? 'no game found with that code'
        : String((err && err.message) || err);
      if (self.handlers.onError) self.handlers.onError(msg);
    });
  };

  Session.prototype.send = function (msg) {
    if (this.conn && this.conn.open) {
      try { this.conn.send(msg); } catch (e) { /* channel closed mid-send */ }
    }
  };

  Session.prototype.close = function () {
    try { if (this.conn) this.conn.close(); } catch (e) {}
    try { if (this.peer) this.peer.destroy(); } catch (e) {}
    this.conn = null;
    this.peer = null;
  };

  var NetCheckers = {
    ID_PREFIX: ID_PREFIX,
    makeCode: makeCode,
    idFor: idFor,
    isValidCode: isValidCode,
    sanitizeName: sanitizeName,
    isLegalWireMove: isLegalWireMove,
    Session: Session
  };

  global.NetCheckers = NetCheckers;
  if (typeof module !== 'undefined' && module.exports) module.exports = NetCheckers;
})(typeof globalThis !== 'undefined' ? globalThis : this);
