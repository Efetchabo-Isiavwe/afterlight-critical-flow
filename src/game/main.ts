import { AUTO, Events, Game as PhaserGame, Scale, Scene } from 'phaser';

// ---------------------------------------------------------------------------
// AFTERLIGHT — Nalé City Emergency Operations ambient visualizer scene.
// React (src/App.tsx) owns the crisis state machine; this Phaser canvas
// renders the night city, the eastern-grid blackout and the live telemetry.
// ---------------------------------------------------------------------------

export const GAME_WIDTH = 1280;
export const GAME_HEIGHT = 720;

export const COLORS = {
    SKY_TOP: 0x04070e,
    SKY_BOTTOM: 0x0f1a2e,
    FAR: 0x0a1120,
    MID: 0x101a2e,
    NEAR: 0x16243d,
    AMBER: 0xf59e0b,
    CYAN: 0x06b6d4,
    CRIMSON: 0xef4444,
    EMERALD: 0x10b981,
} as const;

// Event names — single source of truth for the React <-> Phaser bridge.
export const EVT_PHASE_CHANGED = 'phase-changed';
export const EVT_RESOURCE_UPDATED = 'resource-updated';
export const EVT_GRID_STATUS_ALERT = 'grid-status-alert';
export const EVT_TRIGGER_SFX = 'trigger-sfx';
export const EVT_CURRENT_SCENE_READY = 'current-scene-ready';

export interface ResourceSnapshot {
    power: number;
    water: number;
    comms: number;
    lives: number;
    trust: number;
}

export const EventBus = new Events.EventEmitter();

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

// A single building record for the near skyline (window grid state).
interface BuildingRec {
    x: number;
    y: number;
    w: number;
    h: number;
    cols: number;
    rows: number;
    lit: boolean[];       // window lit flags (current state)
    base: boolean[];      // original lit pattern
    east: boolean;        // sits in the eastern blackout sector
    roof: Phaser.GameObjects.Graphics | null;
}

export class Game extends Scene {
    private resources: ResourceSnapshot = { power: 80, water: 80, comms: 80, lives: 90, trust: 70 };
    private blackout = false;
    private currentPhase = 'TITLE';
    private buildings: BuildingRec[] = [];
    private windowTex!: Phaser.GameObjects.Graphics;
    private gridLines!: Phaser.GameObjects.Graphics;
    private nodes: Phaser.GameObjects.Container[] = [];
    private nodeStates: Record<string, { x: number; y: number; label: string; status: string; dot: Phaser.GameObjects.Arc; txt: Phaser.GameObjects.Text }> = {};
    private hospitalPulse!: Phaser.GameObjects.Arc;
    private radar!: Phaser.GameObjects.Graphics;
    private radarAngle = 0;
    private scanlineY = 0;
    private scanBar!: Phaser.GameObjects.Rectangle;
    private stars!: Phaser.GameObjects.Graphics;
    private beaconT = 0;
    private flickerTimer?: Phaser.Time.TimerEvent;
    private sfxEmitted = 0;

    constructor() {
        super('Game');
    }

    create() {
        this.cameras.main.setBackgroundColor('#04070e');

        this.drawSky();
        this.drawStars();
        this.drawFarSkyline();
        this.drawMidSkyline();
        this.drawNearSkyline();
        this.drawWaterAndBridge();
        this.buildGridOverlay();
        this.buildRadar();
        this.buildScanBar();
        this.buildVignette();

        // React -> Phaser commands.
        EventBus.on(EVT_PHASE_CHANGED, this.onPhaseChanged, this);
        EventBus.on(EVT_RESOURCE_UPDATED, this.onResourceUpdated, this);

        // Initial telemetry alert after a short boot beat.
        this.time.delayedCall(1200, () => {
            EventBus.emit(EVT_GRID_STATUS_ALERT, { status: 'NATIONAL GRID NOMINAL', sector: 'SECTOR 4 — NALÉ CITY' });
        });

        EventBus.emit(EVT_CURRENT_SCENE_READY, this);

        this.events.once('shutdown', () => {
            this.time.removeAllEvents();
            this.tweens.killAll();
            this.input.keyboard?.removeAllListeners();
            this.sound.stopAll();
            EventBus.off(EVT_PHASE_CHANGED, this.onPhaseChanged, this);
            EventBus.off(EVT_RESOURCE_UPDATED, this.onResourceUpdated, this);
        });
    }

    // ------------------------------------------------------------------
    // EventBus handlers
    // ------------------------------------------------------------------

    private onPhaseChanged(payload: { phase?: string }) {
        const phase = payload?.phase ?? '';
        this.currentPhase = phase;
        const crisisPhase = phase === 'CRISIS_BRIEFING' || phase === 'OVIE_REPORT' || phase === 'DECISION_SCREEN';
        if (crisisPhase && !this.blackout) {
            this.triggerBlackout();
        }
        if (phase === 'DEBRIEF' || phase === 'TITLE') {
            this.setNodeStatus('E01', 'offline');
            this.setNodeStatus('E02', 'offline');
            this.setNodeStatus('MARINA', 'offline');
            this.setNodeStatus('HOSPITAL', 'auxiliary');
            this.setNodeStatus('CORE', 'online');
        }
    }

    private onResourceUpdated(snap: Partial<ResourceSnapshot>) {
        if (!snap) return;
        this.resources = {
            power: clamp(snap.power ?? this.resources.power, 0, 100),
            water: clamp(snap.water ?? this.resources.water, 0, 100),
            comms: clamp(snap.comms ?? this.resources.comms, 0, 100),
            lives: clamp(snap.lives ?? this.resources.lives, 0, 100),
            trust: clamp(snap.trust ?? this.resources.trust, 0, 100),
        };
        // Window density follows power level.
        this.applyPowerToWindows();
        if (this.resources.power >= 90) {
            this.setNodeStatus('E01', 'online');
        }
        if (this.resources.comms >= 85) {
            this.setNodeStatus('CORE', 'online');
        }
    }

    // ------------------------------------------------------------------
    // Blackout sequence
    // ------------------------------------------------------------------

    private triggerBlackout() {
        this.blackout = true;
        this.cameras.main.shake(220, 0.004);
        this.setNodeStatus('E01', 'offline');
        this.setNodeStatus('E02', 'offline');
        this.setNodeStatus('MARINA', 'offline');
        this.setNodeStatus('HOSPITAL', 'auxiliary');
        this.setNodeStatus('CORE', 'unstable');

        // Cascading flicker of eastern windows.
        let step = 0;
        if (this.flickerTimer) this.flickerTimer.remove();
        this.flickerTimer = this.time.addEvent({
            delay: 140,
            repeat: 7,
            callback: () => {
                step++;
                this.buildings.forEach((b) => {
                    if (!b.east) return;
                    b.lit = b.lit.map((on, i) => {
                        if (!on) return false;
                        // probability of dying increases with step
                        return Math.random() > step / 9 ? true : (i % 3 === 0 ? false : on);
                    });
                });
                this.redrawWindows();
                if (step >= 7) {
                    // Eastern sector fully dark, west keeps a reduced load.
                    this.buildings.forEach((b) => {
                        if (b.east) b.lit = b.base.map(() => false);
                        else b.lit = b.base.map((on, i) => on && i % 4 !== 0);
                    });
                    this.redrawWindows();
                    this.spawnSparks(GAME_WIDTH * 0.72, GAME_HEIGHT * 0.46, 14);
                    this.spawnSparks(GAME_WIDTH * 0.86, GAME_HEIGHT * 0.52, 10);
                    EventBus.emit(EVT_GRID_STATUS_ALERT, { status: 'EASTERN GRID FAILURE — 3 SUBSTATIONS OFFLINE', sector: 'EAST / MARINA' });
                    this.fireSfx('alarm');
                }
            },
        });

        // Hospital auxiliary pulse becomes visible.
        this.hospitalPulse.setVisible(true);
        this.tweens.add({
            targets: this.hospitalPulse,
            alpha: { from: 0.9, to: 0.15 },
            scale: { from: 0.7, to: 1.8 },
            duration: 1100,
            repeat: -1,
            yoyo: true,
        });
    }

    private applyPowerToWindows() {
        const density = this.resources.power / 100;
        this.buildings.forEach((b) => {
            b.lit = b.base.map((on, i) => on && (i / Math.max(1, b.base.length)) < density * 1.15);
        });
        this.redrawWindows();
    }

    private fireSfx(type: 'alarm' | 'click' | 'radio' | 'decision' | 'power') {
        const now = this.time.now;
        if (now - this.sfxEmitted < 250) return;
        this.sfxEmitted = now;
        EventBus.emit(EVT_TRIGGER_SFX, { type });
    }

    // ------------------------------------------------------------------
    // Drawing: sky, stars, skyline layers
    // ------------------------------------------------------------------

    private drawSky() {
        const g = this.add.graphics();
        g.fillGradientStyle(COLORS.SKY_TOP, COLORS.SKY_TOP, COLORS.SKY_BOTTOM, COLORS.SKY_BOTTOM, 1, 1, 1, 1);
        g.fillRect(0, 0, GAME_WIDTH, GAME_HEIGHT);
        g.setDepth(-50);

        // Moon haze over the bay.
        const moon = this.add.graphics();
        moon.fillStyle(0xfde68a, 0.06);
        moon.fillCircle(GAME_WIDTH * 0.18, 110, 90);
        moon.fillStyle(0xfde68a, 0.10);
        moon.fillCircle(GAME_WIDTH * 0.18, 110, 52);
        moon.fillStyle(0xfff7d6, 0.85);
        moon.fillCircle(GAME_WIDTH * 0.18, 110, 26);
        moon.setDepth(-49);
    }

    private drawStars() {
        this.stars = this.add.graphics();
        this.stars.setDepth(-48);
        for (let i = 0; i < 130; i++) {
            const x = Math.random() * GAME_WIDTH;
            const y = Math.random() * 240;
            const a = 0.15 + Math.random() * 0.55;
            this.stars.fillStyle(0xffffff, a);
            this.stars.fillRect(x, y, 1.6, 1.6);
        }
        this.tweens.add({
            targets: this.stars,
            alpha: { from: 1, to: 0.55 },
            duration: 2600,
            yoyo: true,
            repeat: -1,
        });
    }

    private drawFarSkyline() {
        const g = this.add.graphics();
        g.setDepth(-40);
        g.fillStyle(COLORS.FAR, 1);
        // Organic undulating silhouette via stacked trapezoids.
        let x = -20;
        while (x < GAME_WIDTH + 40) {
            const w = 40 + Math.random() * 70;
            const h = 70 + Math.random() * 110;
            g.fillRect(x, GAME_HEIGHT * 0.52 - h, w, h + 60);
            x += w + 6;
        }
        // Faint amber haze on rooftops.
        g.fillStyle(0xf59e0b, 0.05);
        g.fillRect(0, GAME_HEIGHT * 0.40, GAME_WIDTH, 40);
    }

    private drawMidSkyline() {
        const g = this.add.graphics();
        g.setDepth(-30);
        g.fillStyle(COLORS.MID, 1);
        let x = -30;
        while (x < GAME_WIDTH + 40) {
            const w = 46 + Math.random() * 60;
            const h = 110 + Math.random() * 130;
            g.fillRect(x, GAME_HEIGHT * 0.58 - h, w, h + 80);
            // antenna
            if (Math.random() > 0.7) {
                g.fillStyle(0x1c2a44, 1);
                g.fillRect(x + w / 2 - 1, GAME_HEIGHT * 0.58 - h - 26, 2, 26);
                g.fillStyle(0xef4444, 0.9);
                g.fillCircle(x + w / 2, GAME_HEIGHT * 0.58 - h - 28, 2.4);
            }
            g.fillStyle(COLORS.MID, 1);
            x += w + 8;
        }
    }

    private drawNearSkyline() {
        // Procedural window texture (1x1 white pixel, tinted at draw time).
        this.windowTex = this.add.graphics();

        let x = -20;
        const groundY = GAME_HEIGHT * 0.66;
        while (x < GAME_WIDTH + 40) {
            const w = 60 + Math.random() * 70;
            const h = 150 + Math.random() * 190;
            const east = x > GAME_WIDTH * 0.55;
            const body = this.add.graphics();
            body.setDepth(-20);
            body.fillStyle(COLORS.NEAR, 1);
            body.fillRect(x, groundY - h, w, h + 80);
            // Cap highlight edge.
            body.fillStyle(0x223354, 1);
            body.fillRect(x, groundY - h, w, 4);

            const cols = Math.max(3, Math.floor(w / 16));
            const rows = Math.max(4, Math.floor(h / 22));
            const total = cols * rows;
            const base: boolean[] = [];
            for (let i = 0; i < total; i++) {
                // warm amber / cool cyan mix for a believable lived-in city
                base.push(Math.random() > 0.45);
            }
            const rec: BuildingRec = { x, y: groundY - h, w, h, cols, rows, lit: [...base], base, east, roof: null };
            this.buildings.push(rec);
            x += w + 10;
        }
        this.redrawWindows();
    }

    private redrawWindows() {
        if (this.windowTex) this.windowTex.destroy();
        const g = this.add.graphics();
        g.setDepth(-19);
        for (const b of this.buildings) {
            const padX = 6;
            const padY = 8;
            const cw = (b.w - padX * 2) / b.cols;
            const ch = (b.h - padY * 2) / b.rows;
            for (let r = 0; r < b.rows; r++) {
                for (let c = 0; c < b.cols; c++) {
                    const idx = r * b.cols + c;
                    if (!b.lit[idx]) continue;
                    const warm = (idx + c) % 5 !== 0;
                    const col = warm ? 0xffc861 : 0x7dd3fc;
                    g.fillStyle(col, 0.9);
                    g.fillRect(b.x + padX + c * cw + 1, b.y + padY + r * ch + 1, Math.max(2, cw - 4), Math.max(2, ch - 5));
                }
            }
            // Rooftop aviation light for tall towers.
            if (b.h > 260) {
                g.fillStyle(0xef4444, 0.9);
                g.fillCircle(b.x + b.w / 2, b.y - 6, 2.6);
            }
        }
        this.windowTex = g;
    }

    private drawWaterAndBridge() {
        const groundY = GAME_HEIGHT * 0.66;
        const water = this.add.graphics();
        water.setDepth(-15);
        water.fillStyle(0x08111f, 1);
        water.fillRect(0, groundY + 60, GAME_WIDTH, GAME_HEIGHT - groundY - 60);
        // Reflection streaks.
        for (let i = 0; i < 60; i++) {
            const x = Math.random() * GAME_WIDTH;
            const y = groundY + 70 + Math.random() * (GAME_HEIGHT - groundY - 80);
            water.fillStyle(0xf59e0b, 0.05 + Math.random() * 0.08);
            water.fillRect(x, y, 14 + Math.random() * 30, 1.4);
        }

        // Coastal bridge silhouette with cable stays.
        const bridge = this.add.graphics();
        bridge.setDepth(-14);
        const deckY = groundY + 78;
        bridge.fillStyle(0x1a2942, 1);
        bridge.fillRect(0, deckY, GAME_WIDTH, 6);
        const pylonX = [GAME_WIDTH * 0.28, GAME_WIDTH * 0.74];
        pylonX.forEach((px) => {
            bridge.fillStyle(0x24365a, 1);
            bridge.fillRect(px - 4, deckY - 90, 8, 96);
            bridge.lineStyle(1, 0x3b567f, 0.7);
            for (let i = 1; i <= 6; i++) {
                bridge.lineBetween(px, deckY - 80, px - i * 26, deckY);
                bridge.lineBetween(px, deckY - 80, px + i * 26, deckY);
            }
            bridge.fillStyle(0xef4444, 0.9);
            bridge.fillCircle(px, deckY - 92, 2.6);
        });

        // Moving car lights along the deck (traffic feel).
        for (let i = 0; i < 7; i++) {
            const dir = i % 2 === 0 ? 1 : -1;
            const car = this.add.circle(dir > 0 ? -20 : GAME_WIDTH + 20, deckY + 3, 2.4, dir > 0 ? 0xfff1c4 : 0xff8080, 0.9);
            car.setDepth(-13);
            this.tweens.add({
                targets: car,
                x: dir > 0 ? GAME_WIDTH + 20 : -20,
                duration: 9000 + Math.random() * 6000,
                repeat: -1,
                delay: Math.random() * 5000,
            });
        }
    }

    // ------------------------------------------------------------------
    // Grid telemetry overlay (substation nodes + transmission lines)
    // ------------------------------------------------------------------

    private buildGridOverlay() {
        this.gridLines = this.add.graphics();
        this.gridLines.setDepth(5);
        this.gridLines.setAlpha(0.85);
        this.redrawGridLines();

        const defs: Array<{ id: string; x: number; y: number; label: string; status: string }> = [
            { id: 'CORE', x: GAME_WIDTH * 0.16, y: GAME_HEIGHT * 0.30, label: 'OPS CORE', status: 'online' },
            { id: 'E01', x: GAME_WIDTH * 0.58, y: GAME_HEIGHT * 0.22, label: 'EAST-01', status: 'online' },
            { id: 'E02', x: GAME_WIDTH * 0.74, y: GAME_HEIGHT * 0.42, label: 'EAST-02', status: 'online' },
            { id: 'MARINA', x: GAME_WIDTH * 0.88, y: GAME_HEIGHT * 0.60, label: 'MARINA JCT', status: 'online' },
            { id: 'HOSPITAL', x: GAME_WIDTH * 0.40, y: GAME_HEIGHT * 0.52, label: 'NALÉ HOSPITAL', status: 'online' },
        ];

        defs.forEach((d) => {
            const c = this.add.container(d.x, d.y).setDepth(6);
            const glow = this.add.circle(0, 0, 18, 0x06b6d4, 0.10);
            const dot = this.add.circle(0, 0, 6, 0x10b981, 1);
            const ring = this.add.circle(0, 0, 11).setStrokeStyle(1.5, 0x06b6d4, 0.8);
            const txt = this.add.text(0, 22, d.label, {
                fontFamily: 'monospace',
                fontSize: '12px',
                color: '#9fb3d1',
            }).setOrigin(0.5, 0);
            c.add([glow, ring, dot, txt]);
            this.nodes.push(c);
            this.nodeStates[d.id] = { x: d.x, y: d.y, label: d.label, status: d.status, dot, txt };
            this.tweens.add({ targets: glow, scale: { from: 0.8, to: 1.4 }, alpha: { from: 0.6, to: 0 }, duration: 1800, repeat: -1 });
        });

        // Hospital auxiliary pulse ring (hidden until blackout).
        this.hospitalPulse = this.add.circle(this.nodeStates['HOSPITAL'].x, this.nodeStates['HOSPITAL'].y, 14, COLORS.EMERALD, 0.0);
        this.hospitalPulse.setStrokeStyle(2, COLORS.EMERALD, 0.9).setDepth(6).setVisible(false);
    }

    private redrawGridLines() {
        const g = this.gridLines;
        g.clear();
        const order = ['CORE', 'E01', 'E02', 'MARINA'];
        for (let i = 0; i < order.length - 1; i++) {
            const a = this.nodeStates[order[i]];
            const b = this.nodeStates[order[i + 1]];
            if (!a || !b) continue;
            const down = a.status === 'offline' || b.status === 'offline';
            g.lineStyle(down ? 1 : 1.6, down ? 0x334155 : 0x06b6d4, down ? 0.5 : 0.85);
            g.lineBetween(a.x, a.y, b.x, b.y);
        }
        const core = this.nodeStates['CORE'];
        const hosp = this.nodeStates['HOSPITAL'];
        if (core && hosp) {
            g.lineStyle(1.4, hosp.status === 'auxiliary' ? 0x10b981 : 0x06b6d4, 0.8);
            g.lineBetween(core.x, core.y, hosp.x, hosp.y);
        }
        const e02 = this.nodeStates['E02'];
        if (e02 && hosp) {
            const down = e02.status === 'offline';
            g.lineStyle(down ? 1 : 1.4, down ? 0x334155 : 0xf59e0b, down ? 0.45 : 0.8);
            g.lineBetween(e02.x, e02.y, hosp.x, hosp.y);
        }
    }

    private setNodeStatus(id: string, status: 'online' | 'offline' | 'unstable' | 'auxiliary') {
        const n = this.nodeStates[id];
        if (!n) return;
        n.status = status;
        const color = status === 'offline' ? COLORS.CRIMSON
            : status === 'unstable' ? COLORS.AMBER
                : status === 'auxiliary' ? COLORS.EMERALD
                    : COLORS.CYAN;
        n.dot.setFillStyle(color, 1);
        n.txt.setColor(status === 'offline' ? '#fca5a5' : '#9fb3d1');
        n.txt.setText(n.label + (status === 'offline' ? '  ✕' : status === 'unstable' ? '  ⚠' : status === 'auxiliary' ? '  AUX' : ''));
        this.redrawGridLines();
        if (status === 'offline') {
            this.spawnSparks(n.x, n.y, 8);
            this.fireSfx('power');
        }
    }

    // ------------------------------------------------------------------
    // Radar + scan bar + vignette
    // ------------------------------------------------------------------

    private buildRadar() {
        const cx = GAME_WIDTH - 90;
        const cy = 90;
        const r = 62;
        this.radar = this.add.graphics();
        this.radar.setDepth(7);
        this.radar.lineStyle(1, 0x06b6d4, 0.35);
        this.radar.strokeCircle(cx, cy, r);
        this.radar.strokeCircle(cx, cy, r * 0.66);
        this.radar.strokeCircle(cx, cy, r * 0.33);
        this.radar.lineBetween(cx - r, cy, cx + r, cy);
        this.radar.lineBetween(cx, cy - r, cx, cy + r);
        // store center for sweep
        (this.radar as any).__cx = cx;
        (this.radar as any).__cy = cy;
        (this.radar as any).__r = r;
    }

    private buildScanBar() {
        this.scanBar = this.add.rectangle(0, 0, GAME_WIDTH, 2, 0x06b6d4, 0.06);
        this.scanBar.setOrigin(0, 0).setDepth(8);
    }

    private buildVignette() {
        const v = this.add.graphics();
        v.setDepth(9);
        v.fillStyle(0x000000, 0.35);
        v.fillRect(0, 0, GAME_WIDTH, 26);
        v.fillRect(0, GAME_HEIGHT - 26, GAME_WIDTH, 26);
        v.fillRect(0, 0, 26, GAME_HEIGHT);
        v.fillRect(GAME_WIDTH - 26, 0, 26, GAME_HEIGHT);
        // Subtle horizontal scanlines across the whole canvas.
        const sl = this.add.graphics();
        sl.setDepth(8);
        sl.fillStyle(0x000000, 0.07);
        for (let y = 0; y < GAME_HEIGHT; y += 4) sl.fillRect(0, y, GAME_WIDTH, 1);
    }

    private spawnSparks(x: number, y: number, count: number) {
        const g = this.add.graphics();
        g.setDepth(10);
        const parts: Array<{ x: number; y: number; vx: number; vy: number; life: number; col: number }> = [];
        for (let i = 0; i < count; i++) {
            parts.push({
                x, y,
                vx: (Math.random() - 0.5) * 220,
                vy: (Math.random() - 0.5) * 220 - 40,
                life: 0.4 + Math.random() * 0.5,
                col: Math.random() > 0.5 ? 0xffd166 : 0xef4444,
            });
        }
        const draw = () => {
            g.clear();
            let alive = false;
            parts.forEach((p) => {
                if (p.life <= 0) return;
                alive = true;
                g.fillStyle(p.col, clamp(p.life * 2, 0, 1));
                g.fillRect(p.x, p.y, 2.4, 2.4);
            });
            if (!alive) g.destroy();
        };
        this.time.addEvent({
            delay: 16,
            loop: true,
            callback: () => {
                parts.forEach((p) => {
                    if (p.life <= 0) return;
                    p.life -= 0.03;
                    p.x += p.vx * 0.016;
                    p.y += p.vy * 0.016;
                    p.vy += 260 * 0.016;
                });
                draw();
            },
        });
    }

    // ------------------------------------------------------------------
    // Per-frame
    // ------------------------------------------------------------------

    update(time: number, delta: number) {
        const dt = delta / 1000;

        // Radar sweep.
        const cx = (this.radar as any).__cx as number;
        const cy = (this.radar as any).__cy as number;
        const r = (this.radar as any).__r as number;
        this.radarAngle += dt * 1.6;
        this.radar.lineStyle(2, 0x06b6d4, 0.9);
        this.radar.lineBetween(cx, cy, cx + Math.cos(this.radarAngle) * r, cy + Math.sin(this.radarAngle) * r);
        // Fade the sweep by overpainting a translucent disc.
        this.radar.fillStyle(0x04070e, 0.06);
        this.radar.fillCircle(cx, cy, r);

        // Scan bar travel.
        this.scanlineY = (this.scanlineY + dt * 90) % GAME_HEIGHT;
        this.scanBar.setY(this.scanlineY);

        // Beacon blink on offline nodes.
        this.beaconT += dt;
        const blink = Math.sin(this.beaconT * 6) > 0;
        Object.values(this.nodeStates).forEach((n) => {
            if (n.status === 'offline') n.dot.setAlpha(blink ? 0.35 : 1);
            else n.dot.setAlpha(1);
        });

        // Occasional ambient window flicker in the western (live) sector.
        if (!this.blackout && Math.random() < 0.01) {
            const b = this.buildings[Math.floor(Math.random() * this.buildings.length)];
            if (b && !b.east) {
                const i = Math.floor(Math.random() * b.lit.length);
                b.lit[i] = !b.lit[i];
                this.redrawWindows();
            }
        }
    }
}

const StartGame = (parent: string) => {
    const config: Phaser.Types.Core.GameConfig = {
        type: AUTO,
        width: GAME_WIDTH,
        height: GAME_HEIGHT,
        parent,
        backgroundColor: '#04070e',
        scale: {
            mode: Scale.FIT,
            autoCenter: Scale.CENTER_BOTH,
        },
        physics: {
            default: 'arcade',
            arcade: { gravity: { x: 0, y: 0 } },
        },
        scene: [Game],
    };

    const game = new PhaserGame(config);
    if (typeof window !== 'undefined') {
        (window as any).__PHASER_GAME__ = game;
        (window as any).__PHASER_EVENT_BUS__ = EventBus;
    }
    return game;
};

export default StartGame;
