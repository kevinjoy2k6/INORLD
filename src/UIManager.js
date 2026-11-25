/* ============================================================================
 * UIManager — Phase 6
 *
 * Owns:
 *  - lobby overlay DOM (solo / host / join, paint picker, accessories)
 *  - tactical HUD wiring (speedometer, RPM bar, gearbox strip, PSI controller,
 *    action chips, squad list, mission tracker)
 *  - touch UI (steer, pedals, action chips, PSI slider)
 *
 * Reads from:
 *  - vehicle (OffroadVehicle)
 *  - trailer (TrailerRig)
 *  - winchSystem (WinchSystem)
 *  - missionManager (MissionManager)
 *  - networkManager (NetworkManager)
 *  - cameraController (CameraController)
 *  - quality (QualityManager)
 *
 * This module does NOT own game logic; it is purely UI binding.
 * ========================================================================== */

import { PAINT_COLORS, PAINT_ORDER, ACCESSORIES, ACCESSORY_ORDER } from './VehicleMeshBuilder.js';
import { normaliseRoomCode } from './NetworkManager.js';

export class UIManager {
  constructor({
    vehicle,
    trailer,
    winchSystem,
    missionManager,
    networkManager,
    cameraController,
    quality,
    held,
  }) {
    this.vehicle = vehicle;
    this.trailer = trailer;
    this.winchSystem = winchSystem;
    this.missionManager = missionManager;
    this.networkManager = networkManager;
    this.cameraController = cameraController;
    this.quality = quality;
    // Shared with the driving loop so touch pedals actually move the truck.
    this.held = held ?? { throttle: false, brake: false, left: false, right: false };
    // null = decide from the device; true/false = the player chose.
    this._touchOverride = null;

    this.lobbyEl = document.getElementById('lobby');
    this.hudEl = document.getElementById('hud');
    this.touchEl = document.getElementById('touch-ui');
    this.toastEl = document.getElementById('toast');

    this._bindLobby();
    this._bindHud();
    this._bindTouch();
    this._refreshPaintGrid();
    this._refreshAccGrid(vehicle.accessories);

    this._showLobby();
  }

  /* ================================================================== *
   *  LOBBY
   * ================================================================== */
  _bindLobby() {
    // Paint picker.
    const paintGrid = document.getElementById('paint-grid');
    PAINT_ORDER.forEach((key) => {
      const color = PAINT_COLORS[key];
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'paint-btn';
      btn.dataset.paint = key;
      btn.title = color.label;
      const swatch = document.createElement('span');
      swatch.className = 'paint-swatch';
      // `hex` is a number: template it straight into CSS and it becomes a
      // decimal string, which parses as #RRGGBBAA with a ~2 % alpha.
      swatch.style.background = `#${color.hex.toString(16).padStart(6, '0')}`;
      const label = document.createElement('span');
      label.className = 'paint-label';
      label.textContent = key === 'sand' ? 'TAN' : key === 'olive' ? 'OLIVE' : key === 'orange' ? 'ORANGE' : key === 'blue' ? 'BLUE' : key.toUpperCase();
      btn.appendChild(swatch);
      btn.appendChild(label);
      btn.addEventListener('click', () => {
        this._selectPaint(key);
      });
      paintGrid.appendChild(btn);
    });

    // Accessories.
    const accGrid = document.getElementById('acc-grid');
    ACCESSORY_ORDER.forEach((id) => {
      const def = ACCESSORIES[id];
      if (!def) return;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'acc-btn';
      btn.dataset.accessory = id;
      const hint = def.requires && ACCESSORIES[def.requires]
        ? 'needs ' + ACCESSORIES[def.requires].label
        : '';
      btn.innerHTML = `${def.label}<small>${hint}</small>`;
      accGrid.appendChild(btn);
    });

    // One delegated listener for the whole grid. It is registered on the DOM
    // node (not on `this`) and guarded, because a second per-button listener
    // would toggle the accessory twice per click and cancel itself out.
    if (accGrid && !accGrid.dataset.delegated) {
      accGrid.dataset.delegated = '1';
      accGrid.addEventListener('click', (event) => {
        const btn = event.target.closest ? event.target.closest('.acc-btn') : null;
        if (!btn || !accGrid.contains(btn)) return;
        // Belt and braces: ignore a duplicate event for the same gesture.
        const now = performance.now();
        if (this._lastAccClickAt && now - this._lastAccClickAt < 40) return;
        this._lastAccClickAt = now;
        this._toggleAccessoryById(btn.dataset.accessory);
      });
    }

    // Play buttons.
    document.querySelectorAll('[data-lobby]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const action = btn.dataset.lobby;
        switch (action) {
          case 'solo':
            this._startSolo();
            break;
          case 'host':
            this._startHost();
            break;
          case 'join':
            this._showJoinRow();
            break;
          case 'join-go':
            this._doJoin();
            break;
        }
      });
    });

    const copyBtn = document.getElementById('copy-room-code');
    if (copyBtn) {
      copyBtn.addEventListener('click', () => {
        const code = this._currentRoomCode;
        if (code) {
          this._copyToClipboard(code);
          this._toast('ROOM CODE COPIED');
        }
      });
    }

    const joinInput = document.getElementById('join-code-input');
    if (joinInput) {
      joinInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          this._doJoin();
        }
      });
    }
  }

  _refreshPaintGrid() {
    const grid = document.getElementById('paint-grid');
    if (!grid) return;
    const current = this.vehicle.paintHex;
    Array.from(grid.children).forEach((btn) => {
      const key = btn.dataset.paint;
      const color = PAINT_COLORS[key];
      btn.classList.toggle('selected', color && color.hex === current);
    });
  }

  _selectPaint(key) {
    const color = PAINT_COLORS[key];
    if (!color) return;
    this.vehicle.setPaint(color.hex);
    this._refreshPaintGrid();
    this._toast(color.label.toUpperCase());
  }

  _toggleAccessoryById(id) {
    const def = ACCESSORIES[id];
    if (!def) return;
    if (this._isAccDisabled(id)) {
      const need = def.requires ? (ACCESSORIES[def.requires]?.label ?? 'OTHER GEAR') : 'ROOF RACK';
      this._toast(def.label.toUpperCase() + ' NEEDS ' + need);
      return;
    }
    const before = this.vehicle.hasAccessory(id);
    this.vehicle.toggleAccessory(id);
    const after = this.vehicle.hasAccessory(id);
    this._refreshAccGrid(this.vehicle.accessories);
    this._toast(after ? def.label.toUpperCase() + ' FITTED' : def.label.toUpperCase() + ' REMOVED');
    if (after === before) {
      // The truck refused the change (unmet requirement); say so clearly.
      this._toast(def.label.toUpperCase() + ' NOT AVAILABLE');
    }
  }

  _refreshAccGrid(accessories) {
    const grid = document.getElementById('acc-grid');
    if (!grid) return;
    Array.from(grid.children).forEach((btn) => {
      const id = btn.dataset.accessory;
      // Read the live truck state; `accessories` is kept for signature
      // compatibility but can be a stale snapshot after a rejected toggle.
      const on = this.vehicle.hasAccessory(id);
      btn.classList.toggle('selected', on);
      btn.classList.toggle('disabled', this._isAccDisabled(id));
      // Lock the button if it's not available yet.
      btn.disabled = this._isAccDisabled(id);
    });
  }

  _isAccDisabled(id) {
    const def = ACCESSORIES[id];
    if (!def) return false;
    if (def.requires) {
      const parentOn = this.vehicle.hasAccessory(def.requires);
      // Bullbar requires spareWheel; truckRack/JerryCans require roofRack.
      if (!parentOn) return true;
    }
    // If the accessory is already on and the user wants it off, it's fine.
    return false;
  }

  _isAccRequiredFor(id) {
    const def = ACCESSORIES[id];
    return def && def.requires ? !!def.requires : false;
  }

  _getRequiredAccFor(id) {
    const def = ACCESSORIES[id];
    return def && def.requires ? def.requires : null;
  }

  _getRequiredLabel(id) {
    const req = this._getRequiredAccFor(id);
    if (!req) return '';
    return ACCESSORIES[req] ? ACCESSORIES[req].label.toUpperCase() : '';
  }

  /* ---- play modes ---- */
  _startSolo() {
    this._toast('SOLO EXPEDITION');
    this._enterGame();
  }

  _startHost() {
    if (this.networkManager.isHost) {
      this.networkManager.disconnect();
      this._toast('HOST STOPPED');
      return;
    }
    if (this.networkManager.isJoined) {
      this.networkManager.disconnect();
      this._toast('LEFT HOST');
    }
    this.networkManager.startHost('You');
    this._showHostUI();
    // Hosting is playing: drop straight into the world. The room code lives in
    // the HUD's net panel (and the COPY button) once the peer opens.
    this._enterGame();
  }

  _startJoin(code) {
    this._toast('CONNECTING TO ' + code);
    this.networkManager.startJoin(code, this._currentHostPeerId || null, 'You');
  }

  _doJoin() {
    const input = document.getElementById('join-code-input');
    // Accept "TEG645", "teg-645" or "TEG 645" — normaliseRoomCode does the rest.
    const code = normaliseRoomCode(input?.value);
    if (!code) {
      this._toast('ENTER THE 6-CHARACTER ROOM CODE');
      return;
    }
    this._hideJoinRow();
    this._startJoin(code);
  }

  _showJoinRow() {
    const row = document.getElementById('join-row');
    if (row) row.style.display = 'flex';
    this._hideHostUI();
  }

  _hideJoinRow() {
    const row = document.getElementById('join-row');
    if (row) row.style.display = 'none';
  }

  _showHostUI() {
    const copyBtn = document.getElementById('copy-room-code');
    if (copyBtn) copyBtn.style.display = '';
    this._hideJoinRow();
  }

  _hideHostUI() {
    const copyBtn = document.getElementById('copy-room-code');
    if (copyBtn) copyBtn.style.display = 'none';
    this._hideJoinRow();
  }

  /* ---- lobby -> game transition ---- */
  _showLobby() {
    this._inLobby = true;
    if (this.lobbyEl) {
      this.lobbyEl.hidden = false;
      this.lobbyEl.style.display = 'grid';
    }
    if (this.hudEl) this.hudEl.hidden = true;
    if (this.touchEl) this.touchEl.hidden = true;
  }

  _enterGame() {
    this._inLobby = false;
    if (this.lobbyEl) this.lobbyEl.style.display = 'none';
    if (this.hudEl) {
      this.hudEl.hidden = false;
      this.hudEl.style.display = '';
    }
    // Show touch UI on touch devices (but allow the user to toggle it off).
    if (this._isTouchDevice()) {
      this._showTouchUI(true);
    }
  }

  /* ---- network state wiring ---- */
  _onNetworkStateChange(role, roomCode, hostPeerId) {
    // Update the lobby's host row copy button.
    this._currentRoomCode = roomCode || null;
    this._currentHostPeerId = hostPeerId || null;

    // A successful join means we are in the world, not sitting in the lobby.
    if (role === 'joiner' && roomCode) this._enterGame();

    const copyBtn = document.getElementById('copy-room-code');
    if (copyBtn) {
      copyBtn.style.display = (role === 'host' && roomCode) ? '' : 'none';
    }

    const netState = document.getElementById('hud-net-state');
    const netCode = document.getElementById('hud-net-code');
    const netCodeRow = document.getElementById('hud-net-code-row');
    if (netState) {
      netState.textContent = role ? 'CONNECTED AS ' + role.toUpperCase() : 'OFFLINE';
      netState.classList.toggle('online', !!role);
    }
    if (netCodeRow) {
      netCodeRow.style.display = (roomCode && role) ? 'flex' : 'none';
    }
    if (netCode) {
      netCode.textContent = roomCode || '—';
    }
  }

  /* ---- copy-to-clipboard ---- */
  _copyToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        () => {},
        () => { this._copyFallback(text); }
      );
    } else {
      this._copyFallback(text);
    }
  }

  _copyFallback(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
    } catch {
      // Best effort.
    }
    document.body.removeChild(ta);
  }

  /* ================================================================== *
   *  HUD
   * ================================================================== */
  _bindHud() {
    // Speedometer.
    this._hudSpeed = document.getElementById('hud-speed');
    this._hudGear = document.getElementById('hud-gear');
    this._hudRpm = document.getElementById('hud-rpm');
    this._hudRpmBar = document.getElementById('hud-rpm-bar');
    this._hudFuel = document.getElementById('hud-fuel');
    this._hudFuelRate = document.getElementById('hud-fuel-rate');
    this._hudPsi = document.getElementById('hud-psi');
    this._hudSink = document.getElementById('hud-sink');
    this._hudSurface = document.getElementById('hud-surface');
    this._hudPatch = document.getElementById('hud-patch');
    this._hudQuality = document.getElementById('hud-quality');
    this._hudTier = document.getElementById('hud-tier');
    this._hudFps = document.getElementById('hud-fps');
    this._hudPhysics = document.getElementById('hud-physics');
    this._hudCamera = document.getElementById('hud-camera');
    this._hudWatchtowers = document.getElementById('hud-watchtowers');
    this._hudTimber = document.getElementById('hud-timber');
    this._squadCount = document.getElementById('squad-count');
    this._squadList = document.getElementById('squad-list');

    // Gearbox buttons.
    document.querySelectorAll('#gear-grid [data-hud="gear"]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const gear = btn.dataset.gear;
        this._setGear(gear);
      });
    });
    // Sync initial active state.
    this._syncGearButton();

    // Action chips.
    this._hudAw = document.getElementById('btn-awd');
    this._hudDiff = document.getElementById('btn-diff');
    this._hudWinch = document.getElementById('btn-winch');
    this._hudHitch = document.getElementById('btn-hitch');
    this._hudRefuel = document.getElementById('btn-refuel');
    this._hudHelp = document.getElementById('btn-help');
    this._hudCameraBtn = document.getElementById('btn-camera');
    this._hudTierBtn = document.getElementById('btn-tier');
    this._hudTouchBtn = document.getElementById('btn-touch');
    if (this._hudTouchBtn) this._hudTouchBtn.addEventListener('click', () => this._toggleTouchUI());

    if (this._hudAw) this._hudAw.addEventListener('click', () => this._toggleAwd());
    if (this._hudDiff) this._hudDiff.addEventListener('click', () => this._toggleDiffLock());
    if (this._hudWinch) this._hudWinch.addEventListener('click', () => this._toggleWinch());
    if (this._hudHitch) this._hudHitch.addEventListener('click', () => this._toggleHitch());
    if (this._hudRefuel) this._hudRefuel.addEventListener('click', () => this._doRefuel());
    if (this._hudHelp) this._hudHelp.addEventListener('click', () => this._doHelpPing());
    if (this._hudCameraBtn) this._hudCameraBtn.addEventListener('click', () => this._toggleCamera());
    if (this._hudTierBtn) this._hudTierBtn.addEventListener('click', () => this._cycleTier());

    // PSI slider.
    const psiSlider = document.getElementById('psi-slider');
    if (psiSlider) {
      psiSlider.addEventListener('input', () => {
        const val = parseFloat(psiSlider.value);
        if (!isNaN(val)) {
          this.vehicle.setPSI(val);
          this._updatePsiTelemetry(val);
        }
      });
    }

    // PSI quick buttons.
    document.querySelectorAll('.psi-quick-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const val = parseFloat(btn.dataset.psi);
        if (!isNaN(val)) {
          this.vehicle.setPSI(val);
          this._updatePsiTelemetry(val);
          // Sync slider.
          const slider = document.getElementById('psi-slider');
          if (slider) slider.value = val;
        }
      });
    });

    // HUD net copy button.
    const copyCodeBtn = document.getElementById('hud-copy-code');
    if (copyCodeBtn) {
      copyCodeBtn.addEventListener('click', () => {
        const code = this._currentRoomCode;
        if (code) {
          this._copyToClipboard(code);
          this._toast('ROOM CODE COPIED');
        } else {
          this._toast('NO ACTIVE ROOM');
        }
      });
    }

    // Initial PSI telemetry.
    this._updatePsiTelemetry(this.vehicle.psi);
  }

  /* ---- per-frame HUD update ---- */
  update(dt) {
    const t = this.vehicle.getTelemetry();
    if (this._hudSpeed) this._hudSpeed.textContent = Math.round(t.speedKmh).toString();
    if (this._hudGear) this._hudGear.textContent = t.gear;
    if (this._hudRpm) this._hudRpm.textContent = Math.round(t.rpm).toString();
    if (this._hudRpmBar) {
      this._hudRpmBar.style.width = `${Math.round(t.rpmPct * 100)}%`;
    }
    if (this._hudFuel) this._hudFuel.textContent = t.fuel.toFixed(1);
    if (this._hudFuelRate) this._hudFuelRate.textContent = t.fuelLpm.toFixed(1);
    if (this._hudPsi) this._hudPsi.textContent = t.psi.toFixed(1);
    if (this._hudSink) this._hudSink.textContent = t.sinkCm.toFixed(1);
    if (this._hudSurface) this._hudSurface.textContent = t.surface;
    if (this._hudPatch) {
      const pct = ((t.psiGrip ?? 1) - 1) * 100;
      this._hudPatch.textContent = (pct >= 0 ? '+' : '') + pct.toFixed(0) + '%';
    }
    if (this._hudQuality) this._hudQuality.textContent = this.quality.settings.label;
    if (this._hudTier) this._hudTier.textContent = this.quality.tier.toUpperCase();
    if (this._hudFps) {
      // fpsSmoothed is updated in main loop; we read the smoothed value from a
      // shared module variable updated by main.js.
      this._hudFps.textContent = (window.__fpsSmoothed ?? 60).toFixed(0);
    }
    if (this._hudPhysics) {
      this._hudPhysics.textContent = `${Math.round((1 / this.quality.settings.fixedTimeStep) * this.quality.settings.physicsSubSteps)} Hz`;
    }
    if (this._hudCamera) this._hudCamera.textContent = this.cameraController.modeShort;

    // Action chip states.
    this._syncChip(this._hudAw, !!t.awd);
    this._syncChip(this._hudDiff, !!t.diffLock);
    this._syncChip(this._hudWinch, !!this.winchSystem.activeHook, this.winchSystem.activeHook ? 'danger' : null);
    this._syncChip(this._hudHitch, !!this.trailer.hitched);
    this._syncChip(this._hudRefuel, false); // refuel is a momentary action; only light up while transferring
    this._syncChip(this._hudHelp, !!this.vehicle.helpPingActive, null, true);

    // While the lobby is up, the paint/accessory grids must always mirror the
    // truck's real state — a toggle can be rejected (e.g. unmet requirement).
    if (this._inLobby) {
      this._refreshAccGrid(this.vehicle.accessories);
      this._refreshPaintGrid();
    }

    // Gearbox: active gear.
    this._syncGearButton();

    // PSI slider sync (avoid feedback loops).
    const slider = document.getElementById('psi-slider');
    if (slider && Math.abs(parseFloat(slider.value) - this.vehicle.psi) > 0.01) {
      slider.value = this.vehicle.psi;
    }

    // Watchtower / timber mission counters.
    if (this._hudWatchtowers) {
      const scouted = this.missionManager?.discovered?.size ?? 0;
      const total = this.missionManager?.watchtowers?.length ?? 0;
      this._hudWatchtowers.textContent = `${scouted}/${total}`;
    }
    if (this._hudTimber) {
      const delivered = this.missionManager?.deliveryDelivered ? 2 : 0;
      this._hudTimber.textContent = `${delivered}/2`;
      this._hudTimber.classList.toggle('done', !!this.missionManager?.deliveryDelivered);
    }

    // Squad list.
    this._renderSquadList();

    // Touch PSI value.
    const touchPsiVal = document.getElementById('touch-psi-val');
    if (touchPsiVal) {
      touchPsiVal.textContent = `${Math.round(this.vehicle.psi * 10) / 10} PSI`;
    }
    const touchPsiSlider = document.getElementById('touch-psi');
    if (touchPsiSlider) {
      touchPsiSlider.value = this.vehicle.psi;
    }
  }

  /* ---- chip helper ---- */
  _syncChip(btn, on, variant, helpPing) {
    if (!btn) return;
    const cls = 'chip';
    const variants = [];
    if (on) variants.push('on');
    if (variant) variants.push(variant);
    if (helpPing) variants.push('help-on');

    const current = Array.from(btn.classList).filter((c) => c !== cls);
    const desired = variants;
    const changed = current.length !== desired.length || current.some((c, i) => c !== desired[i]);

    if (changed) {
      btn.classList.remove('on', 'danger', 'help-on');
      for (const v of desired) btn.classList.add(v);
    }
  }

  _syncGearButton() {
    const current = this.vehicle.getTelemetry().gearId || 'AUTO';
    document.querySelectorAll('#gear-grid [data-hud="gear"]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.gear === current);
    });
  }

  _setGear(gear) {
    this.vehicle.setGear(gear);
    this._syncGearButton();
  }

  /* ---- action handlers ---- */
  _toggleAwd() {
    const on = this.vehicle.toggleAWD();
    this._toast(on ? '4WD ENGAGED' : '2WD — REAR DRIVE');
  }

  _toggleDiffLock() {
    const on = this.vehicle.toggleDiffLock();
    this._toast(on ? 'DIFF LOCK ON' : 'DIFF LOCK OFF');
  }

  _toggleWinch() {
    if (this.winchSystem.activeHook) {
      this.winchSystem.detachWinch();
      this._toast('WINCH RELEASED');
    } else {
      const result = this.winchSystem.tryAttachHook(null);
      if (result.ok) {
        this._toast('WINCH ON ' + (result.kind === 'coop' ? 'TEAMMATE' : 'ANCHOR'));
      } else {
        this._toast('NO TARGET IN RANGE');
      }
    }
  }

  _toggleHitch() {
    const result = this.trailer.toggleHitch();
    this._toast(result.message.toUpperCase());
  }

  _doRefuel() {
    const result = this.winchSystem.tryTransferFuel();
    if (!result.ok) {
      this._toast(result.reason?.toUpperCase() ?? 'REFUEL FAILED');
    } else {
      this._toast('TRANSFERRED ' + result.amount.toFixed(0) + 'L');
      // Flash the refuel chip briefly.
      const btn = this._hudRefuel;
      if (btn) {
        btn.classList.add('on');
        setTimeout(() => btn.classList.remove('on'), 600);
      }
    }
  }

  _doHelpPing() {
    this.vehicle.toggleHelpPing();
    this._toast('HELP PING ' + (this.vehicle.helpPingActive ? 'ACTIVE' : 'CLEARED'));
  }

  _toggleCamera() {
    const mode = this.cameraController.toggleMode();
    this._toast('CAMERA ' + mode.toUpperCase());
  }

  _cycleTier() {
    const settings = this.quality.cycle(1);
    this._toast('QUALITY ' + settings.label);
  }

  _updatePsiTelemetry(psi) {
    const t = this.vehicle.getTelemetry();
    if (this._hudPsi) this._hudPsi.textContent = t.psi.toFixed(1);
    if (this._hudPatch) {
      const pct = ((t.psiGrip ?? 1) - 1) * 100;
      this._hudPatch.textContent = (pct >= 0 ? '+' : '') + pct.toFixed(0) + '%';
    }
  }

  /* ================================================================== *
   *  SQUAD LIST
   * ================================================================== */
  _renderSquadList() {
    const list = this._squadList;
    if (!list) return;
    const nm = this.networkManager;
    // getPlayerList() merges the local truck with every remote truck, which is
    // what the squad panel must show on both the host and the joiner.
    const players = nm.getPlayerList ? nm.getPlayerList() : (nm.players ?? [this._localPlayer()]);
    list.innerHTML = '';
    players.forEach((p) => {
      const row = document.createElement('div');
      row.className = 'squad-row' + (p.local ? ' local' : ' remote');
      const avatar = document.createElement('span');
      avatar.className = 'squad-avatar';
      const name = document.createElement('span');
      name.className = 'squad-name';
      name.textContent = p.name ?? (p.local ? 'You' : 'Player');
      const status = document.createElement('span');
      status.className = 'squad-status';
      if (p.local) {
        status.textContent = 'DRIVING';
      } else {
        const idx = Array.from(nm.remotePlayers?.values() ?? []).findIndex((rp) => rp.id === p.id);
        const rp = idx >= 0 ? nm.remotePlayers?.values?.()[idx] : null;
        status.textContent = rp ? 'CONNECTED' : 'JOINED';
        if (rp?.helpPing) {
          const dot = document.createElement('span');
          dot.className = 'squad-help';
          status.appendChild(dot);
          status.textContent = 'NEEDS HELP';
        }
      }
      row.appendChild(avatar);
      row.appendChild(name);
      row.appendChild(status);
      list.appendChild(row);
    });
    // Update count.
    if (this._squadCount) {
      const total = players.length;
      this._squadCount.textContent = `${total}/4`;
    }
  }

  _localPlayer() {
    return { id: 'local', name: 'You', local: true };
  }

  /* ================================================================== *
   *  TOUCH UI
   * ================================================================== */
  _bindTouch() {
    // Steering.
    const steerL = document.querySelector('[data-touch="steer-left"]');
    const steerR = document.querySelector('[data-touch="steer-right"]');
    if (steerL) this._bindTouchButton(steerL, 'steer-left');
    if (steerR) this._bindTouchButton(steerR, 'steer-right');

    // Pedals.
    const brake = document.querySelector('[data-touch="brake"]');
    const throttle = document.querySelector('[data-touch="throttle"]');
    if (brake) this._bindTouchButton(brake, 'brake');
    if (throttle) this._bindTouchButton(throttle, 'throttle');

    // Action chips.
    document.querySelectorAll('.touch-chip').forEach((btn) => {
      btn.addEventListener('click', () => {
        const action = btn.dataset.touch;
        switch (action) {
          case 'awd':
            this._toggleAwd();
            break;
          case 'diff':
            this._toggleDiffLock();
            break;
          case 'winch':
            this._toggleWinch();
            break;
          case 'hitch':
            this._toggleHitch();
            break;
          case 'refuel':
            this._doRefuel();
            break;
          case 'help':
            this._doHelpPing();
            break;
          case 'camera':
            this._toggleCamera();
            break;
          case 'quality':
            this._cycleTier();
            break;
        }
        this._syncTouchChip(btn, action);
      });
    });

    // PSI slider.
    const touchPsi = document.getElementById('touch-psi');
    if (touchPsi) {
      touchPsi.addEventListener('input', () => {
        const val = parseFloat(touchPsi.value);
        if (!isNaN(val)) {
          this.vehicle.setPSI(val);
          const valEl = document.getElementById('touch-psi-val');
          if (valEl) valEl.textContent = `${val} PSI`;
        }
      });
    }

    // Sync initial touch chip states.
    this._syncTouchChips();
  }

  _bindTouchButton(btn, action) {
    if (!btn) return;
    const down = (e) => {
      e.preventDefault();
      btn.classList.add('active');
      if (action === 'throttle') this.held.throttle = true;
      else if (action === 'brake') this.held.brake = true;
      else if (action === 'steer-left') this.held.left = true;
      else if (action === 'steer-right') this.held.right = true;
    };
    const up = (e) => {
      if (e) e.preventDefault();
      btn.classList.remove('active');
      if (action === 'throttle') this.held.throttle = false;
      else if (action === 'brake') this.held.brake = false;
      else if (action === 'steer-left') this.held.left = false;
      else if (action === 'steer-right') this.held.right = false;
    };
    btn.addEventListener('pointerdown', down);
    btn.addEventListener('pointerup', up);
    btn.addEventListener('pointercancel', up);
    btn.addEventListener('pointerleave', up);
  }

  _syncTouchChip(btn, action) {
    if (!btn) return;
    const on = this._touchActionState(action);
    btn.classList.toggle('on', on);
    if (action === 'winch' && on) {
      btn.classList.add('danger');
    } else {
      btn.classList.remove('danger');
    }
    if (action === 'help' && on) {
      btn.classList.add('help-on');
    } else {
      btn.classList.remove('help-on');
    }
  }

  _syncTouchChips() {
    document.querySelectorAll('.touch-chip').forEach((btn) => {
      this._syncTouchChip(btn, btn.dataset.touch);
    });
  }

  _touchActionState(action) {
    switch (action) {
      case 'awd': return !!this.vehicle.getTelemetry().awd;
      case 'diff': return !!this.vehicle.getTelemetry().diffLock;
      case 'winch': return !!this.winchSystem.activeHook;
      case 'hitch': return !!this.trailer.hitched;
      case 'refuel': return false;
      case 'help': return !!this.vehicle.helpPingActive;
      default: return false;
    }
  }

  _showTouchUI(force) {
    if (!this.touchEl) return;
    const show = force !== undefined ? force : this._isTouchDevice();
    this.touchEl.hidden = !show;
    this.touchEl.style.display = show ? '' : 'none';
    // A manual choice wins over auto-detection for the rest of the session.
    if (force !== undefined) this._touchOverride = force;
    // The HUD stacks itself above the on-screen controls when this is set.
    document.body.classList.toggle('touch-on', show);
    const state = document.getElementById('hud-touch-state');
    if (state) state.textContent = show ? 'ON' : 'OFF';
    const btn = document.getElementById('btn-touch');
    if (btn) btn.classList.toggle('on', show);
  }

  _toggleTouchUI() {
    const next = !this.touchEl || this.touchEl.hidden || this.touchEl.style.display === 'none';
    this._showTouchUI(next);
    this._toast(next ? 'TOUCH UI ON' : 'TOUCH UI OFF');
  }

  _isTouchDevice() {
    if (this._touchOverride !== undefined && this._touchOverride !== null) {
      return this._touchOverride;
    }
    const coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
    const hasTouch = navigator.maxTouchPoints > 0;
    // A mouse-first device can still report touch points; only show the on-screen
    // controls when there is no fine pointer available at all.
    const hasFine = window.matchMedia && window.matchMedia('(any-pointer: fine)').matches;
    return hasTouch && coarse && !hasFine;
  }

  /* ================================================================== *
   *  TOAST
   * ================================================================== */
  _toast(text) {
    if (!this.toastEl) return;
    this.toastEl.textContent = text;
    this.toastEl.classList.add('show');
    window.clearTimeout(this._toastTimer);
    this._toastTimer = window.setTimeout(() => {
      this.toastEl.classList.remove('show');
    }, 1400);
  }

  /* ---- utility ---- */
  _refreshLobbyFromVehicle() {
    this._refreshPaintGrid();
    this._refreshAccGrid(this.vehicle.accessories);
  }

  /* ---- exposed for main.js to call on network events ---- */
  setNetworkCallbacks() {
    const nm = this.networkManager;
    nm.onStateChange = (role, roomCode, hostPeerId) => this._onNetworkStateChange(role, roomCode, hostPeerId);
    nm.onPlayerJoined = (player) => {
      // NetworkManager also fires this with null when a joiner's handshake lands.
      this._toast('PLAYER JOINED: ' + (player?.name ?? 'Squadmate'));
    };
    nm.onPlayerLeft = () => this._toast('PLAYER LEFT');
  }
}
