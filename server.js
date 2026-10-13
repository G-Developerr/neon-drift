/* =========================================================
   NEON DRIFT — online game server
   Plain Node.js, zero dependencies (http + crypto only).
   - Hand-written WebSocket (RFC 6455)
   - Identity from a secret code (no accounts, no database)
   - Friends presence, friend requests, invites
   - Rooms / lobbies with teams (1v1 .. 5v5), bots fill empty seats
   - Race relay at 20 Hz, finish order, team points
   G-navos Developer
   ========================================================= */
'use strict';
var http = require('http');
var https = require('https');
var crypto = require('crypto');
var fs = require('fs');
var path = require('path');

var PORT = Number(process.env.PORT) || 8090;
// works whether server.js sits next to index.html or inside a server/ folder
var STATIC_DIR = fs.existsSync(path.join(__dirname, 'index.html')) ? __dirname : path.resolve(__dirname, '..');
var LAG_MS = Number(process.env.LAG_MS) || 0;          // artificial latency for testing
var VERSION = 1;
var TICK_MS = 50;
var MAX_ROOMS = 300;
var GRACE_MS = 25000;                                  // keep a dropped player's seat this long
var POINTS = [15, 12, 10, 8, 6, 5, 4, 3, 2, 1];
var BOT_NAMES = ['VEGA', 'NYX', 'KAIROS', 'ZEPHYR', 'ORION', 'LUNA', 'TITAN', 'ECHO', 'RAVEN', 'ASTRA', 'BLADE', 'NOVA'];
var B32 = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function now() { return Date.now(); }
function log() { var a = Array.prototype.slice.call(arguments); a.unshift(new Date().toISOString().slice(11, 19)); console.log.apply(console, a); }

// ---------------------------------------------------------
//  HTTP: health, ping and (optionally) the game itself
// ---------------------------------------------------------
var MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.md': 'text/plain; charset=utf-8'
};
var ALLOWED_STATIC = { '/index.html': 1, '/sw.js': 1, '/manifest.webmanifest': 1, '/icon-180.png': 1, '/icon-192.png': 1, '/icon-512.png': 1 };

var server = http.createServer(function (req, res) {
  var url = (req.url || '/').split('?')[0];
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (url === '/nd-health') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ nd: VERSION, online: conns.size, rooms: rooms.size, t: now() }));
    return;
  }
  if (url === '/ping') { res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }); res.end('ok'); return; }
  if (url === '/') url = '/index.html';
  if (!ALLOWED_STATIC[url]) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); return; }
  var file = path.join(STATIC_DIR, url);
  fs.readFile(file, function (err, data) {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('NEON DRIFT server is running.'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

// ---------------------------------------------------------
//  Minimal WebSocket implementation
// ---------------------------------------------------------
var WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
var MAX_FRAME = 64 * 1024;

server.on('upgrade', function (req, socket) {
  var key = req.headers['sec-websocket-key'];
  var up = String(req.headers.upgrade || '').toLowerCase();
  if (up !== 'websocket' || !key) { socket.destroy(); return; }
  var accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  socket.setNoDelay(true);
  socket.setKeepAlive(true, 20000);
  var c = new Conn(socket);
  conns.add(c);
});

function Conn(socket) {
  this.socket = socket;
  this.buf = Buffer.alloc(0);
  this.frag = null;
  this.open = true;
  this.lastSeen = now();
  this.id = null; this.name = ''; this.car = null;
  this.watch = [];
  this.room = null;
  this.rate = 0; this.rateT = now();
  var self = this;
  socket.on('data', function (d) { self.onData(d); });
  socket.on('close', function () { self.onClose(); });
  socket.on('error', function () { self.onClose(); });
}
Conn.prototype.onData = function (d) {
  this.lastSeen = now();
  this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
  while (this.open && this.buf.length >= 2) {
    var b0 = this.buf[0], b1 = this.buf[1];
    var fin = (b0 & 0x80) !== 0, op = b0 & 0x0f, masked = (b1 & 0x80) !== 0;
    var len = b1 & 0x7f, off = 2;
    if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
    else if (len === 127) {
      if (this.buf.length < 10) return;
      var hi = this.buf.readUInt32BE(2), lo = this.buf.readUInt32BE(6);
      if (hi !== 0) { this.close(1009); return; }
      len = lo; off = 10;
    }
    if (len > MAX_FRAME) { this.close(1009); return; }
    var maskOff = off;
    if (masked) off += 4;
    if (this.buf.length < off + len) return;
    var payload = Buffer.from(this.buf.subarray(off, off + len));
    if (masked) for (var i = 0; i < len; i++) payload[i] ^= this.buf[maskOff + (i & 3)];
    this.buf = this.buf.subarray(off + len);
    if (op === 0x8) { this.close(1000); return; }
    if (op === 0x9) { this.sendFrame(0xA, payload); continue; }
    if (op === 0xA) continue;
    if (op === 0x1 || op === 0x2) {
      if (fin) this.onText(payload.toString('utf8'));
      else this.frag = [payload];
    } else if (op === 0x0 && this.frag) {
      this.frag.push(payload);
      if (fin) { var all = Buffer.concat(this.frag); this.frag = null; if (all.length <= MAX_FRAME) this.onText(all.toString('utf8')); }
    }
  }
};
Conn.prototype.sendFrame = function (op, data) {
  if (!this.open) return;
  var len = data.length, head;
  if (len < 126) { head = Buffer.alloc(2); head[1] = len; }
  else if (len < 65536) { head = Buffer.alloc(4); head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[1] = 127; head.writeUInt32BE(0, 2); head.writeUInt32BE(len, 6); }
  head[0] = 0x80 | op;
  try { this.socket.write(Buffer.concat([head, data])); } catch (e) { this.onClose(); }
};
Conn.prototype.send = function (obj) {
  var s = typeof obj === 'string' ? obj : JSON.stringify(obj);
  var self = this;
  if (LAG_MS) setTimeout(function () { self.sendFrame(0x1, Buffer.from(s, 'utf8')); }, LAG_MS / 2);
  else this.sendFrame(0x1, Buffer.from(s, 'utf8'));
};
Conn.prototype.close = function (code) {
  if (!this.open) return;
  var b = Buffer.alloc(2); b.writeUInt16BE(code || 1000, 0);
  this.sendFrame(0x8, b);
  this.open = false;
  try { this.socket.end(); } catch (e) { }
  this.onClose();
};
Conn.prototype.onText = function (txt) {
  var t = now();
  if (t - this.rateT > 1000) { this.rateT = t; this.rate = 0; }
  if (++this.rate > 150) return;              // flood guard
  var msg;
  try { msg = JSON.parse(txt); } catch (e) { return; }
  if (!msg || typeof msg.t !== 'string') return;
  var self = this;
  if (LAG_MS) setTimeout(function () { handle(self, msg); }, LAG_MS / 2);
  else handle(this, msg);
};
Conn.prototype.onClose = function () {
  if (this.closed) return;
  this.closed = true; this.open = false;
  conns.delete(this);
  if (this.id && byId.get(this.id) === this) {
    byId.delete(this.id);
    notifyPresence(this.id, false, this.name);
    if (this.room) playerDropped(this.room, this.id);
  }
};

// ---------------------------------------------------------
//  State (memory only — nothing is stored on disk)
// ---------------------------------------------------------
var conns = new Set();
var byId = new Map();          // id -> Conn
var watchers = new Map();      // id -> Set<Conn> who have this id as a friend
var pending = new Map();       // id -> [messages] waiting for that player (requests, accepts)
var rooms = new Map();         // code -> room

function cleanName(n) {
  n = String(n || '').toUpperCase().replace(/[^A-Z0-9Α-Ω _.\-]/g, '').trim().slice(0, 12);
  return n || 'PLAYER';
}
function idFromSecret(secret) {
  var h = crypto.createHash('sha256').update('neondrift:' + secret).digest();
  var s = '';
  for (var i = 0; i < 8; i++) s += B32[h[i] % 32];
  return s;
}
function validId(id) { return typeof id === 'string' && /^[A-Z2-9]{8}$/.test(id); }
function num(v, d) { v = Number(v); return isFinite(v) ? v : d; }

function pushPending(id, msg) {
  var arr = pending.get(id);
  if (!arr) { arr = []; pending.set(id, arr); }
  for (var i = 0; i < arr.length; i++) if (arr[i].t === msg.t && arr[i].from === msg.from) return;
  arr.push(msg);
  if (arr.length > 30) arr.shift();
}

function notifyPresence(id, on, name) {
  var set = watchers.get(id);
  if (!set) return;
  var room = null, c = byId.get(id);
  if (c && c.room) room = c.room.code;
  set.forEach(function (w) { w.send({ t: 'pres', id: id, on: on ? 1 : 0, name: name, room: room }); });
}
function setWatch(c, ids) {
  var i;
  for (i = 0; i < c.watch.length; i++) { var s = watchers.get(c.watch[i]); if (s) { s.delete(c); if (!s.size) watchers.delete(c.watch[i]); } }
  c.watch = [];
  if (!Array.isArray(ids)) return;
  for (i = 0; i < ids.length && i < 200; i++) {
    var id = ids[i];
    if (!validId(id) || id === c.id) continue;
    c.watch.push(id);
    var set = watchers.get(id);
    if (!set) { set = new Set(); watchers.set(id, set); }
    set.add(c);
  }
}

// ---------------------------------------------------------
//  Message handling
// ---------------------------------------------------------
function handle(c, m) {
  if (m.t === 'ping') { c.send({ t: 'pong', c: m.c, s: now() }); return; }
  if (m.t === 'hello') return onHello(c, m);
  if (!c.id) return;
  switch (m.t) {
    case 'friends': {
      setWatch(c, m.ids);
      var list = c.watch.map(function (id) { var o = byId.get(id); return { id: id, on: o ? 1 : 0, name: o ? o.name : '', room: o && o.room ? o.room.code : null }; });
      c.send({ t: 'presList', list: list });
      break;
    }
    case 'freq': {
      if (!validId(m.to) || m.to === c.id) return c.send({ t: 'err', e: 'badCode' });
      var msg = { t: 'freq', from: c.id, name: c.name };
      var tc = byId.get(m.to);
      if (tc) tc.send(msg); else pushPending(m.to, msg);
      c.send({ t: 'ok', what: 'freq', to: m.to, online: tc ? 1 : 0 });
      break;
    }
    case 'facc': {
      if (!validId(m.to)) return;
      var am = { t: 'facc', from: c.id, name: c.name };
      var ac = byId.get(m.to);
      if (ac) ac.send(am); else pushPending(m.to, am);
      break;
    }
    case 'inv': {
      if (!c.room) return c.send({ t: 'err', e: 'noRoom' });
      if (!validId(m.to)) return;
      var ic = byId.get(m.to);
      if (!ic) return c.send({ t: 'err', e: 'offline' });
      ic.send({ t: 'inv', from: c.id, name: c.name, code: c.room.code, size: c.room.size });
      c.send({ t: 'ok', what: 'inv', to: m.to });
      break;
    }
    case 'create': return createRoom(c, m);
    case 'join': return joinRoom(c, String(m.code || '').toUpperCase().slice(0, 6));
    case 'leave': if (c.room) leaveRoom(c.room, c.id, true); c.room = null; c.send({ t: 'left' }); break;
    case 'set': return roomSet(c, m);
    case 'team': return roomTeam(c, m);
    case 'car': if (m.car) { c.car = cleanCar(m.car); if (c.room) { var pl = findPlayer(c.room, c.id); if (pl) pl.car = c.car; sendRoom(c.room); } } break;
    case 'start': return startRace(c);
    case 'st': return raceState(c, m);
    case 'bst': return botState(c, m);
    case 'fin': return raceFinish(c, m);
    case 'back': if (c.room && c.room.state === 'results') { c.room.state = 'lobby'; sendRoom(c.room); } break;
    case 'kick': return roomKick(c, m);
    case 'shuffle': return roomShuffle(c);
    case 'quick': return quickPlay(c);
    case 'emo': {
      if (!c.room) return;
      var tt = now();
      if (c.lastEmo && tt - c.lastEmo < 700) return;
      c.lastEmo = tt;
      broadcast(c.room, { t: 'emo', id: c.id, name: c.name, i: clampN(Math.round(num(m.i, 0)), 0, 9) });
      break;
    }
    case 'dsub': return dailySub(c, m);
    case 'dget': return c.send({ t: 'dlist', day: Math.round(num(m.day, 0)), list: dailyList(Math.round(num(m.day, 0))) });
  }
}

function cleanCar(car) {
  var s = Array.isArray(car.s) ? car.s.slice(0, 4).map(function (v) { return clampN(num(v, 5), 1, 13); }) : [5, 5, 5, 5];
  while (s.length < 4) s.push(5);
  var pickOne = function (v, list, d) { return list.indexOf(v) >= 0 ? v : d; };
  return {
    m: clampN(Math.round(num(car.m, 0)), 0, 7), c: /^#[0-9a-fA-F]{6}$/.test(car.c) ? car.c : '#22f3ff', n: String(car.n || 'VOLT').slice(0, 12), s: s,
    t: pickOne(car.t, ['neon', 'dash', 'fire', 'bolt', 'rainbow'], 'neon'), d: pickOne(car.d, ['none', 'stripes', 'number', 'checker', 'flames'], 'none'),
    w: pickOne(car.w, ['dark', 'chrome', 'neon', 'gold'], 'dark'),
    k: pickOne(car.k, ['none', 'carbon', 'camo', 'tiger', 'circuit', 'galaxy', 'lava', 'ice', 'holo', 'gold'], 'none')
  };
}
function clampN(v, a, b) { return v < a ? a : (v > b ? b : v); }

function onHello(c, m) {
  var secret = String(m.secret || '');
  if (!/^[A-Z2-9]{16,40}$/.test(secret)) { c.send({ t: 'err', e: 'badSecret' }); return; }
  var id = idFromSecret(secret);
  var old = byId.get(id);
  if (old && old !== c) { old.send({ t: 'err', e: 'otherDevice' }); old.id = null; old.room = null; old.close(4000); }
  c.id = id; c.name = cleanName(m.name); c.car = cleanCar(m.car || {});
  byId.set(id, c);
  c.send({ t: 'welcome', id: id, name: c.name, s: now(), v: VERSION });
  notifyPresence(id, true, c.name);
  var p = pending.get(id);
  if (p) { pending.delete(id); p.forEach(function (msg) { c.send(msg); }); }
  // re-attach to a room seat that was kept during the grace period
  rooms.forEach(function (room) {
    var pl = findPlayer(room, id);
    if (pl) {
      pl.disc = false; pl.name = c.name; c.room = room;
      sendRoom(room);
      if (room.state === 'race' && room.race) {
        var slot = slotOf(room.race, id), st = room.race.states[slot];
        c.send(startMsg(room, { resume: 1, you: st ? st.d : null }));
      }
    }
  });
}

// ---------------------------------------------------------
//  Rooms
// ---------------------------------------------------------
function newCode() {
  for (var k = 0; k < 50; k++) {
    var s = '';
    for (var i = 0; i < 5; i++) s += B32[crypto.randomInt(32)];
    if (!rooms.has(s)) return s;
  }
  return null;
}
function findPlayer(room, id) { for (var i = 0; i < room.players.length; i++) if (room.players[i].id === id) return room.players[i]; return null; }
function humansOn(room, team) { var n = 0; room.players.forEach(function (p) { if (p.team === team) n++; }); return n; }

function createRoom(c, m) {
  if (c.room) leaveRoom(c.room, c.id, true);
  if (rooms.size >= MAX_ROOMS) return c.send({ t: 'err', e: 'full' });
  var code = newCode();
  if (!code) return c.send({ t: 'err', e: 'full' });
  var room = {
    code: code, host: c.id, size: clampN(Math.round(num(m.size, 2)), 1, 5), track: clampN(Math.round(num(m.track, 0)), 0, 10),
    laps: clampN(Math.round(num(m.laps, 3)), 1, 9), diff: clampN(Math.round(num(m.diff, 1)), 0, 2),
    mode: m.mode === 'drift' ? 'drift' : 'race', weather: m.weather === 'rain' ? 'rain' : 'clear', pub: !!m.pub, autoAt: 0,
    state: 'lobby', players: [], raceId: 0, race: null, created: now()
  };
  room.players.push({ id: c.id, name: c.name, team: 0, car: c.car, disc: false });
  rooms.set(code, room);
  c.room = room;
  log('room', code, 'created by', c.name);
  sendRoom(room);
  notifyPresence(c.id, true, c.name);
}
function joinRoom(c, code) {
  var room = rooms.get(code);
  if (!room) return c.send({ t: 'err', e: 'noSuchRoom' });
  if (c.room === room) return sendRoom(room);
  if (room.state === 'race') return c.send({ t: 'err', e: 'inRace' });
  if (room.players.length >= room.size * 2) return c.send({ t: 'err', e: 'roomFull' });
  if (c.room) leaveRoom(c.room, c.id, true);
  var team = humansOn(room, 0) <= humansOn(room, 1) ? 0 : 1;
  if (humansOn(room, team) >= room.size) team = 1 - team;
  room.players.push({ id: c.id, name: c.name, team: team, car: c.car, disc: false });
  if (room.state === 'results') room.state = 'lobby';
  c.room = room;
  sendRoom(room);
  notifyPresence(c.id, true, c.name);
}
function leaveRoom(room, id, now_) {
  var idx = -1;
  for (var i = 0; i < room.players.length; i++) if (room.players[i].id === id) idx = i;
  if (idx < 0) return;
  room.players.splice(idx, 1);
  var c = byId.get(id);
  if (c && c.room === room) c.room = null;
  if (!room.players.length) { rooms.delete(room.code); log('room', room.code, 'closed'); return; }
  if (room.host === id) room.host = firstConnected(room) || room.players[0].id;
  if (room.race && room.race.botOwner === id) reassignBots(room);
  if (room.race && room.state === 'race') {
    var slot = slotOf(room.race, id);
    if (slot >= 0 && !room.race.fin[slot]) room.race.left[slot] = 1;
    checkRaceEnd(room);
  }
  sendRoom(room);
  if (c) notifyPresence(id, true, c.name);
}
function firstConnected(room) {
  for (var i = 0; i < room.players.length; i++) if (!room.players[i].disc && byId.get(room.players[i].id)) return room.players[i].id;
  return null;
}
function playerDropped(room, id) {
  var pl = findPlayer(room, id);
  if (!pl) return;
  pl.disc = true; pl.discAt = now();
  if (room.host === id) { var h = firstConnected(room); if (h) room.host = h; }
  if (room.race && room.race.botOwner === id) reassignBots(room);
  sendRoom(room);
}
function reassignBots(room) {
  var o = firstConnected(room);
  room.race.botOwner = o;
  if (o) broadcast(room, { t: 'owner', r: room.race.id, id: o });
}
function roomSet(c, m) {
  var room = c.room;
  if (!room || room.host !== c.id || room.state === 'race') return;
  if (m.size !== undefined) {
    var sz = clampN(Math.round(num(m.size, room.size)), 1, 5);
    if (humansOn(room, 0) > sz || humansOn(room, 1) > sz) return c.send({ t: 'err', e: 'tooMany' });
    room.size = sz;
  }
  if (m.track !== undefined) room.track = clampN(Math.round(num(m.track, 0)), 0, 10);
  if (m.mode !== undefined) room.mode = m.mode === 'drift' ? 'drift' : 'race';
  if (m.weather !== undefined) room.weather = m.weather === 'rain' ? 'rain' : 'clear';
  if (m.laps !== undefined) room.laps = clampN(Math.round(num(m.laps, 3)), 1, 9);
  if (m.diff !== undefined) room.diff = clampN(Math.round(num(m.diff, 1)), 0, 2);
  sendRoom(room);
}
function roomTeam(c, m) {
  var room = c.room;
  if (!room || room.state === 'race') return;
  var pl = findPlayer(room, c.id), team = m.team === 1 ? 1 : 0;
  if (!pl || pl.team === team) return;
  if (humansOn(room, team) >= room.size) return c.send({ t: 'err', e: 'teamFull' });
  pl.team = team;
  sendRoom(room);
}
function roomKick(c, m) {
  var room = c.room;
  if (!room || room.host !== c.id || m.id === c.id || room.state === 'race') return;
  var k = byId.get(m.id);
  leaveRoom(room, m.id, true);
  if (k) k.send({ t: 'kicked' });
}
function roomShuffle(c) {
  var room = c.room;
  if (!room || room.host !== c.id || room.state === 'race') return;
  var list = shuffle(room.players.slice());
  list.forEach(function (p, i) { p.team = i % 2; });
  sendRoom(room);
}
function quickPlay(c) {
  var best = null;
  rooms.forEach(function (room) {
    if (!room.pub || room.state === 'race' || room.players.length >= room.size * 2) return;
    if (!best || room.players.length > best.players.length) best = room;
  });
  if (best) { joinRoom(c, best.code); return; }
  createRoom(c, { size: 2, track: crypto.randomInt(11), laps: 3, diff: 1, mode: 'race', pub: true });
}
function roomView(room) {
  return {
    t: 'room', code: room.code, host: room.host, size: room.size, track: room.track, laps: room.laps, diff: room.diff, state: room.state,
    mode: room.mode, weather: room.weather, pub: room.pub ? 1 : 0, auto: room.autoAt ? Math.max(0, Math.ceil((room.autoAt - now()) / 1000)) : 0,
    players: room.players.map(function (p) { return { id: p.id, name: p.name, team: p.team, car: p.car, disc: p.disc ? 1 : 0 }; })
  };
}
function sendRoom(room) { broadcast(room, roomView(room)); }
function broadcast(room, msg) {
  var s = JSON.stringify(msg);
  room.players.forEach(function (p) { var c = byId.get(p.id); if (c && c.room === room) c.send(s); });
}

// ---------------------------------------------------------
//  Daily track board (memory only)
// ---------------------------------------------------------
var daily = new Map();
function utcDay(offset) { var d = new Date(Date.now() + (offset || 0) * 86400000); return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate(); }
function dailyList(day) { return (daily.get(day) || []).slice(0, 50); }
function dailySub(c, m) {
  var day = Math.round(num(m.day, 0)), v = num(m.v, 0);
  if (day !== utcDay(0) && day !== utcDay(-1) && day !== utcDay(1)) return;
  if (!(v > 5 && v < 600)) return;
  var arr = daily.get(day);
  if (!arr) { arr = []; daily.set(day, arr); }
  var mine = null;
  arr.forEach(function (e) { if (e.id === c.id) mine = e; });
  if (mine) { if (v < mine.v) { mine.v = v; mine.name = c.name; mine.car = String(m.car || '').slice(0, 12); } }
  else arr.push({ id: c.id, name: c.name, v: v, car: String(m.car || '').slice(0, 12) });
  arr.sort(function (a, b) { return a.v - b.v; });
  if (arr.length > 200) arr.length = 200;
  daily.forEach(function (_, k) { if (k < utcDay(-2)) daily.delete(k); });
  c.send({ t: 'dlist', day: day, list: dailyList(day) });
}

// ---------------------------------------------------------
//  Racing
// ---------------------------------------------------------
function shuffle(a) { for (var i = a.length - 1; i > 0; i--) { var j = crypto.randomInt(i + 1); var t = a[i]; a[i] = a[j]; a[j] = t; } return a; }
function slotOf(race, id) { for (var i = 0; i < race.grid.length; i++) if (race.grid[i].id === id) return i; return -1; }

function startRace(c) {
  var room = c.room;
  if (!room || room.host !== c.id || room.state === 'race') return;
  startRoomRace(room);
}
function startRoomRace(room) {
  if (room.state === 'race') return;
  room.autoAt = 0;
  room.players = room.players.filter(function (p) { return !p.disc; });
  var entries = [], stats = [0, 0, 0, 0], n = 0;
  room.players.forEach(function (p) {
    entries.push({ id: p.id, name: p.name, team: p.team, car: p.car, bot: 0 });
    for (var k = 0; k < 4; k++) stats[k] += p.car.s[k];
    n++;
  });
  stats = stats.map(function (v) { return Math.round(v / Math.max(1, n) * 10) / 10; });
  var names = shuffle(BOT_NAMES.slice());
  for (var team = 0; team < 2; team++) {
    var need = room.size - humansOn(room, team);
    for (var b = 0; b < need; b++) {
      entries.push({ id: null, name: names.pop(), team: team, bot: 1, car: { m: crypto.randomInt(8), c: ['#ff2bd6', '#22f3ff', '#b14dff', '#00ff9c', '#ffb000', '#ff4d4d', '#f4f0ff', '#ffe14d'][crypto.randomInt(8)], n: 'BOT', s: stats.slice() } });
    }
  }
  shuffle(entries);
  room.raceId++;
  room.state = 'race';
  room.race = {
    id: room.raceId, grid: entries, startAt: now() + 4800, botOwner: firstConnected(room) || room.host, mode: room.mode, dur: 90,
    states: [], fin: {}, left: {}, firstFin: 0, order: 0, ended: false
  };
  log('race', room.code, 'start', room.size + 'v' + room.size, 'humans', n);
  sendRoom(room);
  broadcast(room, startMsg(room, null));
}
function startMsg(room, extra) {
  var r = room.race;
  var msg = {
    t: 'start', r: r.id, startAt: r.startAt, track: room.track, laps: room.laps, diff: room.diff, size: room.size, owner: r.botOwner,
    mode: r.mode, dur: r.dur, weather: room.weather,
    grid: r.grid.map(function (e, i) { return { slot: i, id: e.id, name: e.name, team: e.team, bot: e.bot, car: e.car }; })
  };
  if (extra) for (var k in extra) msg[k] = extra[k];
  return msg;
}
function validState(d) {
  if (!Array.isArray(d) || d.length < 9 || d.length > 12) return false;
  for (var i = 0; i < d.length; i++) if (typeof d[i] !== 'number' || !isFinite(d[i])) return false;
  return true;
}
function raceState(c, m) {
  var room = c.room;
  if (!room || room.state !== 'race' || !room.race || m.r !== room.race.id) return;
  var slot = slotOf(room.race, c.id);
  if (slot < 0 || !validState(m.d)) return;
  room.race.states[slot] = { d: m.d, ts: now() };
}
function botState(c, m) {
  var room = c.room;
  if (!room || room.state !== 'race' || !room.race || m.r !== room.race.id || room.race.botOwner !== c.id) return;
  if (!Array.isArray(m.b)) return;
  var t = now();
  m.b.forEach(function (e) {
    if (!Array.isArray(e) || e.length < 2) return;
    var slot = e[0], d = e[1];
    if (typeof slot !== 'number' || !room.race.grid[slot] || !room.race.grid[slot].bot || !validState(d)) return;
    room.race.states[slot] = { d: d, ts: t };
  });
}
function raceFinish(c, m) {
  var room = c.room;
  if (!room || room.state !== 'race' || !room.race || m.r !== room.race.id) return;
  var race = room.race, slot;
  if (m.slot !== undefined && m.slot !== null) {
    slot = Math.round(num(m.slot, -1));
    if (!race.grid[slot] || !race.grid[slot].bot || race.botOwner !== c.id) return;
  } else slot = slotOf(race, c.id);
  if (slot < 0 || race.fin[slot]) return;
  var time = clampN(num(m.time, 999), 1, 3600), best = clampN(num(m.best, 999), 1, 3600);
  race.fin[slot] = { time: time, best: best, order: ++race.order };
  if (!race.firstFin) race.firstFin = now();
  broadcast(room, { t: 'finx', r: race.id, slot: slot, time: time });
  checkRaceEnd(room);
}
function checkRaceEnd(room) {
  var race = room.race;
  if (!race || race.ended) return;
  var allHumans = true, anyHuman = false, botsLeft = false;
  race.grid.forEach(function (e, i) {
    if (e.bot) { if (!race.fin[i]) botsLeft = true; return; }
    var pl = findPlayer(room, e.id);
    if (!pl || race.left[i]) return;
    anyHuman = true;
    if (!race.fin[i]) allHumans = false;
  });
  var t = now();
  if (race.mode === 'drift') {
    if (!anyHuman || t > race.startAt + race.dur * 1000 + 1800) endRace(room);
    return;
  }
  var timeout = race.firstFin && t - race.firstFin > 30000;
  var stale = t - race.startAt > (60 + room.laps * 75) * 1000;
  if (allHumans && anyHuman && botsLeft) {
    // everyone human is home: give the bots a few seconds to cross the line
    if (!race.allHumansAt) race.allHumansAt = t;
    if (t - race.allHumansAt < 8000 && !timeout && !stale) return;
  }
  if (!anyHuman || allHumans || timeout || stale) endRace(room);
}
function endRace(room) {
  var race = room.race;
  race.ended = true;
  var rows = race.grid.map(function (e, i) {
    var st = race.states[i], f = race.fin[i];
    return { slot: i, name: e.name, team: e.team, bot: e.bot, id: e.id, fin: f ? 1 : 0, time: f ? f.time : 0, best: f ? f.best : 0, ord: f ? f.order : 0, prog: st ? st.d[8] : -1e9, left: race.left[i] ? 1 : 0, score: st && st.d.length > 9 ? Math.max(0, Math.round(st.d[9])) : 0 };
  });
  if (race.mode === 'drift') {
    rows.sort(function (a, b) { return (a.left - b.left) || (b.score - a.score); });
    var dteams = [0, 0];
    rows.forEach(function (r) { r.pts = r.left ? 0 : r.score; dteams[r.team] += r.pts; });
    var dwin = dteams[0] > dteams[1] ? 0 : (dteams[1] > dteams[0] ? 1 : rows[0].team);
    room.state = 'results'; room.race = null;
    log('drift', room.code, 'end', dteams.join(':'));
    broadcast(room, { t: 'res', r: race.id, rows: rows, teams: dteams, win: dwin, mode: 'drift' });
    sendRoom(room);
    return;
  }
  rows.sort(function (a, b) {
    if (a.fin && b.fin) return a.time - b.time || a.ord - b.ord;
    if (a.fin) return -1;
    if (b.fin) return 1;
    if (a.left !== b.left) return a.left - b.left;
    return b.prog - a.prog;
  });
  var teams = [0, 0];
  rows.forEach(function (r, i) { r.pts = r.left ? 0 : (POINTS[i] || 0); teams[r.team] += r.pts; });
  var win = teams[0] > teams[1] ? 0 : (teams[1] > teams[0] ? 1 : rows[0].team);
  room.state = 'results';
  room.race = null;
  log('race', room.code, 'end', teams.join(':'));
  broadcast(room, { t: 'res', r: race.id, rows: rows, teams: teams, win: win });
  sendRoom(room);
}

// 20 Hz snapshot broadcast + housekeeping
setInterval(function () {
  var t = now();
  rooms.forEach(function (room) {
    if (room.state === 'race' && room.race) {
      var race = room.race, cars = [];
      for (var i = 0; i < race.grid.length; i++) {
        var st = race.states[i];
        if (st && t - st.ts < 3000) cars.push([i, t - st.ts, st.d]);
      }
      if (cars.length) broadcast(room, { t: 'snap', r: race.id, s: t, c: cars });
      if (t % 1000 < TICK_MS) checkRaceEnd(room);
    } else if (room.pub && t % 1000 < TICK_MS) {
      var humans = 0;
      room.players.forEach(function (p) { if (!p.disc) humans++; });
      if (humans >= 2) {
        if (!room.autoAt) { room.autoAt = t + (room.state === 'results' ? 20000 : 15000); sendRoom(room); }
        else if (t >= room.autoAt) startRoomRace(room);
        else if ((room.autoAt - t) % 5000 < 1000) sendRoom(room);
      } else if (room.autoAt) { room.autoAt = 0; sendRoom(room); }
    }
  });
}, TICK_MS);

setInterval(function () {
  var t = now();
  // drop players whose grace period ran out
  rooms.forEach(function (room) {
    room.players.slice().forEach(function (p) { if (p.disc && t - p.discAt > GRACE_MS) leaveRoom(room, p.id, true); });
    if (room.players.length && room.state !== 'race' && !firstConnected(room) && t - room.created > GRACE_MS) {
      room.players.slice().forEach(function (p) { leaveRoom(room, p.id, true); });
    }
  });
  // heartbeat: ping everyone, drop silent sockets
  conns.forEach(function (c) {
    if (t - c.lastSeen > 70000) { c.close(1001); return; }
    c.sendFrame(0x9, Buffer.alloc(0));
  });
  // forget old pending messages occasionally
  if (pending.size > 5000) pending.clear();
}, 20000);

// Keep the free Render instance awake: ping our own public URL every 10 minutes.
if (process.env.RENDER_EXTERNAL_URL && process.env.KEEP_AWAKE !== '0') {
  var self = process.env.RENDER_EXTERNAL_URL.replace(/\/$/, '') + '/ping';
  setInterval(function () { https.get(self, function (r) { r.resume(); }).on('error', function () { }); }, 10 * 60 * 1000);
  log('keep-awake enabled for', self);
}

server.listen(PORT, function () { log('NEON DRIFT server listening on', PORT, LAG_MS ? '(lag ' + LAG_MS + 'ms)' : ''); });
