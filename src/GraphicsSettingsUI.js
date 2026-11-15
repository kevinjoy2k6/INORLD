/* ============================================================================
 * GraphicsSettingsUI — the INORLD settings drawer.
 *
 *   Three tabs (Graphics & Performance / Controls & Mobile UI / Audio &
 *   Atmosphere), a live hardware telemetry banner, one-click presets, and a
 *   granular control for every knob the PerformanceOptimizer can hot-swap.
 *   Every change is applied instantly and persisted to INORLD_SETTINGS.
 *
 * It is opened from the top-right gear, the ESC key (wired in main.js), the
 * quick preset pill and the lobby button it injects itself.
 * ========================================================================== */

import { PRESETS, PRESET_ORDER, SHADOW_MODES, MUD_MODES, deviceRatio } from './PerformanceOptimizer.js';

const TABS = [
  { id: 'graphics', label: 'Graphics & Performance', short: 'Graphics' },
  { id: 'controls', label: 'Controls & Mobile UI', short: 'Controls' },
  { id: 'audio', label: 'Audio & Atmosphere', short: 'Audio' },
];

const TIME_OPTIONS = [
  { id: 'auto', label: 'Dynamic Cycle' },
  { id: 'dawn', label: 'Dawn Mist' },
  { id: 'golden', label: 'Golden Hour' },
  { id: 'overcast', label: 'Overcast Mudstorm' },
  { id: 'snow', label: 'Alpine Snowfall' },
  { id: 'night', label: 'Night Trail Run' },
];

function el(tag, className, html) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (html !== undefined) node.innerHTML = html;
  return node;
}

export class GraphicsSettingsUI {
  constructor({ optimizer, atmosphere = null, audio = null, onOpen = null, onClose = null }) {
    this.optimizer = optimizer;
    this.atmosphere = atmosphere;
    this.audio = audio;
    this.onOpen = onOpen;
    this.onClose = onClose;

    this.isOpen = false;
    this._telemetryTimer = 0;
    this._lastHardware = optimizer.hardware;

    this._build();
    this._bindDelegates();
    this.sync();
  }

  /* ================================================================== *
   *  DOM
   * ================================================================== */

  _build() {
    const root = el('div');
    root.id = 'xh-settings';
    root.hidden = true;
    root.innerHTML = `
      <div class="xh-modal" role="dialog" aria-modal="true" aria-label="INORLD settings">
        <div class="xh-modal-head">
          <div class="xh-modal-title">INORLD — Settings</div>
          <button class="xh-close" type="button" data-xh-close aria-label="Close settings">✕</button>
        </div>
        <div class="xh-tabs">
          ${TABS.map((tab, index) => `<button class="xh-tab${index === 0 ? ' on' : ''}" type="button" data-xh-tab="${tab.id}"><span class="xh-tab-long">${tab.label}</span><span class="xh-tab-short">${tab.short}</span></button>`).join('')}
        </div>
        <div class="xh-pages">
          ${this._graphicsPage()}
          ${this._controlsPage()}
          ${this._audioPage()}
        </div>
        <div class="xh-modal-foot">
          <div class="xh-foot-note" data-xh-footnote>Changes apply instantly and are saved to this device.</div>
          <button class="xh-btn" type="button" data-xh-reset>Reset to Hardware Recommended</button>
          <button class="xh-btn on" type="button" data-xh-close>Done</button>
        </div>
      </div>
    `;
    document.body.appendChild(root);
    this.root = root;
    this.pages = root.querySelectorAll('.xh-page');
    this.tabs = root.querySelectorAll('.xh-tab');
    this._bindModal();
  }

  _graphicsPage() {
    return `
      <div class="xh-page on" data-xh-page="graphics">
        <div class="xh-banner">
          <div class="xh-metric"><b data-xh-fps>--</b><span>FPS</span></div>
          <div class="xh-metric"><b data-xh-frame>--</b><span>Frame ms</span></div>
          <div class="xh-metric"><b data-xh-calls>--</b><span>Draw calls</span></div>
          <div class="xh-metric"><b data-xh-tris>--</b><span>Triangles</span></div>
          <div class="xh-health good" data-xh-health>—</div>
          <div class="xh-gpu" data-xh-gpu>Detecting GPU…</div>
        </div>

        <div class="xh-section">
          <div class="xh-section-title">Quality preset</div>
          <div class="xh-seg" data-xh-presetbar>
            <button type="button" data-xh-preset="AUTO">Auto-Detect</button>
            <button type="button" data-xh-preset="COZY">Cozy Drive</button>
            <button type="button" data-xh-preset="ULTRA_LOW">Ultra-Low</button>
            <button type="button" data-xh-preset="LOW">Low</button>
            <button type="button" data-xh-preset="MEDIUM">Medium</button>
            <button type="button" data-xh-preset="HIGH">High</button>
            <button type="button" data-xh-preset="CUSTOM" disabled>Custom</button>
          </div>
          <div class="xh-row-hint" data-xh-preset-hint></div>
        </div>

        <div class="xh-section">
          <div class="xh-section-title">Resolution & frame rate</div>
          <div class="xh-row">
            <div class="xh-row-label"><span>Resolution scale</span><span class="xh-row-hint" data-xh-res-hint>—</span></div>
            <input class="xh-slider" type="range" min="50" max="150" step="5" value="100" data-xh-res />
            <span class="xh-slider-val" data-xh-res-val>100%</span>
          </div>
          <div class="xh-row">
            <div class="xh-row-label"><span>Dynamic FPS auto-scaler</span><span class="xh-row-hint">Lowers resolution when the average drops below 42 FPS</span></div>
            <button class="xh-btn on" type="button" data-xh-toggle="autoScaleResolution">ON</button>
          </div>
          <div class="xh-row">
            <span>Frame rate limit</span>
            <div class="xh-seg" data-xh-fpscap>
              <button type="button" data-xh-cap="30">30 FPS (Battery)</button>
              <button type="button" data-xh-cap="60">60 FPS (Smooth)</button>
              <button type="button" data-xh-cap="0">Uncapped</button>
            </div>
          </div>
        </div>

        <div class="xh-section">
          <div class="xh-section-title">World detail</div>
          <div class="xh-row">
            <span>Shadow quality</span>
            <div class="xh-seg" data-xh-shadows>
              ${Object.keys(SHADOW_MODES).map((key) => `<button type="button" data-xh-shadow="${key}">${SHADOW_MODES[key].label}</button>`).join('')}
            </div>
          </div>
          <div class="xh-row">
            <div class="xh-row-label"><span>Post-processing</span><span class="xh-row-hint">Bloom &amp; golden-hour grading</span></div>
            <button class="xh-btn on" type="button" data-xh-toggle="postProcessing">ON</button>
          </div>

          <details class="xh-adv">
            <summary>
              <span class="xh-adv-title">Advanced rendering</span>
              <span class="xh-adv-note">Mud deformation · foliage · particles · draw distance</span>
            </summary>
            <div class="xh-row">
              <span>Mud &amp; snow deformation</span>
              <div class="xh-seg" data-xh-mud>
                ${Object.keys(MUD_MODES).map((key) => `<button type="button" data-xh-mudmode="${key}">${MUD_MODES[key].label}</button>`).join('')}
              </div>
            </div>
            <div class="xh-row">
              <div class="xh-row-label"><span>Wilderness foliage density</span><span class="xh-row-hint" data-xh-foliage-hint>—</span></div>
              <input class="xh-slider" type="range" min="0" max="100" step="1" value="100" data-xh-foliage />
              <span class="xh-slider-val" data-xh-foliage-val>100%</span>
            </div>
            <div class="xh-row">
              <div class="xh-row-label"><span>Particle effects budget</span><span class="xh-row-hint" data-xh-particles-hint>—</span></div>
              <input class="xh-slider" type="range" min="0" max="100" step="1" value="100" data-xh-particles />
              <span class="xh-slider-val" data-xh-particles-val>100%</span>
            </div>
            <div class="xh-row">
              <div class="xh-row-label"><span>Draw distance</span><span class="xh-row-hint">Fog closes in to hide the cull</span></div>
              <input class="xh-slider" type="range" min="100" max="350" step="10" value="240" data-xh-draw />
              <span class="xh-slider-val" data-xh-draw-val>240 m</span>
            </div>
          </details>
        </div>
      </div>
    `;
  }

  _controlsPage() {
    return `
      <div class="xh-page" data-xh-page="controls">
        <div class="xh-section">
          <div class="xh-section-title">Input</div>
          <div class="xh-row">
            <span>Input mode</span>
            <div class="xh-seg" data-xh-inputmode>
              <button type="button" data-xh-input="auto">Auto-Detect</button>
              <button type="button" data-xh-input="keyboard">Keyboard + Mouse</button>
              <button type="button" data-xh-input="touch">Touch (force)</button>
            </div>
          </div>
          <div class="xh-row">
            <span>Steering control</span>
            <div class="xh-seg" data-xh-steering>
              <button type="button" data-xh-steer="wheel">3-Spoke Wheel</button>
              <button type="button" data-xh-steer="arrows">Left / Right</button>
              <button type="button" data-xh-steer="tilt">Tilt Device</button>
            </div>
          </div>
          <div class="xh-row">
            <span>Transmission</span>
            <div class="xh-seg" data-xh-transmission>
              <button type="button" data-xh-trans="manual">Manual H-Gate</button>
              <button type="button" data-xh-trans="auto">Auto + Low</button>
            </div>
          </div>
        </div>

        <div class="xh-section">
          <div class="xh-section-title">Feel</div>
          <div class="xh-row">
            <span>Steering sensitivity</span>
            <input class="xh-slider" type="range" min="0.5" max="2" step="0.05" value="1" data-xh-sens />
            <span class="xh-slider-val" data-xh-sens-val>1.00x</span>
          </div>
          <div class="xh-row-hint">Touch controls appear automatically on coarse-pointer devices, or when Input mode is set to Touch.</div>

          <details class="xh-adv">
            <summary>
              <span class="xh-adv-title">Advanced controls</span>
              <span class="xh-adv-note">Centering · camera inversion · touch size · HUD opacity</span>
            </summary>
            <div class="xh-row">
              <span>Self-centering speed</span>
              <input class="xh-slider" type="range" min="0.5" max="2" step="0.05" value="1" data-xh-centering />
              <span class="xh-slider-val" data-xh-centering-val>1.00x</span>
            </div>
            <div class="xh-row">
              <span>Invert orbit camera X</span>
              <button class="xh-btn" type="button" data-xh-toggle="invertOrbitX">OFF</button>
            </div>
            <div class="xh-row">
              <span>Invert orbit camera Y</span>
              <button class="xh-btn" type="button" data-xh-toggle="invertOrbitY">OFF</button>
            </div>
            <div class="xh-row">
              <span>Touch button size</span>
              <input class="xh-slider" type="range" min="80" max="140" step="5" value="100" data-xh-touchscale />
              <span class="xh-slider-val" data-xh-touchscale-val>100%</span>
            </div>
            <div class="xh-row">
              <span>HUD opacity</span>
              <input class="xh-slider" type="range" min="40" max="100" step="1" value="92" data-xh-opacity />
              <span class="xh-slider-val" data-xh-opacity-val>92%</span>
            </div>
          </details>
        </div>
      </div>
    `;
  }

  _audioPage() {
    return `
      <div class="xh-page" data-xh-page="audio">
        <div class="xh-section">
          <div class="xh-section-title">Mixer</div>
          <div class="xh-row">
            <span>Master volume</span>
            <input class="xh-slider" type="range" min="0" max="100" step="1" value="70" data-xh-master />
            <span class="xh-slider-val" data-xh-master-val>70%</span>
          </div>
          <div class="xh-row">
            <span>Diesel engine</span>
            <input class="xh-slider" type="range" min="0" max="100" step="1" value="100" data-xh-engine />
            <span class="xh-slider-val" data-xh-engine-val>100%</span>
          </div>
          <div class="xh-row">
            <span>Nature ambience</span>
            <input class="xh-slider" type="range" min="0" max="100" step="1" value="100" data-xh-ambience />
            <span class="xh-slider-val" data-xh-ambience-val>100%</span>
          </div>
        </div>

        <div class="xh-section">
          <details class="xh-adv">
            <summary>
              <span class="xh-adv-title">Advanced atmosphere</span>
              <span class="xh-adv-note">Time of day &amp; weather</span>
            </summary>
            <div class="xh-seg" data-xh-time>
              ${TIME_OPTIONS.map((opt) => `<button type="button" data-xh-timeid="${opt.id}">${opt.label}</button>`).join('')}
            </div>
            <div class="xh-row-hint" data-xh-time-hint>Dynamic cycle follows the host's clock in co-op.</div>
          </details>
        </div>
      </div>
    `;
  }

  /* ================================================================== *
   *  events
   * ================================================================== */

  _bindModal() {
    const q = (sel) => this.root.querySelector(sel);
    const all = (sel) => Array.from(this.root.querySelectorAll(sel));

    for (const tab of this.tabs) {
      tab.addEventListener('click', () => this.openTab(tab.dataset.xhTab));
    }

    for (const button of all('[data-xh-close]')) {
      button.addEventListener('click', () => this.close());
    }

    this.root.addEventListener('pointerdown', (event) => {
      if (event.target === this.root) this.close();
    });

    /* ---- presets ---- */
    for (const button of all('[data-xh-preset]')) {
      button.addEventListener('click', () => {
        const id = button.dataset.xhPreset;
        if (id === 'AUTO') this.optimizer.resetToRecommended();
        else if (id === 'CUSTOM') return;
        else this.optimizer.setPreset(id);
        this.sync();
      });
    }

    q('[data-xh-reset]').addEventListener('click', () => {
      this.optimizer.resetToRecommended();
      this.sync();
    });

    /* ---- sliders ---- */
    const resSlider = q('[data-xh-res]');
    resSlider.addEventListener('input', () => {
      const pct = Number(resSlider.value) / 100;
      this.optimizer.applySettings({ pixelRatio: +(deviceRatio() * pct).toFixed(2) });
      this.sync();
    });

    const foliage = q('[data-xh-foliage]');
    foliage.addEventListener('input', () => {
      this.optimizer.applySettings({ foliageDensity: Number(foliage.value) / 100 });
      this._renderSliderLabels();
    });

    const particles = q('[data-xh-particles]');
    particles.addEventListener('input', () => {
      this.optimizer.applySettings({ particleBudget: Math.round((Number(particles.value) / 100) * 400) });
      this._renderSliderLabels();
    });

    const draw = q('[data-xh-draw]');
    draw.addEventListener('input', () => {
      this.optimizer.applySettings({ drawDistance: Number(draw.value) });
      this._renderSliderLabels();
    });

    q('[data-xh-sens]').addEventListener('input', (event) => {
      this.optimizer.applySettings({ steerSensitivity: Number(event.target.value) });
      this._renderSliderLabels();
    });
    q('[data-xh-centering]').addEventListener('input', (event) => {
      this.optimizer.applySettings({ steerCentering: Number(event.target.value) });
      this._renderSliderLabels();
    });
    q('[data-xh-touchscale]').addEventListener('input', (event) => {
      this.optimizer.applySettings({ touchScale: Number(event.target.value) / 100 });
      this._renderSliderLabels();
    });
    q('[data-xh-opacity]').addEventListener('input', (event) => {
      this.optimizer.applySettings({ hudOpacity: Number(event.target.value) / 100 });
      this._renderSliderLabels();
    });
    q('[data-xh-master]').addEventListener('input', (event) => {
      this.optimizer.applySettings({ masterVolume: Number(event.target.value) / 100 });
      this._renderSliderLabels();
    });
    q('[data-xh-engine]').addEventListener('input', (event) => {
      this.optimizer.applySettings({ engineVolume: Number(event.target.value) / 100 });
      this._renderSliderLabels();
    });
    q('[data-xh-ambience]').addEventListener('input', (event) => {
      this.optimizer.applySettings({ ambienceVolume: Number(event.target.value) / 100 });
      this._renderSliderLabels();
    });

    /* ---- segmented selectors ---- */
    const pick = (container, attribute, handler) => {
      for (const button of Array.from(container.querySelectorAll('button'))) {
        button.addEventListener('click', () => {
          handler(button.getAttribute(attribute));
          this.sync();
        });
      }
    };

    pick(q('[data-xh-fpscap]'), 'data-xh-cap', (value) => this.optimizer.applySettings({ fpsCap: Number(value) }));
    pick(q('[data-xh-shadows]'), 'data-xh-shadow', (value) => this.optimizer.applySettings({ shadows: value }));
    pick(q('[data-xh-mud]'), 'data-xh-mudmode', (value) => this.optimizer.applySettings({ mudDeformMode: value }));
    pick(q('[data-xh-inputmode]'), 'data-xh-input', (value) => this.optimizer.applySettings({ inputMode: value }, { markCustom: false }));
    pick(q('[data-xh-steering]'), 'data-xh-steer', (value) => this.optimizer.applySettings({ steeringStyle: value }, { markCustom: false }));
    pick(q('[data-xh-transmission]'), 'data-xh-trans', (value) => this.optimizer.applySettings({ transmission: value }, { markCustom: false }));
    pick(q('[data-xh-time]'), 'data-xh-timeid', (value) => this.optimizer.applySettings({ timeOverride: value }, { markCustom: false }));

    /* ---- toggles ---- */
    for (const button of all('[data-xh-toggle]')) {
      button.addEventListener('click', () => {
        const key = button.dataset.xhToggle;
        this.optimizer.applySettings({ [key]: !this.optimizer.settings[key] });
        this.sync();
      });
    }
  }

  /** Global triggers: the HUD gear/preset pill and the injected lobby button. */
  _bindDelegates() {
    document.addEventListener('click', (event) => {
      const open = event.target.closest && event.target.closest('[data-open-settings]');
      if (open) {
        event.preventDefault();
        this.open();
        return;
      }
      const cycle = event.target.closest && event.target.closest('[data-cycle-preset]');
      if (cycle) {
        event.preventDefault();
        this.optimizer.cyclePreset(1);
        this.sync();
      }
    });

    // Lobby entry point — the lobby markup belongs to UIManager, so append.
    const footer = document.querySelector('#lobby .lobby-footer');
    if (footer && !document.querySelector('.xh-lobby-row')) {
      const row = el('div', 'xh-lobby-row');
      const button = el('button', 'xh-btn', '⚙ Settings &amp; Performance');
      button.type = 'button';
      button.setAttribute('data-open-settings', '');
      row.appendChild(button);
      footer.parentElement.insertBefore(row, footer);
    }
  }

  openTab(id) {
    for (const tab of this.tabs) tab.classList.toggle('on', tab.dataset.xhTab === id);
    for (const page of this.pages) page.classList.toggle('on', page.dataset.xhPage === id);
  }

  open(tab = null) {
    if (tab) this.openTab(tab);
    this.root.hidden = false;
    this.isOpen = true;
    document.body.classList.add('xh-settings-open');
    this.sync();
    this.onOpen?.();
  }

  close() {
    if (this.root.hidden) return;
    this.root.hidden = true;
    this.isOpen = false;
    document.body.classList.remove('xh-settings-open');
    this.onClose?.();
  }

  toggle(tab = null) {
    if (this.isOpen) this.close();
    else this.open(tab);
    return this.isOpen;
  }

  /* ================================================================== *
   *  sync + telemetry
   * ================================================================== */

  sync() {
    const s = this.optimizer.settings;
    const q = (sel) => this.root.querySelector(sel);
    const all = (sel) => Array.from(this.root.querySelectorAll(sel));

    /* preset bar */
    for (const button of all('[data-xh-preset]')) {
      const id = button.dataset.xhPreset;
      const active = id === 'AUTO' ? false : id === s.preset;
      button.classList.toggle('on', active);
    }
    const preset = PRESETS[s.preset];
    q('[data-xh-preset-hint]').textContent = preset
      ? `${preset.label} — ${preset.hint}`
      : 'Custom — every slider is yours; the preset bar will jump to Custom.';

    /* resolution */
    const pct = Math.round((s.pixelRatio / deviceRatio()) * 100);
    q('[data-xh-res]').value = String(Math.min(150, Math.max(50, pct)));
    q('[data-xh-res-val]').textContent = `${pct}%`;
    const w = Math.round(window.innerWidth * s.pixelRatio);
    const h = Math.round(window.innerHeight * s.pixelRatio);
    q('[data-xh-res-hint]').textContent = `Rendering ${w}×${h}`;

    /* toggles */
    for (const button of all('[data-xh-toggle]')) {
      const key = button.dataset.xhToggle;
      const on = !!s[key];
      button.classList.toggle('on', on);
      button.textContent = on ? 'ON' : 'OFF';
    }

    /* segmented */
    const setSeg = (selector, attribute, value) => {
      for (const button of all(selector)) {
        button.classList.toggle('on', button.getAttribute(attribute) === String(value));
      }
    };
    setSeg('[data-xh-cap]', 'data-xh-cap', s.fpsCap);
    setSeg('[data-xh-shadow]', 'data-xh-shadow', s.shadows);
    setSeg('[data-xh-mudmode]', 'data-xh-mudmode', s.mudDeformMode);
    setSeg('[data-xh-input]', 'data-xh-input', s.inputMode);
    setSeg('[data-xh-steer]', 'data-xh-steer', s.steeringStyle);
    setSeg('[data-xh-trans]', 'data-xh-trans', s.transmission);
    setSeg('[data-xh-timeid]', 'data-xh-timeid', s.timeOverride);

    /* sliders */
    q('[data-xh-foliage]').value = String(Math.round(s.foliageDensity * 100));
    q('[data-xh-particles]').value = String(Math.round((s.particleBudget / 400) * 100));
    q('[data-xh-draw]').value = String(Math.round(s.drawDistance));
    q('[data-xh-sens]').value = String(s.steerSensitivity);
    q('[data-xh-centering]').value = String(s.steerCentering);
    q('[data-xh-touchscale]').value = String(Math.round(s.touchScale * 100));
    q('[data-xh-opacity]').value = String(Math.round(s.hudOpacity * 100));
    q('[data-xh-master]').value = String(Math.round(s.masterVolume * 100));
    q('[data-xh-engine]').value = String(Math.round(s.engineVolume * 100));
    q('[data-xh-ambience]').value = String(Math.round(s.ambienceVolume * 100));

    this._renderSliderLabels();
    this._renderTelemetry();
  }

  _renderSliderLabels() {
    const s = this.optimizer.settings;
    const q = (sel) => this.root.querySelector(sel);
    q('[data-xh-foliage-val]').textContent = `${Math.round(s.foliageDensity * 100)}%`;
    q('[data-xh-particles-val]').textContent = `${Math.round((s.particleBudget / 400) * 100)}%`;
    q('[data-xh-foliage-hint]').textContent =
      s.foliageDensity === 0 ? 'Instances hidden' : 'Grass, ferns, reeds, bushes & trees';
    q('[data-xh-particles-hint]').textContent = `${Math.round(s.particleBudget)} particles max`;
    q('[data-xh-draw-val]').textContent = `${Math.round(s.drawDistance)} m`;
    q('[data-xh-sens-val]').textContent = `${s.steerSensitivity.toFixed(2)}x`;
    q('[data-xh-centering-val]').textContent = `${s.steerCentering.toFixed(2)}x`;
    q('[data-xh-touchscale-val]').textContent = `${Math.round(s.touchScale * 100)}%`;
    q('[data-xh-opacity-val]').textContent = `${Math.round(s.hudOpacity * 100)}%`;
    q('[data-xh-master-val]').textContent = `${Math.round(s.masterVolume * 100)}%`;
    q('[data-xh-engine-val]').textContent = `${Math.round(s.engineVolume * 100)}%`;
    q('[data-xh-ambience-val]').textContent = `${Math.round(s.ambienceVolume * 100)}%`;
  }

  _renderTelemetry() {
    const t = this.optimizer.getTelemetry();
    const q = (sel) => this.root.querySelector(sel);
    q('[data-xh-fps]').textContent = String(t.fps);
    q('[data-xh-frame]').textContent = t.frameMs.toFixed(1);
    q('[data-xh-calls]').textContent = String(t.calls);
    q('[data-xh-tris]').textContent = t.triangles > 999 ? `${(t.triangles / 1000).toFixed(1)}k` : String(t.triangles);
    const health = q('[data-xh-health]');
    health.className = `xh-health ${t.health}`;
    health.textContent = t.health === 'good' ? 'HEALTHY' : t.health === 'warn' ? 'DEGRADED' : 'STRUGGLING';
    q('[data-xh-gpu]').textContent = `${t.gpu} · ${this.optimizer.hardware.cores} cores · preset ${t.preset}`;
  }

  /** Called from the frame loop; only repaints the banner a few times a second. */
  update(dt) {
    if (!this.isOpen) return;
    this._telemetryTimer += dt;
    if (this._telemetryTimer < 0.25) return;
    this._telemetryTimer = 0;
    this._renderTelemetry();
  }
}
