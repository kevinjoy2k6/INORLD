/* ============================================================================
 * ExpeditionHUD — the "Over the Hill × SnowRunner" instrument cluster.
 *
 *   • Tactile H-gate gear shifter (R / N / A / H / L- / L / L+) with an animated
 *     knob, tap-to-select slots and Q / E / Shift / bracket support.
 *   • CTIS air-pressure cluster: analog needle gauge, live tyre cross-section,
 *     contact-patch bonus, sinkage, slider, hold-to-inflate/deflate and presets.
 *   • Drivetrain rocker switches (4WD / DIFF / WINCH / TRAILER / REFUEL) with a
 *     mini chassis LED diagram, plus speed, RPM arc and fuel burn.
 *   • Expedition pill (room code, squad distances, mission progress, SOS) and a
 *     utility bar (FPS, preset cycler, camera, beams, photo, settings).
 *   • Full mobile cockpit: rotatable wheel or arrow pads, progressive pedals,
 *     the gear gate and a quick drawer — all multi-touch by pointerId.
 *
 * The HUD never owns simulation state: it reads telemetry and calls the same
 * vehicle / winch / mission APIs the keyboard does.
 * ========================================================================== */

import { CAMERA_MODE_LABEL } from './CameraController.js';

function el(tag, className, html) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (html !== undefined) node.innerHTML = html;
  return node;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/** Arc path for the PSI gauge, angles in degrees clockwise from 12 o'clock. */
function arcPath(cx, cy, r, startDeg, endDeg) {
  const rad = (deg) => ((deg - 90) * Math.PI) / 180;
  const x1 = cx + r * Math.cos(rad(startDeg));
  const y1 = cy + r * Math.sin(rad(startDeg));
  const x2 = cx + r * Math.cos(rad(endDeg));
  const y2 = cy + r * Math.sin(rad(endDeg));
  const large = Math.abs(endDeg - startDeg) > 180 ? 1 : 0;
  return `M${x1.toFixed(2)} ${y1.toFixed(2)} A${r} ${r} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`;
}

const PSI_MIN = 8;
const PSI_MAX = 35;
const PSI_SWEEP = 240; // degrees, centred on 12 o'clock

function psiToDegrees(psi) {
  const t = clamp((psi - PSI_MIN) / (PSI_MAX - PSI_MIN), 0, 1);
  return -PSI_SWEEP / 2 + t * PSI_SWEEP;
}

export class ExpeditionHUD {
  constructor({
    optimizer,
    vehicle,
    trailer,
    winchSystem,
    missionManager,
    networkManager,
    cameraController,
    atmosphere,
    audio,
    held,
    toast,
    settingsUI = null,
  }) {
    this.optimizer = optimizer;
    this.vehicle = vehicle;
    this.trailer = trailer;
    this.winchSystem = winchSystem;
    this.missionManager = missionManager;
    this.networkManager = networkManager;
    this.cameraController = cameraController;
    this.atmosphere = atmosphere;
    this.audio = audio;
    this.held = held;
    this.toast = toast || (() => {});
    this.settingsUI = settingsUI;

    this.visible = false;
    this.pillCollapsed = false;
    this._uiTimer = 0;
    this._telemetry = null;
    this._psiDragging = false;
    this._holdTimers = new Map();
    this._pointers = new Map();

    this._build();
    this._bind();
    this.applySettings(this.optimizer.settings);
    this.optimizer.subscribe((settings) => this.applySettings(settings));
  }

  /* ================================================================== *
   *  markup
   * ================================================================== */

  _build() {
    const hud = el('div');
    hud.id = 'xh-hud';
    hud.hidden = true;
    hud.innerHTML = `
      <!-- ================= TOP LEFT ================= -->
      <div id="xh-pill" class="xh-panel">
        <div class="xh-pill-head">
          <span class="xh-pill-title">Expedition</span>
          <button class="xh-pill-toggle" type="button" data-xh-pill-toggle aria-label="Collapse expedition panel">▾</button>
        </div>
        <div class="xh-pill-body">
          <div class="xh-room"><span class="xh-label">Room</span><b data-xh-room>SOLO</b></div>
          <div class="xh-squad-list" data-xh-squad></div>
          <div class="xh-mission-row"><span>WATCHTOWERS</span><b data-xh-towers>0/3</b></div>
          <div class="xh-mission-row"><span>TIMBER</span><b data-xh-timber>0/2</b></div>
          <div class="xh-mission-row"><span data-xh-next-label>NEXT</span><b data-xh-next>—</b></div>
          <div class="xh-progress"><i data-xh-mission-bar></i></div>
          <button class="xh-btn rust wide" type="button" data-xh-sos>⛑ SOS WINCH BEACON <kbd>H</kbd></button>
        </div>
      </div>

      <!-- ================= TOP RIGHT ================= -->
      <div id="xh-topbar">
        <div class="xh-fps good" data-xh-fps><b>60</b><small>FPS</small></div>
        <button class="xh-preset-pill" type="button" data-cycle-preset title="Cycle graphics preset">⚙ HIGH</button>
        <button class="xh-btn" type="button" data-xh-camera title="Camera mode (C)">VISTA</button>
        <button class="xh-btn" type="button" data-xh-lights title="Headlights (L)">BEAMS</button>
        <button class="xh-btn" type="button" data-xh-photo title="Photo mode (P)">PHOTO</button>
        <button class="xh-btn" type="button" data-open-settings title="Settings (ESC)">⚙</button>
      </div>

      <!-- ================= BOTTOM LEFT: PSI ================= -->
      <div id="xh-psi" class="xh-panel">
        <div class="xh-psi-top">
          <div class="xh-gauge">
            <svg viewBox="0 0 100 100" aria-hidden="true">
              <path d="${arcPath(50, 50, 38, -120, -66.7)}" stroke="#e5a93c" stroke-width="6" fill="none" stroke-linecap="round" opacity="0.9"/>
              <path d="${arcPath(50, 50, 38, -64.7, 22.2)}" stroke="#5e8c6a" stroke-width="6" fill="none" stroke-linecap="round" opacity="0.9"/>
              <path d="${arcPath(50, 50, 38, 24.2, 120)}" stroke="#f4efe6" stroke-width="6" fill="none" stroke-linecap="round" opacity="0.55"/>
              <g class="xh-gauge-needle" data-xh-needle transform="rotate(0 50 50)">
                <line x1="50" y1="50" x2="50" y2="19" stroke="#f4efe6" stroke-width="2.6" stroke-linecap="round"/>
                <circle cx="50" cy="50" r="3.4" fill="#e5a93c" stroke="#161a1d" stroke-width="1.4"/>
              </g>
              <text x="50" y="72" text-anchor="middle" fill="rgba(244,239,230,.55)" font-size="7" font-family="ui-monospace, monospace">PSI</text>
            </svg>
            <div class="xh-gauge-readout" data-xh-psi-readout>22.0</div>
          </div>
          <div class="xh-tire-wrap">
            <span class="xh-label">CTIS · Tyre flotation</span>
            <svg class="xh-tire" viewBox="0 0 120 46" aria-hidden="true">
              <rect x="34" y="0" width="52" height="10" rx="4" fill="#2a2e33" stroke="#3a3f45"/>
              <g class="xh-tire-body" data-xh-tire-body>
                <rect x="10" y="8" width="100" height="30" rx="13" fill="#1b1e21" stroke="#4a5057" stroke-width="1.4"/>
                <rect x="26" y="13" width="68" height="20" rx="9" fill="#2b3036" stroke="#4a5057" stroke-width="1"/>
                <ellipse cx="60" cy="38" rx="44" ry="3.4" fill="rgba(0,0,0,.45)"/>
              </g>
            </svg>
            <div class="xh-psi-stats">
              <span>PATCH <b data-xh-patch>+0%</b></span>
              <span>SINK <b data-xh-sink>0.0</b>cm</span>
            </div>
          </div>
        </div>
        <input class="xh-psi-slider" type="range" min="${PSI_MIN}" max="${PSI_MAX}" step="0.5" value="22" data-xh-psi-slider aria-label="Tyre pressure" />
        <div class="xh-psi-buttons">
          <button class="xh-btn xh-hold" type="button" data-xh-psi-hold="-1">− PSI</button>
          <button class="xh-btn" type="button" data-xh-psi-preset="18">18 TRAIL</button>
          <button class="xh-btn xh-hold" type="button" data-xh-psi-hold="1">+ PSI</button>
        </div>
        <div class="xh-psi-presets">
          <button class="xh-btn" type="button" data-xh-psi-preset="32">32 ROAD</button>
          <button class="xh-btn" type="button" data-xh-psi-preset="18">18 TRAIL</button>
          <button class="xh-btn" type="button" data-xh-psi-preset="10">10 BOG</button>
        </div>
      </div>

      <!-- ================= BOTTOM CENTER: DRIVETRAIN ================= -->
      <div id="xh-drivetrain" class="xh-panel">
        <div class="xh-switch-row">
          <button class="xh-btn xh-switch sage" type="button" data-xh-switch="awd"><span class="xh-dot"></span>4WD<kbd>N</kbd></button>
          <button class="xh-btn xh-switch" type="button" data-xh-switch="diff"><span class="xh-dot"></span>DIFF<kbd>G</kbd></button>
          <button class="xh-btn xh-switch rust" type="button" data-xh-switch="winch"><span class="xh-dot"></span>WINCH<kbd>F</kbd></button>
          <button class="xh-btn xh-switch" type="button" data-xh-switch="hitch"><span class="xh-dot"></span>TRAILER<kbd>T</kbd></button>
          <button class="xh-btn xh-switch" type="button" data-xh-switch="refuel"><span class="xh-dot"></span>REFUEL<kbd>E</kbd></button>
        </div>
        <svg class="xh-chassis" viewBox="0 0 150 40" aria-hidden="true">
          <rect x="26" y="12" width="98" height="15" rx="4" fill="rgba(244,239,230,.10)" stroke="rgba(244,239,230,.22)"/>
          <rect x="34" y="7" width="34" height="7" rx="2" fill="rgba(244,239,230,.14)"/>
          <line x1="34" y1="27" x2="116" y2="27" stroke="rgba(229,169,60,.35)" stroke-width="1.6" stroke-dasharray="3 3"/>
          <g data-xh-axle-front>
            <circle cx="40" cy="32" r="6" fill="#12161a" stroke="rgba(244,239,230,.3)"/>
            <circle class="xh-chassis-lamp" data-xh-lamp="front" cx="40" cy="32" r="2" fill="#5e8c6a"/>
          </g>
          <g data-xh-axle-rear>
            <circle cx="110" cy="32" r="6" fill="#12161a" stroke="rgba(244,239,230,.3)"/>
            <circle class="xh-chassis-lamp" data-xh-lamp="rear" cx="110" cy="32" r="2" fill="#5e8c6a"/>
          </g>
          <circle class="xh-chassis-lamp" data-xh-lamp="diff" cx="85" cy="19" r="2.6" fill="#5a5f66"/>
          <circle class="xh-chassis-lamp" data-xh-lamp="winch" cx="26" cy="19" r="2.6" fill="#5a5f66"/>
        </svg>
        <div class="xh-progress"><i data-xh-winch-bar style="background: linear-gradient(90deg,#5e8c6a,#d9534f)"></i></div>
        <div class="xh-engine-row">
          <div class="xh-speed"><b data-xh-speed>0</b><span>KM/H</span></div>
          <div class="xh-rpm">
            <svg class="xh-rpm-arc" viewBox="0 0 100 40" aria-hidden="true">
              <path d="M8 34 A40 40 0 0 1 92 34" stroke="rgba(244,239,230,.16)" stroke-width="5" fill="none" stroke-linecap="round"/>
              <path data-xh-rpm-path d="M8 34 A40 40 0 0 1 92 34" stroke="#e5a93c" stroke-width="5" fill="none" stroke-linecap="round"
                    stroke-dasharray="126" stroke-dashoffset="126"/>
            </svg>
            <span class="xh-label"><span data-xh-rpm>780</span> RPM · <span data-xh-gear>N</span></span>
          </div>
          <div class="xh-fuel">
            <span class="xh-label"><span data-xh-fuel>80.0</span> L · <span data-xh-burn>0.4</span> L/MIN</span>
            <div class="xh-fuel-bar"><i data-xh-fuel-bar style="width:100%"></i></div>
          </div>
        </div>
      </div>

      <!-- ================= BOTTOM RIGHT: GEAR GATE ================= -->
      <div id="xh-gate" class="xh-panel">
        <div class="xh-gate-head">
          <span class="xh-label">Shift gate</span>
          <span class="xh-gate-sub" data-xh-gate-sub>A1</span>
        </div>
        <div data-xh-gate-mount></div>
      </div>
    `;
    document.body.appendChild(hud);
    this.root = hud;

    const gateMount = hud.querySelector('[data-xh-gate-mount]');
    this.gate = this._buildGate(gateMount, false);

    /* ---- mobile cockpit ---- */
    const touch = el('div');
    touch.id = 'xh-touch';
    touch.innerHTML = `
      <div class="xh-touch-left">
        <div class="xh-wheel" data-xh-wheel aria-label="Steering wheel">
          <svg viewBox="0 0 140 140">
            <circle cx="70" cy="70" r="62" fill="rgba(22,26,29,.72)" stroke="rgba(244,239,230,.18)" stroke-width="3"/>
            <circle cx="70" cy="70" r="52" fill="none" stroke="rgba(244,239,230,.14)" stroke-width="14"/>
            <g data-xh-wheel-rot>
              <path d="M70 22 L70 62" stroke="#e5a93c" stroke-width="7" stroke-linecap="round"/>
              <path d="M26 96 L58 78" stroke="rgba(244,239,230,.7)" stroke-width="7" stroke-linecap="round"/>
              <path d="M114 96 L82 78" stroke="rgba(244,239,230,.7)" stroke-width="7" stroke-linecap="round"/>
              <circle cx="70" cy="70" r="17" fill="#161a1d" stroke="#e5a93c" stroke-width="3"/>
            </g>
            <text x="70" y="74" text-anchor="middle" fill="#f4efe6" font-size="11" font-family="ui-monospace, monospace" data-xh-wheel-label>0°</text>
          </svg>
        </div>
        <div class="xh-arrows">
          <button class="xh-arrow" type="button" data-xh-arrow="left" aria-label="steer left">◀</button>
          <button class="xh-arrow" type="button" data-xh-arrow="right" aria-label="steer right">▶</button>
        </div>
        <div class="xh-wheel-deg" data-xh-steerdeg>0°</div>
        <button class="xh-steer-toggle" type="button" data-xh-steer-toggle>Wheel ⇄ Arrows</button>
      </div>
      <div class="xh-touch-right">
        <div class="xh-quick-drawer">
          <button class="xh-btn sage" type="button" data-xh-quick="awd">4WD</button>
          <button class="xh-btn" type="button" data-xh-quick="diff">DIFF</button>
          <span class="xh-psi-chip" data-xh-psi-chip>22 PSI</span>
          <button class="xh-btn" type="button" data-xh-quick="psi-">PSI−</button>
          <button class="xh-btn" type="button" data-xh-quick="psi+">PSI+</button>
          <button class="xh-btn rust" type="button" data-xh-quick="winch">WINCH</button>
          <button class="xh-btn" type="button" data-xh-quick="camera">CAM</button>
        </div>
        <div class="xh-pedals">
          <button class="xh-pedal brake" type="button" data-xh-pedal="brake">
            <span class="xh-pedal-fill" data-xh-pedal-fill="brake"></span>
            <span class="xh-pedal-label">BRAKE</span>
          </button>
          <button class="xh-pedal" type="button" data-xh-pedal="throttle">
            <span class="xh-pedal-fill" data-xh-pedal-fill="throttle"></span>
            <span class="xh-pedal-label">GAS</span>
          </button>
        </div>
        <div class="xh-panel xh-mobile-gate" data-xh-mobile-gate></div>
      </div>
    `;
    document.body.appendChild(touch);
    this.touch = touch;
    this.gateMobile = this._buildGate(touch.querySelector('[data-xh-mobile-gate]'), true);

    this.refs = this._collectRefs();
  }

  /** Shared SVG gate builder so desktop and mobile share one visual language. */
  _buildGate(mount, compact) {
    const slots = [
      { id: 'R', cx: 30, cy: 28 },
      { id: 'AUTO', cx: 80, cy: 28, label: 'A' },
      { id: 'H', cx: 130, cy: 28 },
      { id: 'L-', cx: 130, cy: 64, low: true },
      { id: 'L', cx: 130, cy: 92, low: true },
      { id: 'L+', cx: 130, cy: 120, low: true },
    ];

    const rects = slots
      .map(
        (slot) => `
        <g class="xh-gate-slot${slot.low ? ' xh-slot-low' : ''}" data-xh-slot="${slot.id}" data-cx="${slot.cx}" data-cy="${slot.cy}">
          <rect x="${slot.cx - 15}" y="${slot.cy - 11}" width="30" height="22" rx="5"/>
          <text x="${slot.cx}" y="${slot.cy + 0.5}">${slot.label || slot.id}</text>
        </g>`,
      )
      .join('');

    mount.innerHTML = `
      <svg class="xh-gate-svg" viewBox="0 0 160 ${compact ? 150 : 150}" aria-label="Gear shift gate">
        <path class="xh-gate-track" d="M30 28 H130" />
        <path class="xh-gate-track" d="M80 28 V86" />
        <path class="xh-gate-track" d="M130 28 V120" />
        <g class="xh-xh-slot-auto" data-xh-slot-auto>
          <path class="xh-gate-track" d="M80 86 V112" opacity="0.4"/>
        </g>
        ${rects}
        <g class="xh-gate-slot xh-slot-a" data-xh-slot="AUTO" data-cx="80" data-cy="86" style="display:none">
          <rect x="65" y="75" width="30" height="22" rx="5"/>
          <text x="80" y="86.5">A</text>
        </g>
        <g class="xh-gate-knob" data-xh-gate-knob>
          <circle cx="30" cy="28" r="7"/>
        </g>
      </svg>
      <div class="xh-gate-hint">TAP A SLOT · Q / E / [ ] · SHIFT = RANGE</div>
    `;
    return {
      mount,
      slots: Array.from(mount.querySelectorAll('[data-xh-slot]')),
      knob: mount.querySelector('[data-xh-gate-knob]'),
      sub: mount,
      pos: { R: [30, 28], AUTO: [80, 28], H: [130, 28], 'L-': [130, 64], L: [130, 92], 'L+': [130, 120] },
    };
  }

  _collectRefs() {
    const q = (sel) => this.root.querySelector(sel);
    const tq = (sel) => this.touch.querySelector(sel);
    return {
      room: q('[data-xh-room]'),
      squad: q('[data-xh-squad]'),
      towers: q('[data-xh-towers]'),
      timber: q('[data-xh-timber]'),
      nextLabel: q('[data-xh-next-label]'),
      next: q('[data-xh-next]'),
      missionBar: q('[data-xh-mission-bar]'),
      fps: q('[data-xh-fps] b'),
      fpsBox: q('[data-xh-fps]'),
      presetPill: document.querySelector('[data-cycle-preset]'),
      cameraBtn: q('[data-xh-camera]'),
      lightsBtn: q('[data-xh-lights]'),
      photoBtn: q('[data-xh-photo]'),
      psiReadout: q('[data-xh-psi-readout]'),
      needle: q('[data-xh-needle]'),
      tireBody: q('[data-xh-tire-body]'),
      patch: q('[data-xh-patch]'),
      sink: q('[data-xh-sink]'),
      psiSlider: q('[data-xh-psi-slider]'),
      speed: q('[data-xh-speed]'),
      rpm: q('[data-xh-rpm]'),
      rpmPath: q('[data-xh-rpm-path]'),
      gearLabel: q('[data-xh-gear]'),
      gateSub: q('[data-xh-gate-sub]'),
      fuel: q('[data-xh-fuel]'),
      burn: q('[data-xh-burn]'),
      fuelBar: q('[data-xh-fuel-bar]'),
      winchBar: q('[data-xh-winch-bar]'),
      swAwd: q('[data-xh-switch="awd"]'),
      swDiff: q('[data-xh-switch="diff"]'),
      swWinch: q('[data-xh-switch="winch"]'),
      swHitch: q('[data-xh-switch="hitch"]'),
      swRefuel: q('[data-xh-switch="refuel"]'),
      lampFront: q('[data-xh-lamp="front"]'),
      lampRear: q('[data-xh-lamp="rear"]'),
      lampDiff: q('[data-xh-lamp="diff"]'),
      lampWinch: q('[data-xh-lamp="winch"]'),
      psiChip: tq('[data-xh-psi-chip]'),
      wheelRot: tq('[data-xh-wheel-rot]'),
      wheelLabel: tq('[data-xh-wheel-label]'),
      steerDeg: tq('[data-xh-steerdeg]'),
      pedalThrottle: tq('[data-xh-pedal="throttle"]'),
      pedalBrake: tq('[data-xh-pedal="brake"]'),
      fillThrottle: tq('[data-xh-pedal-fill="throttle"]'),
      fillBrake: tq('[data-xh-pedal-fill="brake"]'),
    };
  }

  /* ================================================================== *
   *  interactions
   * ================================================================== */

  _bind() {
    const q = (sel) => this.root.querySelector(sel);

    q('[data-xh-pill-toggle]').addEventListener('click', () => {
      this.pillCollapsed = !this.pillCollapsed;
      q('#xh-pill').classList.toggle('collapsed', this.pillCollapsed);
    });

    q('[data-xh-sos]').addEventListener('click', () => {
      const active = this.vehicle.toggleHelpPing();
      this.toast(active ? 'HELP PING SENT' : 'HELP PING CLEARED');
    });

    q('[data-xh-camera]').addEventListener('click', () => {
      const mode = this.cameraController.toggleMode();
      this.toast(CAMERA_MODE_LABEL[mode]);
    });

    q('[data-xh-lights]').addEventListener('click', () => {
      this.toast(this.atmosphere.toggleHeadlights() ? 'BEAMS ON' : 'BEAMS OFF');
    });

    q('[data-xh-photo]').addEventListener('click', () => {
      const active = this.atmosphere.togglePhotoMode();
      document.body.classList.toggle('xh-photo', active);
      this.toast(active ? 'PHOTO MODE — P TO EXIT' : 'PHOTO MODE OFF');
    });

    /* ---- gear gate (desktop + mobile share the same handlers) ---- */
    for (const gate of [this.gate, this.gateMobile]) {
      gate.mount.addEventListener('click', (event) => {
        const slot = event.target.closest('[data-xh-slot]');
        if (!slot) return;
        this._selectGear(slot.dataset.xhSlot);
      });
    }

    /* ---- PSI ---- */
    const slider = q('[data-xh-psi-slider]');
    slider.addEventListener('pointerdown', () => { this._psiDragging = true; });
    window.addEventListener('pointerup', () => { this._psiDragging = false; });
    slider.addEventListener('input', () => {
      this.vehicle.setPSI(Number(slider.value));
    });

    for (const button of this.root.querySelectorAll('[data-xh-psi-preset]')) {
      button.addEventListener('click', () => {
        this.vehicle.setPSI(Number(button.dataset.xhPsiPreset));
        this.toast(`TYRES ${this.vehicle.psi.toFixed(1)} PSI`);
      });
    }

    for (const button of this.root.querySelectorAll('[data-xh-psi-hold]')) {
      const direction = Number(button.dataset.xhPsiHold);
      const start = (event) => {
        event.preventDefault();
        this.vehicle.adjustPSI(direction);
        this._startHold(`psi${direction}`, 130, () => this.vehicle.adjustPSI(direction));
      };
      const stop = () => this._stopHold(`psi${direction}`);
      button.addEventListener('pointerdown', start);
      button.addEventListener('pointerup', stop);
      button.addEventListener('pointerleave', stop);
      button.addEventListener('pointercancel', stop);
    }

    /* ---- drivetrain switches ---- */
    this._onClick('[data-xh-switch="awd"]', () => this.toast(this.vehicle.toggleAWD() ? '4WD ENGAGED' : '2WD REAR DRIVE'));
    this._onClick('[data-xh-switch="diff"]', () => this.toast(this.vehicle.toggleDiffLock() ? 'DIFF LOCK ON' : 'DIFF LOCK OFF'));
    this._onClick('[data-xh-switch="winch"]', () => this._toggleWinch());
    this._onClick('[data-xh-switch="hitch"]', () => {
      const result = this.trailer.toggleHitch();
      this.toast(String(result.message || '').toUpperCase());
    });
    this._onClick('[data-xh-switch="refuel"]', () => {
      const result = this.winchSystem.tryTransferFuel();
      this.toast(result.ok ? 'FUEL TRANSFERRED' : String(result.reason || 'NO TEAMMATE IN RANGE').toUpperCase());
    });

    /* ---- mobile cockpit ---- */
    this._bindWheel();
    this._bindArrows();
    this._bindPedals();
    this._bindTouchQuick();

    this.touch.querySelector('[data-xh-steer-toggle]').addEventListener('click', () => {
      const next = this.optimizer.settings.steeringStyle === 'arrows' ? 'wheel' : 'arrows';
      this.optimizer.applySettings({ steeringStyle: next }, { markCustom: false });
      this.toast(next === 'arrows' ? 'STEERING: ARROWS' : 'STEERING: WHEEL');
    });

    /* ---- tilt steering ---- */
    this._onOrientation = (event) => {
      if (this.optimizer.settings.steeringStyle !== 'tilt') return;
      const gamma = clamp(event.gamma || 0, -30, 30);
      this.held.steerAxis = clamp(gamma / 25, -1, 1);
    };
    window.addEventListener('deviceorientation', this._onOrientation);

    // The cockpit breakpoint follows the live viewport, not just the device.
    window.addEventListener('resize', () => this.applySettings(this.optimizer.settings));

    /* ---- photo mode exit keeps the HUD class in sync ---- */
    window.addEventListener('keydown', (event) => {
      if (event.code === 'KeyP') {
        document.body.classList.toggle('xh-photo', !!this.atmosphere.photo.active);
      }
    });
  }

  _onClick(selector, handler) {
    const node = this.root.querySelector(selector);
    if (node) node.addEventListener('click', handler);
  }

  _toggleWinch() {
    if (this.winchSystem.activeHook) {
      this.winchSystem.detachWinch();
      this.toast('WINCH RELEASED');
    } else {
      const result = this.winchSystem.tryAttachHook(null);
      this.toast(result.ok ? 'WINCH ATTACHED' : 'NO TARGET IN RANGE');
    }
  }

  _selectGear(id) {
    const labels = { 'L-': 'L−', L: 'L', 'L+': 'L+', AUTO: 'AUTO', H: 'HIGH', R: 'REVERSE' };
    this.vehicle.setGear(id);
    this.audio?.clunk?.(0.7);
    this.toast(`GEAR ${labels[id] || id}`);
    this._syncGate(this.vehicle.getTelemetry());
  }

  _startHold(key, intervalMs, fn) {
    this._stopHold(key);
    this._holdTimers.set(key, window.setInterval(fn, intervalMs));
  }

  _stopHold(key) {
    const timer = this._holdTimers.get(key);
    if (timer) {
      window.clearInterval(timer);
      this._holdTimers.delete(key);
    }
  }

  /* ---- steering wheel ---- */
  _bindWheel() {
    const wheel = this.touch.querySelector('[data-xh-wheel]');
    const refs = this.refs;
    let pointerId = null;
    let center = { x: 0, y: 0 };
    let baseAngle = 0;
    let current = 0;

    const angleAt = (event) => {
      const dx = event.clientX - center.x;
      const dy = event.clientY - center.y;
      return (Math.atan2(dy, dx) * 180) / Math.PI;
    };

    const apply = (degrees) => {
      const limited = clamp(degrees, -450, 450);
      current = limited;
      refs.wheelRot.setAttribute('transform', `rotate(${limited.toFixed(1)} 70 70)`);
      refs.wheelLabel.textContent = `${Math.round(limited)}°`;
      refs.steerDeg.textContent = `${Math.round(limited)}°`;
      this.held.steerAxis = clamp(limited / 140, -1, 1);
    };

    wheel.addEventListener('pointerdown', (event) => {
      if (this.optimizer.settings.steeringStyle === 'arrows') return;
      event.preventDefault();
      pointerId = event.pointerId;
      try { wheel.setPointerCapture(pointerId); } catch { /* synthetic pointers */ }
      const rect = wheel.getBoundingClientRect();
      center = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      baseAngle = angleAt(event) - current;
    });

    wheel.addEventListener('pointermove', (event) => {
      if (event.pointerId !== pointerId) return;
      event.preventDefault();
      apply(angleAt(event) - baseAngle);
    });

    const release = (event) => {
      if (pointerId === null || (event && event.pointerId !== pointerId)) return;
      pointerId = null;
      // Self-centre like a real wheel.
      const step = () => {
        current *= 0.78;
        if (Math.abs(current) < 0.6) {
          current = 0;
          refs.wheelRot.setAttribute('transform', 'rotate(0 70 70)');
          refs.wheelLabel.textContent = '0°';
          refs.steerDeg.textContent = '0°';
          this.held.steerAxis = 0;
          return;
        }
        apply(current);
        window.requestAnimationFrame(step);
      };
      window.requestAnimationFrame(step);
    };

    wheel.addEventListener('pointerup', release);
    wheel.addEventListener('pointercancel', release);
  }

  /* ---- arrow pads ---- */
  _bindArrows() {
    for (const button of this.touch.querySelectorAll('[data-xh-arrow]')) {
      const dir = button.dataset.xhArrow === 'left' ? -1 : 1;
      const press = (event) => {
        event.preventDefault();
        this.held.left = dir < 0;
        this.held.right = dir > 0;
        this.held.steerAxis = dir;
        button.classList.add('on');
      };
      const release = (event) => {
        if (event) event.preventDefault();
        this.held.left = false;
        this.held.right = false;
        this.held.steerAxis = 0;
        button.classList.remove('on');
      };
      button.addEventListener('pointerdown', press);
      button.addEventListener('pointerup', release);
      button.addEventListener('pointerleave', release);
      button.addEventListener('pointercancel', release);
    }
  }

  /* ---- pedals: progressive by vertical slide ---- */
  _bindPedals() {
    const attachments = [
      { node: this.refs.pedalThrottle, fill: this.refs.fillThrottle, key: 'throttleAxis', held: 'throttle' },
      { node: this.refs.pedalBrake, fill: this.refs.fillBrake, key: 'brakeAxis', held: 'brake' },
    ];

    for (const pedal of attachments) {
      let pointerId = null;

      const valueAt = (event) => {
        const rect = pedal.node.getBoundingClientRect();
        const t = 1 - (event.clientY - rect.top) / rect.height;
        return clamp(t, 0, 1);
      };

      const apply = (value) => {
        this.held[pedal.key] = value;
        this.held[pedal.held] = value > 0.08;
        pedal.fill.style.height = `${Math.round(value * 100)}%`;
        pedal.node.classList.toggle('pressed', value > 0.08);
      };

      const down = (event) => {
        event.preventDefault();
        pointerId = event.pointerId;
        try { pedal.node.setPointerCapture(pointerId); } catch { /* synthetic pointers */ }
        apply(Math.max(0.35, valueAt(event))); // a tap is at least a third throttle
      };

      const move = (event) => {
        if (event.pointerId !== pointerId) return;
        event.preventDefault();
        apply(valueAt(event));
      };

      const up = (event) => {
        if (pointerId === null || (event && event.pointerId !== pointerId)) return;
        pointerId = null;
        apply(0);
      };

      pedal.node.addEventListener('pointerdown', down);
      pedal.node.addEventListener('pointermove', move);
      pedal.node.addEventListener('pointerup', up);
      pedal.node.addEventListener('pointercancel', up);
      pedal.node.addEventListener('pointerleave', up);
    }
  }

  _bindTouchQuick() {
    for (const button of this.touch.querySelectorAll('[data-xh-quick]')) {
      button.addEventListener('click', () => {
        const action = button.dataset.xhQuick;
        if (action === 'awd') {
          button.classList.toggle('on', this.vehicle.toggleAWD());
        } else if (action === 'diff') {
          button.classList.toggle('on', this.vehicle.toggleDiffLock());
        } else if (action === 'psi-') {
          this.vehicle.adjustPSI(-2);
        } else if (action === 'psi+') {
          this.vehicle.adjustPSI(2);
        } else if (action === 'winch') {
          this._toggleWinch();
        } else if (action === 'camera') {
          this.cameraController.toggleMode();
        }
      });
    }
  }

  /* ================================================================== *
   *  settings application
   * ================================================================== */

  applySettings(settings) {
    const root = document.documentElement;
    root.style.setProperty('--xh-touch-scale', String(settings.touchScale));
    root.style.setProperty('--xh-hud-opacity', String(settings.hudOpacity));

    const coarse = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
    // A narrow window gets the cockpit too: that is what a phone actually is.
    const narrow = window.innerWidth <= 720;
    const mobile = settings.inputMode === 'touch' || (settings.inputMode === 'auto' && (coarse || narrow));
    document.body.classList.toggle('xh-mobile', mobile);
    document.body.classList.toggle('xh-steer-arrows', settings.steeringStyle === 'arrows');
    document.body.classList.toggle('xh-trans-auto', settings.transmission === 'auto');

    for (const mount of [this.gate.mount, this.gateMobile.mount]) {
      mount.querySelectorAll('.xh-slot-low').forEach((node) => {
        node.style.display = settings.transmission === 'auto' ? 'none' : '';
      });
    }

    if (this.refs.presetPill) {
      const preset = settings.preset === 'CUSTOM' ? 'CUSTOM' : settings.preset.replace('_', ' ');
      this.refs.presetPill.textContent = `⚙ ${preset}`;
    }

    if (settings.steeringStyle !== 'tilt') {
      this.held.steerAxis = 0;
    }
    if (!mobile) {
      this.held.throttleAxis = 0;
      this.held.brakeAxis = 0;
    }
  }

  /* ================================================================== *
   *  lifecycle
   * ================================================================== */

  show() {
    this.visible = true;
    this.root.hidden = false;
    document.body.classList.add('exp-hud');
  }

  hide() {
    this.visible = false;
    this.root.hidden = true;
    document.body.classList.remove('exp-hud');
  }

  /* ================================================================== *
   *  frame update
   * ================================================================== */

  update(dt, now, telemetry) {
    if (!this.visible) return;
    this._telemetry = telemetry;

    this._uiTimer += dt;
    if (this._uiTimer < 0.08) return;
    const step = this._uiTimer;
    this._uiTimer = 0;

    const t = telemetry || this.vehicle.getTelemetry();
    const refs = this.refs;
    const state = this.optimizer.settings;

    /* ---- utility bar ---- */
    const meter = this.optimizer.getTelemetry();
    refs.fps.textContent = String(meter.fps);
    refs.fpsBox.classList.toggle('good', meter.health === 'good');
    refs.fpsBox.classList.toggle('warn', meter.health === 'warn');
    refs.fpsBox.classList.toggle('bad', meter.health === 'bad');
    if (this.refs.cameraBtn) {
      this.refs.cameraBtn.textContent =
        this.cameraController.mode === 'tactical' ? 'ORBIT' : this.cameraController.mode === 'cockpit' ? 'CABIN' : 'VISTA';
    }
    refs.lightsBtn.classList.toggle('on', !!this.atmosphere.headlightsOn);
    refs.photoBtn.classList.toggle('on', !!this.atmosphere.photo.active);

    /* ---- expedition pill ---- */
    const room = this.networkManager.roomCode;
    refs.room.textContent = room || (this.networkManager.isHost ? 'HOSTING' : this.networkManager.isJoined ? 'JOINED' : 'SOLO');
    this._renderSquad();

    const towersFound = this.missionManager.discovered ? this.missionManager.discovered.size : 0;
    const towersTotal = this.missionManager.watchtowers ? this.missionManager.watchtowers.length : 3;
    const timber = this.missionManager.bundlesDelivered || 0;
    refs.towers.textContent = `${towersFound}/${towersTotal}`;
    refs.timber.textContent = `${timber}/2`;
    const missionPct = towersTotal + 2 > 0 ? ((towersFound + timber) / (towersTotal + 2)) * 100 : 0;
    refs.missionBar.style.width = `${missionPct.toFixed(0)}%`;

    // Where to drive next, and how far. The valley has no minimap, so without
    // this the only navigation aid was finding a watchtower by accident.
    if (refs.next && refs.nextLabel) {
      const objective = this.missionManager.nextObjective?.(this.vehicle.body.position);
      if (objective) {
        refs.nextLabel.textContent = objective.label;
        refs.next.textContent = objective.distance >= 1000
          ? `${(objective.distance / 1000).toFixed(1)} KM`
          : `${Math.round(objective.distance)} M`;
      } else {
        refs.nextLabel.textContent = 'NEXT';
        refs.next.textContent = 'ALL CLEAR';
      }
    }

    /* ---- PSI cluster ---- */
    const psi = t.psi;
    refs.psiReadout.textContent = psi.toFixed(1);
    refs.needle.setAttribute('transform', `rotate(${psiToDegrees(psi).toFixed(1)} 50 50)`);
    const sag = clamp((32 - psi) / 24, 0, 1);
    refs.tireBody.style.transform = `scale(${1 + sag * 0.1}, ${1 - sag * 0.26})`;
    refs.tireBody.style.transformOrigin = '50% 92%';
    const patchBonus = Math.round(clamp((32 - psi) / 24, 0, 1) * 65);
    refs.patch.textContent = `+${patchBonus}%`;
    refs.sink.textContent = t.sinkCm.toFixed(1);
    if (!this._psiDragging) refs.psiSlider.value = String(psi);

    /* ---- engine cluster ---- */
    refs.speed.textContent = String(Math.round(Math.abs(t.speedKmh)));
    refs.rpm.textContent = String(Math.round(t.rpm));
    refs.gearLabel.textContent = t.gear;
    refs.gateSub.textContent = t.gear;
    const rpmPct = clamp(t.rpmPct, 0, 1);
    const arcLength = 126;
    refs.rpmPath.setAttribute('stroke-dashoffset', String(arcLength * (1 - rpmPct)));
    refs.fuel.textContent = t.fuel.toFixed(1);
    refs.burn.textContent = t.fuelLpm.toFixed(1);
    refs.fuelBar.style.width = `${clamp(t.fuelPct * 100, 0, 100).toFixed(0)}%`;

    /* ---- drivetrain lamps ---- */
    const awdOn = !!t.awd;
    const diffOn = !!t.diffLock;
    refs.swAwd.classList.toggle('on', awdOn);
    refs.swDiff.classList.toggle('on', diffOn);
    refs.swWinch.classList.toggle('on', !!this.winchSystem.activeHook);
    refs.swHitch.classList.toggle('on', !!this.trailer.hitched);
    const canRefuel = this.networkManager.remotePlayers && this.networkManager.remotePlayers.size > 0;
    refs.swRefuel.classList.toggle('on', canRefuel);

    refs.lampFront.setAttribute('fill', awdOn ? '#5e8c6a' : '#5a5f66');
    refs.lampRear.setAttribute('fill', '#5e8c6a');
    refs.lampDiff.setAttribute('fill', diffOn ? '#e5a93c' : '#5a5f66');
    refs.lampWinch.setAttribute('fill', this.winchSystem.activeHook ? '#d9534f' : '#5a5f66');

    const tension = this.winchSystem.cableTension || 0;
    refs.winchBar.style.width = `${clamp((tension / 16000) * 100, 0, 100).toFixed(0)}%`;
    if (diffOn && awdOn && Math.abs(t.speedKmh) > 25 && t.surface === 'Hardpack') {
      refs.swDiff.classList.add('on');
    }

    /* ---- gear gate ---- */
    this._syncGate(t);

    /* ---- touch readouts ---- */
    this._syncTouch(t);
  }

  _syncGate(t) {
    const gearId = t.gearId;
    const key = gearId === 'AUTO' ? 'AUTO' : gearId;
    for (const gate of [this.gate, this.gateMobile]) {
      const pos = gate.pos[key] || gate.pos.AUTO;
      if (gate.knob) {
        gate.knob.setAttribute('transform', `translate(${pos[0] - 30} ${pos[1] - 28})`);
      }
      for (const slot of gate.slots) {
        if (slot.dataset.xhSlot === 'AUTO' && slot.style.display === 'none') continue;
        slot.classList.toggle('on', slot.dataset.xhSlot === (gearId === 'AUTO' ? 'AUTO' : gearId));
      }
    }
  }

  _syncTouch(t) {
    const refs = this.refs;
    const throttle = this.held.throttleAxis || (this.held.throttle ? 1 : 0);
    const brake = this.held.brakeAxis || (this.held.brake ? 1 : 0);
    refs.fillThrottle.style.height = `${Math.round(throttle * 100)}%`;
    refs.fillBrake.style.height = `${Math.round(brake * 100)}%`;
    refs.pedalThrottle.classList.toggle('pressed', throttle > 0.08);
    refs.pedalBrake.classList.toggle('pressed', brake > 0.08);
    if (this.optimizer.settings.steeringStyle !== 'tilt') {
      const deg = Math.round(clamp(this.held.steerAxis || 0, -1, 1) * 140);
      refs.steerDeg.textContent = `${deg}°`;
    }
    refs.steerDeg.setAttribute('aria-live', 'off');
    if (refs.psiChip) refs.psiChip.textContent = `${t.psi.toFixed(1)} PSI`;
  }

  _renderSquad() {
    const list = this.networkManager.getPlayerList ? this.networkManager.getPlayerList() : [];
    const container = this.refs.squad;
    if (!container) return;

    const rows = [];
    const localPos = this.vehicle.body.position;
    for (const player of list) {
      let distance = null;
      if (!player.local && this.networkManager.remotePlayers) {
        const remote = this.networkManager.remotePlayers.get(player.id);
        if (remote && remote.pos) {
          distance = Math.hypot(remote.pos.x - localPos.x, remote.pos.z - localPos.z);
        }
      }
      rows.push({
        name: player.local ? 'You' : player.name || 'Driver',
        dist: distance === null ? '—' : `${Math.round(distance)} m`,
        local: player.local,
        paint: player.paint,
      });
    }

    const signature = rows.map((row) => `${row.name}|${row.dist}`).join(',');
    if (signature === this._squadSignature) return;
    this._squadSignature = signature;

    container.innerHTML = rows
      .map(
        (row) => `
        <div class="xh-squad-row">
          <span class="xh-avatar"${row.paint ? ` style="background:#${Number(row.paint).toString(16).padStart(6, '0')}33"` : ''}></span>
          <span class="xh-squad-name">${row.name}${row.local ? ' ·' : ''}</span>
          <span class="xh-squad-dist">${row.dist}</span>
        </div>`,
      )
      .join('');
  }

  dispose() {
    for (const [, timer] of this._holdTimers) window.clearInterval(timer);
    this._holdTimers.clear();
    window.removeEventListener('deviceorientation', this._onOrientation);
  }
}
