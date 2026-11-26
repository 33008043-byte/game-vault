/* GV-ROOM-SHIM v1
   Online play outside claude.ai. Gives games the same "room" API they use on claude.ai
   (window.claude.use('room') -> room.presence(), room.peers(), room.join(name), room.leave())
   but connects players through PeerJS (free, no account needed).
   One player in each room quietly acts as the "hub" that passes everyone's state around.
   If the hub leaves, someone else takes over automatically. */
(function () {
  if (window.claude && typeof window.claude.use === 'function') return; // real claude.ai runtime is present
  var SRC = ['https://cdn.jsdelivr.net/npm/peerjs@1.5.4/dist/peerjs.min.js',
             'https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js',
             'https://cdnjs.cloudflare.com/ajax/libs/peerjs/1.5.4/peerjs.min.js'];
  var libP = null;
  function loadLib() {
    if (window.Peer) return Promise.resolve(true);
    if (libP) return libP;
    libP = new Promise(function (res) {
      var i = 0;
      (function next() {
        if (window.Peer) return res(true);
        if (i >= SRC.length) return res(false);
        var s = document.createElement('script'); s.src = SRC[i++]; s.async = true;
        var t = setTimeout(function () { s.onerror = s.onload = null; next(); }, 8000);
        s.onload = function () { clearTimeout(t); res(!!window.Peer) };
        s.onerror = function () { clearTimeout(t); next(); };
        (document.head || document.documentElement).appendChild(s);
      })();
    });
    return libP;
  }
  function hash(str) { // small stable hash -> hex
    var h1 = 0x811c9dc5, h2 = 0x01000193;
    for (var i = 0; i < str.length; i++) { var c = str.charCodeAt(i); h1 = Math.imul(h1 ^ c, 16777619); h2 = Math.imul(h2 ^ c, 2246822507); }
    return ((h1 >>> 0).toString(16) + (h2 >>> 0).toString(16));
  }
  function opts() { var o = { debug: 0 }, x = window.GV_PEER_OPTS; if (x) for (var k in x) o[k] = x[k]; return o; }
  function rid() { return 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
  var site = location.host + location.pathname.replace(/[^/]*$/, '');

  function Room(name) {
    this.name = name;
    this.id = rid();            // my player id as the game sees it
    this.mine = {};             // my presence
    this.table = {};            // everyone else's presence, from the hub
    this.hubId = 'gamevault-' + hash(site + '|' + name);
    this.peer = null; this.conn = null; this.isHub = false; this.left = false;
    this.clients = {};          // (hub only) conn.peer -> {conn, id}
    this.hubT = null; this.lostAt = 0; this.started = false; this.dirty = true;
    this.peerCbs = []; this.connCbs = [];
  }
  Room.prototype._start = function () {
    if (this.started || this.left) return; this.started = true;
    var self = this; this._tryHub();
    setInterval(function () { self._tick(); }, 60);
  };
  Room.prototype._tryHub = function () {
    var self = this; if (this.left) return;
    this._closePeer();
    var p = new window.Peer(this.hubId, opts()); this.peer = p;
    p.on('open', function () { if (self.peer !== p) return; if (!self.isHub) self.table = {}; self.isHub = true; self.dirty = true; self._notifyConn(true); });
    p.on('connection', function (c) {
      if (self.peer !== p) return;
      c.on('open', function () { self.clients[c.peer] = { conn: c, id: null, last: Date.now() }; self.dirty = true; });
      c.on('data', function (d) {
        if (!d || typeof d !== 'object') return;
        var cl = self.clients[c.peer]; if (!cl) cl = self.clients[c.peer] = { conn: c, id: null }; cl.last = Date.now();
        if (d.t === 'p' && typeof d.id === 'string' && d.id.length < 64 && d.p && typeof d.p === 'object') {
          cl.id = d.id; self.table[d.id] = d.p; self.dirty = true;
        }
      });
      var gone = function () { var cl = self.clients[c.peer]; if (cl) { if (cl.id) delete self.table[cl.id]; delete self.clients[c.peer]; self.dirty = true; } };
      c.on('close', gone); c.on('error', gone);
    });
    p.on('error', function (e) {
      if (self.peer !== p) return;
      if (e && e.type === 'unavailable-id') { self._asClient(); return; }
      if (e && (e.type === 'network' || e.type === 'server-error' || e.type === 'socket-error' || e.type === 'socket-closed')) { self._retry(); return; }
    });
    p.on('disconnected', function () { if (self.peer === p && !self.left) { try { p.reconnect(); } catch (er) { self._retry(); } } });
  };
  Room.prototype._asClient = function () {
    var self = this; if (this.left) return;
    this._closePeer(); this.isHub = false;
    var p = new window.Peer(opts()); this.peer = p;
    p.on('open', function () {
      if (self.peer !== p) return;
      var c = p.connect(self.hubId, { reliable: true, serialization: 'json' }); self.conn = c;
      var opened = false;
      var to = setTimeout(function () { if (!opened && self.conn === c) self._retry(); }, 7000);
      c.on('open', function () { opened = true; clearTimeout(to); self.lostAt = 0; self.lastHub = Date.now(); self._send(true); self._notifyConn(true); });
      c.on('data', function (d) {
        if (d && d.t === 'all') self.lastHub = Date.now();
        if (d && d.t === 'all' && d.peers && typeof d.peers === 'object') { var t = {}; for (var k in d.peers) if (k !== self.id) t[k] = d.peers[k]; self.table = t; self._notifyPeers(); }
      });
      var lost = function () { if (self.conn === c) { self.conn = null; self._retry(); } };
      c.on('close', lost); c.on('error', lost);
    });
    p.on('error', function (e) {
      if (self.peer !== p) return;
      if (e && e.type === 'peer-unavailable') { self._retry(true); return; } // hub vanished: try to become it
      self._retry();
    });
  };
  Room.prototype._retry = function (fast) {
    var self = this; if (this.left) return;
    if (!this.lostAt) this.lostAt = Date.now();
    clearTimeout(this.hubT);
    this.hubT = setTimeout(function () { self._tryHub(); }, (fast ? 200 : 700) + Math.random() * 1500);
  };
  Room.prototype._closePeer = function () {
    try { if (this.conn) this.conn.close(); } catch (e) {}
    try { if (this.peer) this.peer.destroy(); } catch (e) {}
    this.conn = null; this.peer = null; this.isHub = false; this.clients = {};
  };
  Room.prototype._send = function (force) {
    if (this.isHub) { this.dirty = true; return; }
    if (this.conn && this.conn.open) { try { this.conn.send({ t: 'p', id: this.id, p: this.mine }); } catch (e) {} }
  };
  Room.prototype._tick = function () {
    if (this.left) return;
    // forget other players if we've been cut off from the hub for a while
    if (!this.isHub && this.lostAt && Date.now() - this.lostAt > 4000 && Object.keys(this.table).length) { this.table = {}; this._notifyPeers(); }
    var now = Date.now();
    if (!this.isHub) {
      // heartbeat to the hub, and notice a hub that silently disappeared
      if (this.conn && this.conn.open) {
        if (now - (this.lastBeat || 0) > 1000) { this.lastBeat = now; this._send(true); }
        if (this.lastHub && now - this.lastHub > 3500) { var c0 = this.conn; this.conn = null; try { c0.close(); } catch (e) {} this._retry(true); }
      }
      return;
    }
    for (var cp in this.clients) { var c1 = this.clients[cp]; if (now - (c1.last || 0) > 5000) { if (c1.id) delete this.table[c1.id]; try { c1.conn.close(); } catch (e) {} delete this.clients[cp]; this.dirty = true; } }
    if (now - (this.lastAll || 0) > 1000) this.dirty = true; // keep-alive for clients
    if (!this.dirty) return;
    this.dirty = false; this.lastAll = now;
    var all = {}; for (var k in this.table) all[k] = this.table[k]; all[this.id] = this.mine;
    var msg = { t: 'all', peers: all };
    for (var c in this.clients) { var cl = this.clients[c]; if (cl.conn && cl.conn.open) { try { cl.conn.send(msg); } catch (e) {} } }
    this._notifyPeers();
  };
  Room.prototype._notifyPeers = function () { var l = this.peers(); this.peerCbs.forEach(function (f) { try { f(l); } catch (e) {} }); };
  Room.prototype._notifyConn = function (on) { this.connCbs.forEach(function (f) { try { f(on); } catch (e) {} }); };
  // ---- the API the games use ----
  Room.prototype.presence = function (obj) {
    this._start();
    if (obj && typeof obj === 'object') { for (var k in obj) this.mine[k] = obj[k]; }
    this._send(); return Promise.resolve();
  };
  Room.prototype.peers = function () {
    this._start();
    var out = [{ peer: this.id, kind: 'viewer', sameTab: true, presence: this.mine }];
    for (var k in this.table) if (k !== this.id) out.push({ peer: k, kind: 'viewer', sameTab: false, presence: this.table[k] });
    return out;
  };
  Room.prototype.onPeers = function (cb) { if (typeof cb === 'function') this.peerCbs.push(cb); this._start(); return function () {}; };
  Room.prototype.onConnection = function (cb) { if (typeof cb === 'function') this.connCbs.push(cb); return function () {}; };
  var rooms = [];
  Room.prototype.join = function (name) { var r = new Room(String(name)); rooms.push(r); r._start(); return Promise.resolve(r); };
  Room.prototype.leave = function () { this.left = true; clearTimeout(this.hubT); this._closePeer(); return Promise.resolve(); };

  var main = null;
  window.claude = {
    gameVaultShim: true,
    use: function (what) {
      if (what !== 'room') return Promise.resolve(null);
      return loadLib().then(function (ok) {
        if (!ok) return null;
        if (!main) main = new Room('main');
        return main;
      });
    }
  };
  window.addEventListener('pagehide', function () { [main].concat(rooms).forEach(function (r) { try { if (r) r.leave(); } catch (e) {} }); });
})();
