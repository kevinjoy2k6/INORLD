/* ============================================================================
 * NetworkManager — zero-cost browser-to-browser co-op over PeerJS / WebRTC
 *
 * Transport
 *  - PeerJS's free public cloud is used ONLY for signalling (SDP / ICE exchange).
 *  - Gameplay traffic then flows peer-to-peer over a reliable WebRTC
 *    DataChannel; no game server, no relay bandwidth, no monthly bill.
 *  - ICE uses Google's free STUN servers. Two peers behind strict
 *    (symmetric) NATs may still fail without a TURN relay — that is a
 *    documented WebRTC limitation, not a bug in this module.
 *
 * Addressing
 *  - A room is addressed by a 6-character code such as "MUD-842".
 *  - The host's PeerJS id is DERIVED from that code (roomCodeToPeerId), so a
 *    friend can connect knowing nothing but the code they were read over the
 *    phone. There is no directory server involved.
 *  - The host accepts up to MAX_PEERS (3) friends, so a squad is 4 trucks.
 *
 * Messages
 *  - host-sync ......... world seed, player list, mission progress, spawn
 *  - state-tick ........ 20 Hz truck state (pos/quat/vel/steer/wheels/psi/paint)
 *  - rut-stamp ......... compact [x, z, depth, radius, yaw] mud stamps
 *  - winch-event ....... attach / release / force packets for truck-to-truck rescue
 *  - fuel-transfer ..... jerry-can fuel handed to a teammate
 *  - mission-event ..... tower discovery, timber load, bridge delivery
 *
 * The host is the hub: it relays joiner traffic to the other joiners, and it
 * owns the authoritative world seed / mission state handed out at join time.
 * ========================================================================== */

import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { PHYS_GROUPS } from './OffroadVehicle.js';
import { VehicleMeshBuilder, PAINT_COLORS, PAINT_ORDER } from './VehicleMeshBuilder.js';

/* PeerJS 1.5.x ships as a classic IIFE that assigns `window.Peer`; it has no
 * ESM exports, so importing it as a module kills the whole graph. */
function getPeerCtor() {
  const ctor = typeof window !== 'undefined' ? window.Peer : null;
  if (!ctor) throw new Error('PeerJS failed to load — window.Peer is unavailable.');
  return ctor;
}

const PEER_KEY = 'overthehill-free-peerjs-key';

export const STUN_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

export const MAX_PEERS = 3;
const TICK_MS = 50; // 20 Hz
const RUT_BATCH_MS = 100; // rut stamps are batched to 10 Hz
const PLAYER_TIMEOUT_MS = 30000; // a backgrounded tab pauses rAF, so be generous
const INTERP_DELAY_MS = 110; // render remote trucks 110 ms in the past
const PEER_PREFIX = 'oth1-';

/* ---- room code helpers ------------------------------------------ */

/** 3 letters + 3 digits, e.g. "MUD-842". 17.5M combinations. */
export function makeRoomCode(random = Math.random) {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I / O confusion
  let code = '';
  for (let i = 0; i < 3; i += 1) {
    code += letters[Math.floor(random() * letters.length)];
  }
  code += '-';
  code += String(Math.floor(random() * 1000)).padStart(3, '0');
  return code;
}

/** Normalise user input: "mud 842" / "mud-842" / "MUD842" -> "MUD-842". */
export function normaliseRoomCode(input) {
  const raw = String(input || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (raw.length !== 6) return null;
  return `${raw.slice(0, 3)}-${raw.slice(3)}`;
}

/**
 * The PeerJS id that a room code maps to. Deterministic, so any client can
 * resolve a code to the host without a lookup service.
 */
export function roomCodeToPeerId(roomCode) {
  const code = normaliseRoomCode(roomCode);
  if (!code) return null;
  return PEER_PREFIX + code.replace('-', '').toLowerCase();
}

export function isPeerIdValidForRoom(peerId) {
  return typeof peerId === 'string' && peerId.startsWith(PEER_PREFIX);
}

/* ---- local state snapshot sent at 20 Hz -------------------------- */
export function vehicleSnapshot(ta) {
  const b = ta.body;
  if (!b) throw new Error('vehicleSnapshot needs telemetry.body');
  return {
    pos: [round(b.position.x), round(b.position.y), round(b.position.z)],
    quat: [
      round(b.quaternion.x, 4),
      round(b.quaternion.y, 4),
      round(b.quaternion.z, 4),
      round(b.quaternion.w, 4),
    ],
    vel: [round(b.velocity.x, 2), round(b.velocity.y, 2), round(b.velocity.z, 2)],
    steer: round(ta.steeringAngle ?? 0, 3),
    wheelRot: round(ta.wheelRotation ?? 0, 2),
    wheelSink: (ta.wheelSink || [0, 0, 0, 0]).map((v) => round(v, 3)),
    psi: round(ta.psi ?? 22, 1),
    paint: ta.paintHex || PAINT_COLORS.yellow.hex,
    accessories: ta.accessories || null,
    a: ta.awd ? 1 : 0,
    hb: ta.handbrake ? 1 : 0,
    gear: ta.gearId ?? 'AUTO',
    help: ta.helpPing ? 1 : 0,
  };
}

function round(v, dp = 2) {
  const f = 10 ** dp;
  return Math.round((Number(v) || 0) * f) / f;
}

function nowMs() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/* ---- one remote player, host- and joiner-side -------------------- */
class RemotePlayer {
  constructor(id, name) {
    this.id = id;
    this.name = name || 'Driver';
    this.lastSeen = nowMs();
    this.lastSeq = -1;

    // authoritative sample from the newest tick
    this.pos = new THREE.Vector3();
    this.quaternion = new THREE.Quaternion();
    this.vel = new THREE.Vector3();
    this.steer = 0;
    this.wheelRot = 0;
    this.wheelSink = [0, 0, 0, 0];
    this.psi = 22;
    this.paint = PAINT_COLORS.yellow.hex;
    this.accessories = null;
    this.awd = 0;
    this.handbrake = 0;
    this.gear = 'AUTO';

    // interpolation ring: the two most recent samples
    this.samples = [];
    this.hasSample = false;

    // rendered pose
    this.renderPos = new THREE.Vector3();
    this.renderQuat = new THREE.Quaternion();

    // scene objects
    this.body = null;
    this.mesh = null;
    this.builder = null;
    this.conn = null;
  }

  pushSample(t) {
    this.samples.push({
      t,
      pos: this.pos.clone(),
      quat: this.quaternion.clone(),
    });
    if (this.samples.length > 6) this.samples.shift();
    if (!this.hasSample) {
      this.hasSample = true;
      this.renderPos.copy(this.pos);
      this.renderQuat.copy(this.quaternion);
    }
  }
}

/* ================================================================== */
export class NetworkManager {
  constructor({
    worldSeed,
    terrain,
    vehicle,
    trailer,
    scene,
    world = null,
    winchSystem = null,
    missionManager = null,
    rutSystem = null,
  }) {
    this.worldSeed = worldSeed;
    this.terrain = terrain;
    this.vehicle = vehicle;
    this.trailer = trailer;
    this.scene = scene;
    this.world = world || scene.world || null;
    this.winchSystem = winchSystem;
    this.missionManager = missionManager;
    this.rutSystem = rutSystem;

    this.role = null; // 'host' | 'joiner' | null
    this.roomCode = null;
    this.hostPeerId = null;
    this.localPeerId = null;
    this.localName = 'You';

    this.peer = null;
    this.connections = new Map(); // peerId -> DataConnection (host keeps up to 3)
    this.remotePlayers = new Map();
    this.hostConn = null; // joiner only

    this.players = [{ id: 'local', name: 'You', local: true, host: true }];

    this._tickAccum = 0;
    this._rutAccum = 0;
    this._sendSeq = 0;
    this._lastTickAt = 0;

    // callbacks
    this.onStateChange = null; // (role, roomCode, hostPeerId)
    this.onPlayerJoined = null; // (player)
    this.onPlayerLeft = null; // (playerId)
    this.onToaster = null; // (text, kind?)
    this.onFatal = null; // (message)
    this.onConnectionState = null; // (text)

    // joiner handshake bookkeeping
    this.joining = false;
    this.joinRetries = 0;
    this._hostRetries = 0;
  }

  /* ---------------- tiny helpers ---------------- */

  _toast(text, kind) {
    if (this.onToaster) this.onToaster(text, kind);
  }

  get isHost() {
    return this.role === 'host';
  }

  get isJoined() {
    return this.role === 'joiner';
  }

  get isConnected() {
    if (this.role === 'host') return [...this.connections.values()].some((c) => c.open);
    return !!this.hostConn && this.hostConn.open;
  }

  get remotePlayerCount() {
    return this.remotePlayers.size;
  }

  get squadSize() {
    return 1 + this.remotePlayers.size;
  }

  /** All peers except `exceptPeerId` (host broadcasting). */
  _broadcast(payload, exceptPeerId = null) {
    for (const [peerId, conn] of this.connections) {
      if (peerId === exceptPeerId) continue;
      this._send(conn, payload);
    }
  }

  _send(conn, payload) {
    if (!conn || !conn.open) return false;
    try {
      conn.send(payload);
      return true;
    } catch {
      return false; // a dropped tick is harmless; the next one lands
    }
  }

  /* ================================================================== *
   *  HOST
   * ================================================================== */

  startHost(name = 'You') {
    if (this.role) this.disconnect();
    this.role = 'host';
    this.localName = name;
    this._resetPlayers();
    this._hostRetries = 0;
    this._openHostPeer(1);
  }

  _openHostPeer(attempt) {
    let PeerCtor;
    try {
      PeerCtor = getPeerCtor();
    } catch (err) {
      this.onFatal?.(err.message);
      this.role = null;
      return;
    }

    const roomCode = makeRoomCode();
    const peerId = roomCodeToPeerId(roomCode);

    this.roomCode = roomCode;
    this.hostPeerId = peerId;
    this.localPeerId = peerId;

    try {
      this.peer = new PeerCtor(peerId, {
        debug: 0,
        config: { iceServers: STUN_SERVERS },
        key: PEER_KEY,
      });
    } catch (err) {
      this.onFatal?.(`Could not start hosting: ${err.message || err}`);
      this.role = null;
      return;
    }

    this.peer.on('open', (id) => {
      this.localPeerId = id;
      this._toast(`ROOM ${this.roomCode}`, 'good');
      this.onStateChange?.(this.role, this.roomCode, this.hostPeerId);
    });

    this.peer.on('connection', (conn) => this._acceptConnection(conn));

    this.peer.on('disconnected', () => {
      this._toast('SIGNALLING LOST — RECONNECTING');
      try {
        this.peer.reconnect();
      } catch { /* destroyed */ }
    });

    this.peer.on('error', (err) => {
      const type = err?.type || '';
      // The code is taken by another room (or our own stale session): roll a new one.
      if (type === 'unavailable-id' && attempt < 4) {
        this._toast('ROOM CODE TAKEN — TRYING AGAIN');
        try { this.peer.destroy(); } catch { /* already gone */ }
        this.peer = null;
        this._openHostPeer(attempt + 1);
        return;
      }
      if (type === 'peer-unavailable') return; // a friend typed a dead code
      this._toast(`PEER ${err?.message || type || err}`);
    });

    this.peer.on('close', () => {
      if (this.role !== 'host') return;
      this._toast('HOST ROOM CLOSED');
      this.onStateChange?.(null, null, null);
    });
  }

  _acceptConnection(conn) {
    const peerId = conn.peer;

    if (this.remotePlayers.size >= MAX_PEERS) {
      this._toast('ROOM FULL (4 MAX)');
      try { conn.close(); } catch { /* gone */ }
      return;
    }
    if (this.remotePlayers.has(peerId)) {
      try { conn.close(); } catch { /* gone */ }
      return;
    }

    const player = new RemotePlayer(peerId, conn.metadata?.name || 'Driver');
    player.conn = conn;

    // Park the newcomer at the spawn lane so their truck exists (and can be
    // seen and bumped) before the first state tick arrives.
    const spawn = this.terrain.spawn;
    const lane = (this.remotePlayers.size + 1) * 2.6;
    player.pos.set(
      spawn.position.x + Math.cos(spawn.heading) * lane,
      spawn.position.y + 1.3,
      spawn.position.z - Math.sin(spawn.heading) * lane,
    );
    player.quaternion.setFromEuler(0, spawn.heading, 0);
    player.pushSample(nowMs());

    this.remotePlayers.set(peerId, player);
    this.connections.set(peerId, conn);
    this.players.push({ id: peerId, name: player.name, local: false, host: false });
    this._buildRemoteTruck(player);

    conn.on('data', (payload) => this._onHostData(peerId, payload));
    conn.on('open', () => {
      this._sendHostSync(conn, peerId);
      this._toast(`${player.name.toUpperCase()} JOINED`, 'good');
      this.onPlayerJoined?.({ id: peerId, name: player.name });
      this.onStateChange?.(this.role, this.roomCode, this.hostPeerId);
    });
    conn.on('close', () => this._dropPlayer(peerId));
    conn.on('error', () => this._dropPlayer(peerId));

    // Metadata arrives with the connection on some PeerJS builds only.
    if (conn.open) {
      this._sendHostSync(conn, peerId);
    }
  }

  _sendHostSync(conn, peerId) {
    const player = this.remotePlayers.get(peerId);
    const payload = {
      type: 'host-sync',
      worldSeed: this.worldSeed,
      players: this.players.map((p) => ({ id: p.id, name: p.name, local: !!p.local, host: !!p.host })),
      missionState: this.missionManager ? this.missionManager.getState() : null,
      spawnPos: this.terrain.spawn.position.toArray(),
      spawnHeading: this.terrain.spawn.heading,
      you: { id: peerId, name: player ? player.name : 'Driver' },
      host: this._localDescription(),
    };
    this._send(conn, payload);
    if (player) player.lastSeen = nowMs();
  }

  _localDescription() {
    const ta = this.vehicle.getTelemetry ? this.vehicle.getTelemetry() : {};
    return {
      id: 'local',
      name: this.localName,
      paint: ta.paintHex || PAINT_COLORS.yellow.hex,
      accessories: ta.accessories || null,
      psi: ta.psi ?? 22,
      pos: [this.vehicle.body.position.x, this.vehicle.body.position.y, this.vehicle.body.position.z],
      quat: [
        this.vehicle.body.quaternion.x,
        this.vehicle.body.quaternion.y,
        this.vehicle.body.quaternion.z,
        this.vehicle.body.quaternion.w,
      ],
    };
  }

  /* ---- host receives from a joiner ---- */
  _onHostData(peerId, payload) {
    if (this.role !== 'host' || !payload) return;
    const player = this.remotePlayers.get(peerId);
    if (!player) return;
    player.lastSeen = nowMs();

    switch (payload.type) {
      case 'hello': {
        if (payload.name) {
          player.name = String(payload.name).slice(0, 16);
          const entry = this.players.find((p) => p.id === peerId);
          if (entry) entry.name = player.name;
        }
        this._sendHostSync(player.conn, peerId);
        break;
      }

      case 'state-tick': {
        this._applyTick(player, payload);
        // Fan out so joiners can see each other.
        this._broadcast({ ...payload, playerId: peerId }, peerId);
        break;
      }

      case 'rut-stamp': {
        this._applyRutStamps(payload.stamps);
        this._broadcast({ ...payload, playerId: peerId }, peerId);
        break;
      }

      case 'winch-event': {
        this._handleWinchEvent(peerId, payload);
        this._broadcast({ ...payload, playerId: peerId }, peerId);
        break;
      }

      case 'fuel-transfer': {
        this._handleFuelTransfer(peerId, payload);
        this._broadcast({ ...payload, playerId: peerId }, peerId);
        break;
      }

      case 'mission-event': {
        this._handleMissionEvent(peerId, payload);
        this._broadcast({ ...payload, playerId: peerId }, peerId);
        break;
      }

      case 'player-hint': {
        this._broadcast({ ...payload, playerId: peerId }, peerId);
        break;
      }

      default:
        break;
    }
  }

  /* ================================================================== *
   *  JOINER
   * ================================================================== */

  startJoin(roomCode, _hostPeerIdOrNull, name = 'You') {
    const code = normaliseRoomCode(roomCode);
    if (!code) {
      this._toast('ROOM CODES LOOK LIKE MUD-842');
      return false;
    }
    if (this.role) this.disconnect();

    this.role = 'joiner';
    this.localName = name;
    this.roomCode = code;
    this.hostPeerId = roomCodeToPeerId(code);
    this._resetPlayers();
    this.joining = true;
    this.joinRetries = 0;

    let PeerCtor;
    try {
      PeerCtor = getPeerCtor();
    } catch (err) {
      this.onFatal?.(err.message);
      this.role = null;
      return false;
    }

    try {
      this.peer = new PeerCtor({ debug: 0, config: { iceServers: STUN_SERVERS }, key: PEER_KEY });
    } catch (err) {
      this.onFatal?.(`Could not open a connection: ${err.message || err}`);
      this.role = null;
      return false;
    }

    this.peer.on('open', (id) => {
      this.localPeerId = id;
      this.onConnectionState?.('CONTACTING HOST');
      this._connectToHost();
    });

    this.peer.on('error', (err) => {
      const type = err?.type || '';
      if (type === 'peer-unavailable') {
        this._toast('NO ROOM WITH THAT CODE', 'bad');
        this.onConnectionState?.('NO SUCH ROOM');
        this.joining = false;
        return;
      }
      this._toast(`PEER ${err?.message || type || err}`);
    });

    this.peer.on('disconnected', () => {
      this._toast('CONNECTION DROPPED — RECONNECTING');
      try { this.peer.reconnect(); } catch { /* gone */ }
    });

    this.peer.on('close', () => {
      if (this.role !== 'joiner') return;
      this.onStateChange?.(null, null, null);
    });

    return true;
  }

  _connectToHost() {
    if (!this.peer || !this.hostPeerId) return;
    try {
      this.hostConn = this.peer.connect(this.hostPeerId, {
        reliable: true,
        metadata: { name: this.localName },
      });
    } catch {
      this._toast('CANNOT REACH THAT ROOM');
      this.joining = false;
      return;
    }

    this.hostConn.on('open', () => {
      this.joining = false;
      this.onConnectionState?.('CONNECTED');
      this._send(this.hostConn, { type: 'hello', name: this.localName });
      this._toast(`JOINED ROOM ${this.roomCode}`, 'good');
      this.onStateChange?.(this.role, this.roomCode, this.hostPeerId);
    });

    this.hostConn.on('data', (payload) => this._onJoinerData(payload));

    this.hostConn.on('close', () => {
      this._toast('HOST LEFT THE ROOM', 'bad');
      this.onConnectionState?.('DISCONNECTED');
      this.onStateChange?.(null, null, null);
    });

    this.hostConn.on('error', () => {
      this._toast('CONNECTION ERROR');
      this.joining = false;
    });
  }

  _onJoinerData(payload) {
    if (this.role !== 'joiner' || !payload) return;

    switch (payload.type) {
      case 'host-sync': {
        this._applyHostSync(payload);
        break;
      }
      case 'state-tick': {
        const player = this.remotePlayers.get(payload.playerId);
        if (player) this._applyTick(player, payload);
        break;
      }
      case 'rut-stamp': {
        this._applyRutStamps(payload.stamps);
        break;
      }
      case 'winch-event': {
        this._handleWinchEvent(payload.playerId, payload);
        break;
      }
      case 'fuel-transfer': {
        this._handleFuelTransfer(payload.playerId, payload);
        break;
      }
      case 'mission-event': {
        this._handleMissionEvent(payload.playerId, payload);
        break;
      }
      case 'player-left': {
        this._removeRemote(payload.playerId);
        break;
      }
      default:
        break;
    }
  }

  _applyHostSync(payload) {
    // Mission first: the bridge may need to exist before we place trucks.
    if (this.missionManager) this.missionManager.setState(payload.missionState);

    // The host truck becomes a remote player on this client.
    if (payload.host) {
      this._ensureRemote({
        id: 'local', // the host is "local" on its own machine
        name: payload.host.name || 'Host',
        paint: payload.host.paint,
        accessories: payload.host.accessories,
        psi: payload.host.psi,
        pos: payload.host.pos,
        quat: payload.host.quat,
        connection: this.hostConn,
      });
    }

    for (const p of payload.players || []) {
      if (p.local) continue;
      if (p.id === this.localPeerId) continue;
      this._ensureRemote({ id: p.id, name: p.name });
    }

    // Spawn the local truck next to the host's.
    this._spawnLocalAlongside(payload.spawnPos, payload.spawnHeading);

    this.onPlayerJoined?.({ id: 'local', name: payload.host?.name || 'Host' });
    this._toast(`SQUAD ${1 + this.remotePlayers.size}/4`, 'good');
  }

  _spawnLocalAlongside(spawnPos, spawnHeading) {
    const terrain = this.terrain;
    const vehicle = this.vehicle;

    const pos = spawnPos
      ? new THREE.Vector3(spawnPos[0], spawnPos[1], spawnPos[2])
      : terrain.spawn.position.clone();
    const heading = spawnHeading ?? terrain.spawn.heading;

    // Offset sideways from the host so the two trucks are not inside each other.
    const lane = 2.6;
    const sideX = Math.cos(heading) * lane;
    const sideZ = -Math.sin(heading) * lane;
    const x = pos.x + sideX;
    const z = pos.z + sideZ;
    const y = terrain.getHeightAt(x, z) + 1.3;

    vehicle.reset();
    vehicle.body.position.set(x, y, z);
    vehicle.body.quaternion.setFromEuler(0, heading, 0);
    vehicle.body.velocity.set(0, 0, 0);
    vehicle.body.angularVelocity.set(0, 0, 0);
    vehicle.body.aabbNeedsUpdate = true;
    vehicle.body.updateAABB();

    if (this.trailer) {
      const t = this.trailer;
      const hx = x - Math.sin(heading) * 6.4;
      const hz = z - Math.cos(heading) * 6.4;
      t.reset();
      t.body.position.set(hx, terrain.getHeightAt(hx, hz) + 1.3, hz);
      t.body.quaternion.setFromEuler(0, heading, 0);
      t.body.velocity.set(0, 0, 0);
      t.body.angularVelocity.set(0, 0, 0);
      t.body.aabbNeedsUpdate = true;
      t.body.updateAABB();
      if (typeof t._rebuildMesh === 'function') t._rebuildMesh();
      if (typeof t._rebuildPhysics === 'function') t._rebuildPhysics();
    }
  }

  /* ================================================================== *
   *  remote trucks (visual + physics mirror)
   * ================================================================== */

  _ensureRemote({ id, name, paint, accessories, psi, pos, quat, connection }) {
    let player = this.remotePlayers.get(id);
    if (player) {
      if (name) player.name = name;
      if (connection) player.conn = connection;
      return player;
    }

    player = new RemotePlayer(id, name);
    player.paint = paint || PAINT_COLORS.yellow.hex;
    player.accessories = accessories || null;
    player.psi = psi ?? 22;
    player.conn = connection || null;

    if (pos) {
      player.pos.set(pos[0], pos[1], pos[2]);
      if (quat) player.quaternion.set(quat[0], quat[1], quat[2], quat[3]);
      player.pushSample(nowMs());
    }

    this.remotePlayers.set(id, player);
    this._buildRemoteTruck(player);
    this.onPlayerJoined?.({ id, name: player.name });
    return player;
  }

  _buildRemoteTruck(player) {
    // --- visual: a real SUV using the same mesh builder as the local truck
    const builder = new VehicleMeshBuilder({
      paint: player.paint,
      wheelRadius: 0.46,
      wheelWidth: 0.3,
    });
    const group = builder.group;
    if (player.accessories) {
      for (const key of Object.keys(player.accessories)) {
        if (builder.setAccessory) builder.setAccessory(key, player.accessories[key]);
        else if (builder.accessoryGroups && builder.accessoryGroups[key]) {
          builder.accessoryGroups[key].visible = !!player.accessories[key];
        }
      }
    }
    if (builder.setTirePressure) builder.setTirePressure(player.psi);
    group.position.copy(player.pos);
    group.quaternion.copy(player.quaternion);
    group.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
    this.scene.add(group);

    // --- physics: a kinematic-ish shell so the local truck can bump into it
    const body = new CANNON.Body({
      mass: 0, // moved by ticks only; winch forces are applied to the owner client
      type: CANNON.Body.KINEMATIC,
      shape: new CANNON.Box(new CANNON.Vec3(1.0, 0.7, 2.1)),
      position: new CANNON.Vec3(player.pos.x, player.pos.y, player.pos.z),
      quaternion: new CANNON.Quaternion(
        player.quaternion.x,
        player.quaternion.y,
        player.quaternion.z,
        player.quaternion.w,
      ),
      collisionFilterGroup: PHYS_GROUPS.REMOTE,
      collisionFilterMask: PHYS_GROUPS.VEHICLE | PHYS_GROUPS.REMOTE,
      material: new CANNON.Material('remote-truck'),
    });
    body.updateAABB();
    this.world.addBody(body);

    player.body = body;
    player.mesh = group;
    player.builder = builder;

    // Rescue beacon that appears when this teammate pings for help.
    const beacon = new THREE.Group();
    const beam = new THREE.Mesh(
      new THREE.ConeGeometry(0.6, 1.4, 12, 1, true),
      new THREE.MeshBasicMaterial({ color: 0xffb648, transparent: true, opacity: 0.4, side: THREE.DoubleSide, depthWrite: false }),
    );
    beam.rotation.x = Math.PI;
    beam.position.y = 0.7;
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(0.85, 0.06, 8, 20),
      new THREE.MeshBasicMaterial({ color: 0xffb648, transparent: true, opacity: 0.85, depthWrite: false }),
    );
    ring.rotation.x = Math.PI / 2;
    beacon.add(beam, ring);
    beacon.visible = false;
    this.scene.add(beacon);
    player.beacon = beacon;

    if (this.winchSystem) {
      this.winchSystem.addRemoteVehicle(player, body, group);
    }
  }

  _applyTick(player, payload) {
    if (payload.seq != null) {
      if (payload.seq <= player.lastSeq) return; // stale / duplicate
      player.lastSeq = payload.seq;
    }
    player.lastSeen = nowMs();

    const p = payload.pos;
    const q = payload.quat;
    if (!p || !q) return;

    player.pos.set(p[0], p[1], p[2]);
    player.quaternion.set(q[0], q[1], q[2], q[3]);
    if (payload.vel) player.vel.set(payload.vel[0], payload.vel[1], payload.vel[2]);
    if (payload.steer != null) player.steer = payload.steer;
    if (payload.wheelRot != null) player.wheelRot = payload.wheelRot;
    if (payload.wheelSink) player.wheelSink = payload.wheelSink;
    if (payload.psi != null) player.psi = payload.psi;
    if (payload.paint) player.paint = payload.paint;
    if (payload.accessories) player.accessories = payload.accessories;
    if (payload.a != null) player.awd = payload.a;
    if (payload.hb != null) player.handbrake = payload.hb;
    if (payload.gear) player.gear = payload.gear;
    if (payload.help != null) player.helpPing = !!payload.help;

    this._updateBeacon(player);
    player.pushSample(nowMs());
  }

  /* ---- 20 Hz send + interpolation ---- */

  update(dt, now = nowMs()) {
    if (!this.role) return;

    // Remote trucks are smoothed every frame.
    this._integrateRemotes(now);

    this._tickAccum += dt * 1000;
    if (this._tickAccum < TICK_MS) return;
    this._tickAccum -= TICK_MS;
    if (this._tickAccum > TICK_MS * 4) this._tickAccum = 0; // drop a long stall

    this._sendLocalTick();
    this._flushRutStamps(dt);
    this._evictQuietPlayers(now);
  }

  _sendLocalTick() {
    const connected = this.isConnected;
    if (!connected) return;

    const ta = this.vehicle.getTelemetry ? this.vehicle.getTelemetry() : {};
    // The host's truck is keyed as "local" on every other client (that is how
    // host-sync creates it), so its ticks must carry that key too.
    const selfId = this.role === 'host' ? 'local' : this.localPeerId;
    // getTelemetry() does not include the physics body, so attach it here.
    const payload = {
      type: 'state-tick',
      playerId: selfId,
      seq: ++this._sendSeq,
      ...vehicleSnapshot({ ...ta, body: this.vehicle.body }),
    };

    if (this.role === 'host') this._broadcast(payload);
    else this._send(this.hostConn, payload);
  }

  _flushRutStamps(dt) {
    this._rutAccum += dt * 1000;
    if (this._rutAccum < RUT_BATCH_MS) return;
    this._rutAccum = 0;

    const rut = this.rutSystem;
    if (!rut || typeof rut.takeLocalStamps !== 'function') return;
    const stamps = rut.takeLocalStamps();
    if (!stamps || !stamps.length) return;

    const payload = { type: 'rut-stamp', playerId: this.localPeerId, stamps };
    if (this.role === 'host') this._broadcast(payload);
    else this._send(this.hostConn, payload);
  }

  _applyRutStamps(stamps) {
    if (!this.rutSystem || !Array.isArray(stamps) || !stamps.length) return;
    if (typeof this.rutSystem.applyRemoteStamps === 'function') {
      this.rutSystem.applyRemoteStamps(stamps);
    }
  }

  /** Render remote trucks ~110 ms in the past, between the two newest samples. */
  _integrateRemotes(now) {
    const renderTime = now - INTERP_DELAY_MS;

    for (const player of this.remotePlayers.values()) {
      if (!player.hasSample) continue;

      const s = player.samples;
      let a = s[0];
      let b = s[s.length - 1];
      for (let i = s.length - 1; i >= 0; i -= 1) {
        if (s[i].t <= renderTime) {
          a = s[i];
          b = s[i + 1] || s[i];
          break;
        }
      }

      const span = b.t - a.t;
      const alpha = span > 1 ? Math.min(1, Math.max(0, (renderTime - a.t) / span)) : 1;

      player.renderPos.lerpVectors(a.pos, b.pos, alpha);
      player.renderQuat.slerpQuaternions(a.quat, b.quat, alpha);

      if (player.mesh) {
        player.mesh.position.copy(player.renderPos);
        player.mesh.quaternion.copy(player.renderQuat);
      }

      // Spin the remote wheels so a teammate's truck does not look frozen.
      if (player.builder && player.builder.wheels) {
        for (const wheel of player.builder.wheels) {
          if (wheel && wheel.spin) wheel.spin.rotation.x = player.wheelRot;
          if (wheel && wheel.pivot) wheel.pivot.rotation.y = player.steer;
        }
      }

      if (player.body) {
        player.body.position.set(player.renderPos.x, player.renderPos.y, player.renderPos.z);
        player.body.quaternion.set(
          player.renderQuat.x,
          player.renderQuat.y,
          player.renderQuat.z,
          player.renderQuat.w,
        );
        player.body.aabbNeedsUpdate = true;
        player.body.updateAABB();
      }
    }
  }

  /**
   * Safety net only: a peer is dropped when its channel is actually closed.
   * Tick silence alone must not evict anyone — a backgrounded (throttled) tab
   * pauses its render loop, which looks identical to a dead peer on the wire.
   */
  /** Float a rescue marker over a teammate who pressed H. */
  _updateBeacon(player) {
    const beacon = player.beacon;
    if (!beacon) return;
    beacon.visible = !!player.helpPing;
    if (!beacon.visible) return;
    const p = player.renderPos;
    beacon.position.set(p.x, p.y + 3.4, p.z);
    beacon.rotation.y += 0.06;
  }

  _evictQuietPlayers(now) {
    for (const [id, player] of this.remotePlayers) {
      const silent = now - player.lastSeen > PLAYER_TIMEOUT_MS;
      const channelClosed = player.conn ? !player.conn.open : false;
      if (silent && channelClosed) {
        this._toast(`${player.name.toUpperCase()} LEFT THE ROOM`);
        this._removeRemote(id);
      }
    }
  }

  _removeRemote(peerId) {
    const player = this.remotePlayers.get(peerId);
    if (!player) return;

    if (player.mesh) {
      this.scene.remove(player.mesh);
      player.mesh.traverse?.((o) => {
        if (o.isMesh) {
          o.geometry?.dispose?.();
          if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose?.());
          else o.material?.dispose?.();
        }
      });
    }
    if (player.body) {
      try { this.world.removeBody(player.body); } catch { /* gone */ }
    }
    if (player.beacon) {
      this.scene.remove(player.beacon);
      player.beacon.traverse?.((o) => {
        if (o.isMesh) {
          o.geometry?.dispose?.();
          o.material?.dispose?.();
        }
      });
      player.beacon = null;
    }
    if (this.winchSystem) this.winchSystem.removeRemoteVehicle(player);

    this.remotePlayers.delete(peerId);
    this.connections.delete(peerId);
    this.players = this.players.filter((p) => p.id !== peerId);
    this.onPlayerLeft?.(peerId);
    this.onStateChange?.(this.role, this.roomCode, this.hostPeerId);
  }

  _dropPlayer(peerId) {
    if (!this.remotePlayers.has(peerId)) return;
    this._removeRemote(peerId);
    if (this.role === 'host') {
      this._broadcast({ type: 'player-left', playerId: peerId });
      this._toast('A DRIVER LEFT');
    }
  }

  /* ================================================================== *
   *  outgoing events
   * ================================================================== */

  /**
   * Winch packet.
   *  action 'attach'  — "I have hooked your truck"
   *  action 'force'   — the pull force to apply to the target (N, world space)
   *  action 'release' — cable let go
   */
  onWinchFired(sourceId, payload) {
    if (!this.role) return;
    const out = { type: 'winch-event', playerId: sourceId ?? this.localPeerId, ...payload };
    if (this.role === 'host') {
      this._broadcast(out);
      this._handleWinchEvent('local', out);
    } else {
      this._send(this.hostConn, out);
    }
  }

  onFuelTransfer(sourceId, payload) {
    if (!this.role) return;
    const out = { type: 'fuel-transfer', playerId: sourceId ?? this.localPeerId, ...payload };
    if (this.role === 'host') {
      this._broadcast(out);
      this._handleFuelTransfer('local', out);
    } else {
      this._send(this.hostConn, out);
    }
  }

  sendMissionEvent(type, data = {}) {
    const out = { type: 'mission-event', playerId: this.localPeerId, event: type, ...data };
    if (!this.role) {
      // Solo play: apply to our own mission manager only.
      this.missionManager?.applyEvent('local', out);
      return;
    }
    if (this.role === 'host') {
      this._broadcast(out);
      this._handleMissionEvent('local', out);
    } else {
      this._send(this.hostConn, out);
    }
  }

  /** Back-compat shim: older code called this for mission sync. */
  sendEvent(type, data) {
    this.sendMissionEvent(type, data);
  }

  /* ---- receive handlers ---- */

  _handleWinchEvent(sourcePeerId, payload) {
    // A force packet addressed at us means "your truck is on the cable".
    const winch = this.winchSystem;
    // Other clients know the host's truck as "local", so accept both keys.
    const isForMe = payload.targetId === this.localPeerId ||
      payload.targetId === 'local';
    if (winch && payload.action === 'force' && isForMe) {
      winch.applyExternalWinchForce(payload.force, payload.anchorPos);
    }
    if (winch && payload.action === 'attach' && payload.targetId === this.localPlayerKey()) {
      this._toast('A TEAMMATE HOOKED YOUR TRUCK', 'good');
    }
    if (winch && typeof winch.onRemoteWinchFired === 'function') {
      winch.onRemoteWinchFired(payload.playerId ?? sourcePeerId, payload);
    }
  }

  _handleFuelTransfer(sourcePeerId, payload) {
    // Only the addressed client actually refuels.
    const mine = this.localPeerId || 'local';
    const addressedToMe =
      payload.targetId === mine ||
      payload.targetId === 'local' ||
      payload.targetId === this.localPlayerKey();
    if (!addressedToMe) return;

    const amount = Math.max(0, Math.min(40, Number(payload.amount) || 0));
    if (!amount) return;
    const v = this.vehicle;
    v.fuel = Math.min(v.fuelCapacity, v.fuel + amount);
    this._toast(`+${amount.toFixed(0)}L FUEL RECEIVED`, 'good');
  }

  _handleMissionEvent(sourcePeerId, payload) {
    // Phase-7 clock sync is atmosphere state, not a mission event.
    if (payload.event === 'time-sync' || payload.type === 'time-sync') {
      this.onTimeSync?.(payload);
      return;
    }
    if (!this.missionManager) return;
    if (payload.event === undefined && payload.type !== 'mission-event') return;
    const event = payload.event ?? payload.mission;
    if (!event) return;
    this.missionManager.applyEvent(payload.playerId ?? sourcePeerId, { type: event, ...payload });
  }

  /** The key this client's own truck is known by to the others. */
  localPlayerKey() {
    // The host is "local" on its own machine and its peer id elsewhere.
    return this.localPeerId || 'local';
  }

  /* ================================================================== *
   *  teardown
   * ================================================================== */

  disconnect() {
    for (const id of [...this.remotePlayers.keys()]) this._removeRemote(id);
    for (const conn of this.connections.values()) {
      try { conn.close(); } catch { /* gone */ }
    }
    this.connections.clear();

    if (this.hostConn) {
      try { this.hostConn.close(); } catch { /* gone */ }
      this.hostConn = null;
    }
    if (this.peer) {
      try { this.peer.destroy(); } catch { /* gone */ }
      this.peer = null;
    }

    this.role = null;
    this.roomCode = null;
    this.hostPeerId = null;
    this.localPeerId = null;
    this.joining = false;
    this._resetPlayers();
    this.onStateChange?.(null, null, null);
  }

  _resetPlayers() {
    this.players = [{ id: 'local', name: this.localName || 'You', local: true, host: true }];
    this.remotePlayers.clear();
  }

  /* ---- HUD helpers ---- */
  getPlayerList() {
    const list = [{ id: 'local', name: 'You', local: true }];
    for (const [id, p] of this.remotePlayers) {
      // Everyone calls themselves "You" locally, which reads badly in a squad
      // list — show the puzzle of names as the other driver / the host.
      const name = p.name && p.name !== 'You' ? p.name : (id === 'local' ? 'Host' : 'Driver');
      list.push({ id, name, local: false, paint: p.paint, speed: p.vel.length() });
    }
    return list;
  }
}

export { PAINT_ORDER };
