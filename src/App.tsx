import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import StartGame, {
    EventBus,
    EVT_PHASE_CHANGED,
    EVT_RESOURCE_UPDATED,
    EVT_GRID_STATUS_ALERT,
    EVT_TRIGGER_SFX,
    EVT_CURRENT_SCENE_READY,
} from './game/main';
import type { ResourceSnapshot } from './game/main';

export interface IRefPhaserGame {
    game: Phaser.Game | null;
    scene: Phaser.Scene | null;
}

// ---------------------------------------------------------------------------
// AFTERLIGHT — deterministic resource engine + crisis state machine (React).
// ---------------------------------------------------------------------------

type GamePhase =
    | 'TITLE'
    | 'OPERATIONS_INTRO'
    | 'CRISIS_BRIEFING'
    | 'OVIE_REPORT'
    | 'ANOMALY_TRANSMISSION'
    | 'DECISION_SCREEN'
    | 'CONSEQUENCE_SCREEN'
    | 'DEBRIEF';

const INITIAL: ResourceSnapshot = { power: 80, water: 80, comms: 80, lives: 90, trust: 70 };

type ResKey = keyof ResourceSnapshot;

const RES_META: Array<{ key: ResKey; label: string; color: string }> = [
    { key: 'power', label: 'POWER', color: '#06b6d4' },
    { key: 'water', label: 'WATER', color: '#38bdf8' },
    { key: 'comms', label: 'COMMUNICATION', color: '#a78bfa' },
    { key: 'lives', label: 'LIVES', color: '#10b981' },
    { key: 'trust', label: 'PUBLIC TRUST', color: '#f59e0b' },
];

type Deltas = Partial<ResourceSnapshot>;

interface Choice {
    id: 'A' | 'B' | 'C';
    keyLabel: string;
    title: string;
    rationale: string;
    deltas: Deltas;
    outcome: string;
}

const CHOICES: Choice[] = [
    {
        id: 'A',
        keyLabel: '1 / A',
        title: 'RESTORE MAIN GRID',
        rationale:
            'Reroute primary high-voltage transmission lines to stabilize widespread commercial and municipal circuits.',
        deltas: { power: 15, water: 5, lives: -5, trust: 2 },
        outcome:
            'Eastern commercial corridors relight in stages. Municipal water boosters recover pressure, but hospital transfer crews report a fatal window on backup power. Families in East-02 lost critical time. The city sees a coordinator who chose the grid — the ledger records both the light and the cost.',
    },
    {
        id: 'B',
        keyLabel: '2 / B',
        title: 'PROTECT HOSPITAL',
        rationale:
            'Isolate and dedicate the emergency grid relay exclusively to Asivaro Central Hospital and ICU life-support wards.',
        deltas: { lives: 8, power: -10, water: -3, trust: 5 },
        outcome:
            'ICU ventilators hold steady through the night. Asivaro Central Teaching Hospital logs zero transfer casualties. The wider eastern grid stays dark and water pressure drops across two districts, but public message boards carry one repeated word: "They kept the hospital alive."',
    },
    {
        id: 'C',
        keyLabel: '3 / C',
        title: 'WAIT FOR MORE INFORMATION',
        rationale:
            'Hold manual switches, dispatch drone recon and field teams to isolate the grid fault before any reroute.',
        deltas: { power: -5, water: -5, comms: 3, lives: -3, trust: -2 },
        outcome:
            'Drone telemetry confirms a cascading transformer fault at Marina Junction — valuable intelligence, bought with time. Two more substations sag under load. The emergency repeaters stabilize from the survey uplink, but the public hears only silence from Sector 4.',
    },
];

const clamp = (v: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v));

function applyDeltas(res: ResourceSnapshot, d: Deltas): ResourceSnapshot {
    return {
        power: clamp(res.power + (d.power ?? 0)),
        water: clamp(res.water + (d.water ?? 0)),
        comms: clamp(res.comms + (d.comms ?? 0)),
        lives: clamp(res.lives + (d.lives ?? 0)),
        trust: clamp(res.trust + (d.trust ?? 0)),
    };
}

const PHASE_ORDER: GamePhase[] = [
    'TITLE',
    'OPERATIONS_INTRO',
    'CRISIS_BRIEFING',
    'OVIE_REPORT',
    'ANOMALY_TRANSMISSION',
    'DECISION_SCREEN',
    'CONSEQUENCE_SCREEN',
    'DEBRIEF',
];

// ---------------------------------------------------------------------------
// Web Audio synthesis engine — zero external files, 100% reliable playback.
// ---------------------------------------------------------------------------

class AudioEngine {
    private ctx: AudioContext | null = null;
    muted = false;

    private ensure(): AudioContext | null {
        if (typeof window === 'undefined') return null;
        const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!AC) return null;
        if (!this.ctx) this.ctx = new AC();
        if (this.ctx.state === 'suspended') void this.ctx.resume();
        return this.ctx;
    }

    private tone(freq: number, dur: number, type: OscillatorType, gain = 0.12, slideTo?: number) {
        if (this.muted) return;
        const ctx = this.ensure();
        if (!ctx) return;
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        osc.type = type;
        osc.frequency.setValueAtTime(freq, ctx.currentTime);
        if (slideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(20, slideTo), ctx.currentTime + dur);
        g.gain.setValueAtTime(0.0001, ctx.currentTime);
        g.gain.exponentialRampToValueAtTime(gain, ctx.currentTime + 0.015);
        g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);
        osc.connect(g).connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + dur + 0.02);
    }

    private noise(dur: number, gain = 0.06, hp = 800) {
        if (this.muted) return;
        const ctx = this.ensure();
        if (!ctx) return;
        const len = Math.floor(ctx.sampleRate * dur);
        const buf = ctx.createBuffer(1, len, ctx.sampleRate);
        const data = buf.getChannelData(0);
        for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
        const src = ctx.createBufferSource();
        src.buffer = buf;
        const filt = ctx.createBiquadFilter();
        filt.type = 'highpass';
        filt.frequency.value = hp;
        const g = ctx.createGain();
        g.gain.value = gain;
        src.connect(filt).connect(g).connect(ctx.destination);
        src.start();
    }

    /**
     * Band-passed radio static burst — the anomaly transmission cue.
     * Subtle carrier hiss + two short squelch crackles, no jumpscare.
     */
    private radioStatic(dur: number, gain = 0.05, center = 1600) {
        if (this.muted) return;
        const ctx = this.ensure();
        if (!ctx) return;
        const len = Math.floor(ctx.sampleRate * dur);
        const buf = ctx.createBuffer(1, len, ctx.sampleRate);
        const data = buf.getChannelData(0);
        for (let i = 0; i < len; i++) {
            // gentle fade in/out envelope over raw noise
            const env = Math.min(1, i / (len * 0.12)) * Math.min(1, (len - i) / (len * 0.25));
            data[i] = (Math.random() * 2 - 1) * env;
        }
        const src = ctx.createBufferSource();
        src.buffer = buf;
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = center;
        bp.Q.value = 0.8;
        const g = ctx.createGain();
        g.gain.value = gain;
        src.connect(bp).connect(g).connect(ctx.destination);
        src.start();
    }

    play(type: 'alarm' | 'click' | 'radio' | 'decision' | 'power' | 'advance' | 'boot' | 'anomaly' | 'carrier') {
        switch (type) {
            case 'alarm':
                this.tone(660, 0.16, 'square', 0.07);
                window.setTimeout(() => this.tone(520, 0.18, 'square', 0.07), 190);
                window.setTimeout(() => this.tone(660, 0.16, 'square', 0.06), 400);
                break;
            case 'click':
                this.tone(880, 0.05, 'triangle', 0.08);
                break;
            case 'advance':
                this.tone(420, 0.07, 'sine', 0.09, 620);
                break;
            case 'radio':
                this.noise(0.18, 0.05, 1200);
                this.tone(1200, 0.06, 'sine', 0.05);
                window.setTimeout(() => this.noise(0.1, 0.035, 900), 120);
                break;
            case 'anomaly':
                // Carrier hiss under two squelch crackles + a low detuned pulse.
                this.radioStatic(0.9, 0.05, 1500);
                window.setTimeout(() => this.radioStatic(0.25, 0.045, 2400), 260);
                window.setTimeout(() => this.radioStatic(0.35, 0.04, 900), 700);
                window.setTimeout(() => this.tone(90, 0.35, 'sine', 0.05, 60), 120);
                break;
            case 'decision':
                this.tone(300, 0.22, 'sawtooth', 0.06, 180);
                this.noise(0.12, 0.04, 500);
                break;
            case 'power':
                this.tone(120, 0.4, 'sine', 0.12, 45);
                this.noise(0.25, 0.05, 300);
                break;
            case 'boot':
                this.tone(220, 0.3, 'sine', 0.06, 440);
                break;
            case 'carrier':
                // Sustained light radio carrier bed — subtle static under speech.
                this.radioStatic(3.5, 0.025, 1400);
                break;
        }
    }
}

const audioEngine = new AudioEngine();

// ---------------------------------------------------------------------------
// Speech Synthesis helper — OVIE's vocal dialogue (Web Speech API).
// Calm, professional field-technician tone. All callers degrade gracefully
// when speechSynthesis is unavailable/blocked (typewriter fallback still
// completes so the player can always advance).
// ---------------------------------------------------------------------------

interface SpeakOptions {
    text: string;
    muted: boolean;
    /** Called with the character index reached so far (word-boundary sync). */
    onProgress: (charIndex: number) => void;
    /** Called once when speech starts (or immediately when unavailable). */
    onStart: () => void;
    /** Called once when speech ends, errors, or is cancelled. */
    onEnd: () => void;
}

const SPEAK_RATE = 1.04;
const SPEAK_PITCH = 0.96;

// ---------------------------------------------------------------------------
// CHARACTER_VOICE_PROFILES — Nigerian voice direction casting spec.
// Setting: Asivaro City (fictional contemporary African metropolis).
// Authentic Nigerian English pronunciation, natural rhythm, professional tone,
// restrained delivery, zero caricature.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Global voice direction: Natural Nigerian English (en-NG).
// Prohibited: generic African accents, American/British RP, exaggerated
// accents, comedy voices, stereotypical ethnic speech, forced Pidgin.
// ---------------------------------------------------------------------------
const CHARACTER_VOICE_PROFILES = {
    OVIE: {
        gender: 'male',
        ageRange: 'early 40s',
        ethnicity: 'Urhobo',
        origin: 'Delta State, Nigeria',
        role: 'Senior Field Infrastructure Technician',
        tone: 'calm, practical, technically excellent, controlled urgency',
        locale: 'en-NG',
        pitch: 0.94,
        rate: 1.0,
    },
    MAMA_KEMI: {
        gender: 'female',
        ageRange: 'late 60s',
        ethnicity: 'Yoruba',
        origin: 'Lagos State, Nigeria',
        role: 'Retired Senior Director, Federal Ministry of Power',
        tone: 'warm, authoritative, formidable',
        locale: 'en-NG',
        pitch: 1.0,
        rate: 0.96,
    },
    DR_ESE: {
        gender: 'female',
        ageRange: '30s',
        ethnicity: 'Urhobo',
        origin: 'Delta State, Nigeria',
        role: 'Hospital Director, Asivaro Central Teaching Hospital',
        tone: 'intelligent, composed, compassionate, decisive',
        locale: 'en-NG',
        pitch: 1.02,
        rate: 1.0,
    },
    CHINEDU: {
        gender: 'male',
        ageRange: '30s',
        ethnicity: 'Igbo',
        origin: 'Eastern Nigeria',
        role: 'Telecommunications Engineer',
        tone: 'analytical, technically sharp, confident, fast-thinking, calm',
        locale: 'en-NG',
        pitch: 1.05,
        rate: 1.06,
    },
    THE_MAYOR: {
        gender: 'male',
        ageRange: '50–60',
        ethnicity: 'Northern Nigerian',
        origin: 'Northern Nigeria',
        role: 'Experienced Public-Sector Leader',
        tone: 'strategic, composed, articulate, measured',
        locale: 'en-NG',
        pitch: 0.88,
        rate: 0.94,
    },
} as const;

/**
 * Pick a natural professional Nigerian English voice for Ovie.
 * Priority: en-NG → West African (en-GH) → African English (en-ZA, en-KE)
 * → clean international English (en-GB, en-US) with male/natural hints.
 */
function pickOvieVoice(): SpeechSynthesisVoice | null {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return null;
    const voices = window.speechSynthesis.getVoices();
    if (!voices || voices.length === 0) return null;
    const english = voices.filter((v) => /^en([-_]|$)/i.test(v.lang || ''));
    const pool = english.length > 0 ? english : voices;
    const maleHints = /(male|daniel|alex|fred|george|james|oliver|thomas|aaron|arthur|roger|david|mark|paul)/i;
    const naturalHints = /(natural|neural|premium|enhanced|google)/i;
    const nigerianHints = /(nigerian|nigeria|en.ng|en_ng)/i;
    const score = (v: SpeechSynthesisVoice) => {
        let s = 0;
        // Nigerian English locale is top priority
        if (/^en[-_]NG/i.test(v.lang)) s += 10;
        else if (/^en[-_]GH/i.test(v.lang)) s += 7;
        else if (/^en[-_](ZA|KE|TZ)/i.test(v.lang)) s += 5;
        else if (/^en-GB/i.test(v.lang)) s += 2;
        else if (/^en-US/i.test(v.lang)) s += 1;
        // Name-based Nigerian hints
        if (nigerianHints.test(v.name)) s += 8;
        if (maleHints.test(v.name)) s += 3;
        if (naturalHints.test(v.name)) s += 2;
        if (v.default) s += 0.5;
        return s;
    };
    return [...pool].sort((a, b) => score(b) - score(a))[0] ?? null;
}

/**
 * Speak `text` aloud. Returns a cancel() handle that safely aborts the
 * utterance (idempotent). If speechSynthesis is unavailable or blocked,
 * onStart/onEnd fire on a short timer so subtitle + advance flow never stall.
 */
function speakOvie(opts: SpeakOptions): () => void {
    const { text, muted, onProgress, onStart, onEnd } = opts;
    let done = false;
    let cancelled = false;
    let fallbackTimer = 0;

    const finish = () => {
        if (done) return;
        done = true;
        window.clearTimeout(fallbackTimer);
        onEnd();
    };

    const supported =
        typeof window !== 'undefined' &&
        'speechSynthesis' in window &&
        typeof window.SpeechSynthesisUtterance !== 'undefined';

    if (!supported) {
        // Degrade: let the typewriter run on its own timer; report start/end.
        onStart();
        const est = Math.max(2500, (text.length / 14) * 1000);
        fallbackTimer = window.setTimeout(finish, est);
        return () => {
            cancelled = true;
            window.clearTimeout(fallbackTimer);
        };
    }

    const synth = window.speechSynthesis;
    // Some browsers populate voices asynchronously; nudge them awake.
    if (synth.getVoices().length === 0) {
        // getVoices() may still be empty on first call — the utterance will
        // simply use the default voice. No action needed beyond reading it.
    }

    try {
        synth.cancel();
    } catch {
        /* ignore */
    }

    const u = new SpeechSynthesisUtterance(text);
    u.rate = CHARACTER_VOICE_PROFILES.OVIE.rate;
    u.pitch = CHARACTER_VOICE_PROFILES.OVIE.pitch;
    u.volume = muted ? 0 : 1;
    u.lang = 'en-NG';
    const voice = pickOvieVoice();
    if (voice) u.voice = voice;

    u.onstart = () => {
        if (!cancelled) onStart();
    };
    u.onboundary = (e: SpeechSynthesisEvent) => {
        if (cancelled) return;
        if (typeof e.charIndex === 'number') onProgress(e.charIndex);
    };
    u.onend = finish;
    u.onerror = finish;

    try {
        synth.speak(u);
    } catch {
        onStart();
        finish();
    }

    // Safety net: if onstart never fires (blocked autoplay), start the flow
    // and guarantee completion so the player can always advance.
    fallbackTimer = window.setTimeout(() => {
        if (!cancelled) onStart();
        finish();
    }, Math.max(4000, (text.length / 12) * 1000));

    return () => {
        cancelled = true;
        try {
            synth.cancel();
        } catch {
            /* ignore */
        }
        window.clearTimeout(fallbackTimer);
    };
}

// ---------------------------------------------------------------------------
// Inline SVG icons (no icon libraries in this project).
// ---------------------------------------------------------------------------

const IconBolt = () => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M13 2 4 14h6l-1 8 9-12h-6l1-8z" />
    </svg>
);
const IconDrop = () => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z" />
    </svg>
);
const IconAntenna = () => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M12 8v13M5 3l7 5 7-5M7 21h10" />
        <circle cx="12" cy="8" r="1.6" />
    </svg>
);
const IconHeart = () => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M12 20s-7-4.6-9.2-9A5.2 5.2 0 0 1 12 6.5 5.2 5.2 0 0 1 21.2 11C19 15.4 12 20 12 20z" />
    </svg>
);
const IconShield = () => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3z" />
    </svg>
);
const IconSound = ({ muted }: { muted: boolean }) => (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M4 9v6h4l5 4V5L8 9H4z" />
        {muted ? <path d="M17 9l4 6M21 9l-4 6" /> : <path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12" />}
    </svg>
);
const IconRestart = () => (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M20 12a8 8 0 1 1-2.3-5.6M20 4v5h-5" />
    </svg>
);
const IconAlert = () => (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M12 4 2.5 20h19L12 4zM12 10v4M12 17.5v.5" />
    </svg>
);
const IconRadio = () => (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <rect x="3" y="9" width="18" height="11" rx="2" />
        <path d="M7 9V6h10v3M7 14h.01M11 14h6" />
    </svg>
);
const IconCheck = () => (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M4 12.5 9.5 18 20 6.5" />
    </svg>
);

const RES_ICONS: Record<ResKey, () => ReactElement> = {
    power: IconBolt,
    water: IconDrop,
    comms: IconAntenna,
    lives: IconHeart,
    trust: IconShield,
};

// ---------------------------------------------------------------------------
// OVIE — procedural field technician avatar (SVG, dignified contemporary
// portrayal: utility helmet with headlamp, comms headset, reflective gear).
// ---------------------------------------------------------------------------

function OvieAvatar({ speaking }: { speaking: boolean }) {
    return (
        <div className={`ovie-avatar ${speaking ? 'speaking' : ''}`}>
            <svg viewBox="0 0 120 120" width="96" height="96" role="img" aria-label="Ovie, field infrastructure technician">
                <defs>
                    <linearGradient id="skin" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#8a5a3b" />
                        <stop offset="100%" stopColor="#6b422a" />
                    </linearGradient>
                    <linearGradient id="hi-viz" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#f59e0b" />
                        <stop offset="100%" stopColor="#b45309" />
                    </linearGradient>
                </defs>
                {/* shoulders / utility jacket */}
                <path d="M14 118c2-24 18-34 46-34s44 10 46 34z" fill="#1f2937" />
                <path d="M30 96l6 22M84 96l6 22" stroke="#e5e7eb" strokeWidth="4" opacity="0.85" />
                <rect x="52" y="82" width="16" height="10" rx="2" fill="#374151" />
                {/* neck */}
                <rect x="52" y="70" width="16" height="16" fill="url(#skin)" />
                {/* head */}
                <ellipse cx="60" cy="52" rx="21" ry="24" fill="url(#skin)" />
                {/* ear + headset */}
                <circle cx="39" cy="54" r="6" fill="#111827" />
                <path d="M39 48a21 21 0 0 1 42 0" stroke="#111827" strokeWidth="4" fill="none" />
                <rect x="78" y="50" width="6" height="12" rx="3" fill="#111827" />
                <path d="M81 62c0 8-6 10-12 11" stroke="#111827" strokeWidth="3" fill="none" />
                <circle cx="67" cy="74" r="3" fill="#06b6d4" />
                {/* helmet */}
                <path d="M36 44a24 24 0 0 1 48 0v4H36z" fill="url(#hi-viz)" />
                <rect x="34" y="46" width="52" height="5" rx="2" fill="#fbbf24" />
                {/* headlamp */}
                <rect x="54" y="34" width="14" height="9" rx="2" fill="#1f2937" />
                <circle cx="61" cy="38.5" r="3.4" fill={speaking ? '#fef9c3' : '#fde68a'} />
                {speaking && <circle cx="61" cy="38.5" r="7" fill="#fde68a" opacity="0.35" />}
                {/* face features */}
                <path d="M50 52h7M63 52h7" stroke="#3b2416" strokeWidth="2.4" strokeLinecap="round" />
                <path d="M57 60h6" stroke="#3b2416" strokeWidth="2" strokeLinecap="round" />
                <path d="M52 67c4 3 12 3 16 0" stroke="#3b2416" strokeWidth="2.2" fill="none" strokeLinecap="round" className="ovie-mouth" />
            </svg>
            <div className="ovie-wave" aria-hidden>
                {Array.from({ length: 14 }).map((_, i) => (
                    <span key={i} style={{ animationDelay: `${i * 0.07}s` }} />
                ))}
            </div>
        </div>
    );
}

// ---------------------------------------------------------------------------
// Resource HUD
// ---------------------------------------------------------------------------

function ResourceGauges({ res, deltas }: { res: ResourceSnapshot; deltas?: Deltas | null }) {
    return (
        <div className="gauges" role="group" aria-label="City resources">
            {RES_META.map(({ key, label, color }) => {
                const v = res[key];
                const d = deltas?.[key];
                const state = v < 30 ? 'crit' : v <= 70 ? 'warn' : 'ok';
                const Icon = RES_ICONS[key];
                return (
                    <div className={`gauge ${state}`} key={key}>
                        <div className="gauge-head" style={{ color }}>
                            <Icon />
                            <span className="gauge-label">{label}</span>
                            {typeof d === 'number' && d !== 0 && (
                                <span className={`delta-chip ${d > 0 ? 'up' : 'down'}`}>
                                    {d > 0 ? `+${d}` : d}
                                </span>
                            )}
                        </div>
                        <div className="gauge-bar">
                            <div
                                className="gauge-fill"
                                style={{ width: `${v}%`, background: color, boxShadow: `0 0 12px ${color}66` }}
                            />
                        </div>
                        <div className="gauge-value">
                            {v}<span className="gauge-max">/100</span>
                        </div>
                    </div>
                );
            })}
        </div>
    );
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

function App() {
    const phaserRef = useRef<IRefPhaserGame | null>(null);
    const [phase, setPhase] = useState<GamePhase>('TITLE');
    const [res, setRes] = useState<ResourceSnapshot>(INITIAL);
    const [prevRes, setPrevRes] = useState<ResourceSnapshot>(INITIAL);
    const [lastChoice, setLastChoice] = useState<Choice | null>(null);
    const [alert, setAlert] = useState<string>('');
    const [muted, setMuted] = useState(false);
    const [booted, setBooted] = useState(false);
    const [bootError, setBootError] = useState(false);
    const [typedLen, setTypedLen] = useState(0);
    const [speechActive, setSpeechActive] = useState(false);
    const logRef = useRef<string[]>([]);
    const [log, setLog] = useState<string[]>([]);
    // Handle to abort the current OVIE voice utterance (speech synthesis).
    const cancelSpeechRef = useRef<(() => void) | null>(null);

    // ---- Phaser mount (template bridge — never remove) -------------------
    useLayoutEffect(() => {
        if (phaserRef.current === null) {
            const game = StartGame('game-container');
            phaserRef.current = { game, scene: null };
        }
        const handler = (scene: Phaser.Scene) => {
            if (phaserRef.current) phaserRef.current.scene = scene;
            setBooted(true);
        };
        EventBus.on(EVT_CURRENT_SCENE_READY, handler);
        const bootTimer = window.setTimeout(() => {
            if (!phaserRef.current?.scene) setBootError(true);
        }, 8000);
        return () => {
            window.clearTimeout(bootTimer);
            EventBus.removeListener(EVT_CURRENT_SCENE_READY, handler);
            if (phaserRef.current) {
                phaserRef.current.game?.destroy(true);
                phaserRef.current = null;
            }
        };
    }, []);

    // ---- Phaser -> React telemetry + sfx ---------------------------------
    useEffect(() => {
        const onAlert = (payload: { status?: string; sector?: string }) => {
            if (payload?.status) setAlert(`${payload.sector ? payload.sector + ' · ' : ''}${payload.status}`);
        };
        const onSfx = (payload: { type?: 'alarm' | 'click' | 'radio' | 'decision' | 'power' | 'anomaly' }) => {
            if (payload?.type) audioEngine.play(payload.type);
        };
        EventBus.on(EVT_GRID_STATUS_ALERT, onAlert);
        EventBus.on(EVT_TRIGGER_SFX, onSfx);
        return () => {
            EventBus.off(EVT_GRID_STATUS_ALERT, onAlert);
            EventBus.off(EVT_TRIGGER_SFX, onSfx);
        };
    }, []);

    // ---- Phase -> tell the canvas ----------------------------------------
    useEffect(() => {
        EventBus.emit(EVT_PHASE_CHANGED, { phase });
    }, [phase]);

    // ---- Resource -> tell the canvas -------------------------------------
    useEffect(() => {
        EventBus.emit(EVT_RESOURCE_UPDATED, res);
    }, [res]);

    // ---- OVIE vocal report: radio squelch + speech synthesis + synced subtitles
    const OVIE_LINE =
        "Coordinator, we've lost the eastern grid. Three substations are offline. I can get one priority system back up, but not everything.";

    const playOvieReport = useCallback(() => {
        // Abort any previous utterance before (re)starting the transmission.
        if (cancelSpeechRef.current) cancelSpeechRef.current();
        audioEngine.play('radio');
        // Light radio carrier + static bed under the field comms transmission.
        audioEngine.play('carrier');
        setTypedLen(0);
        setSpeechActive(true);
        const startedAt = Date.now();
        // Typewriter fallback: keeps subtitles streaming even when speech is
        // blocked/unavailable; speech word-boundaries snap it forward when present.
        const id = window.setInterval(() => {
            setTypedLen((n) => {
                if (n >= OVIE_LINE.length) {
                    window.clearInterval(id);
                    return n;
                }
                return n + 2;
            });
        }, 24);
        cancelSpeechRef.current = speakOvie({
            text: OVIE_LINE,
            muted: audioEngine.muted,
            onProgress: (charIndex) => {
                // Boundary sync: only move the subtitle forward, never rewind.
                setTypedLen((n) => Math.max(n, charIndex));
            },
            onStart: () => {
                setSpeechActive(true);
            },
            onEnd: () => {
                window.clearInterval(id);
                // Guarantee the full line is shown when speech completes.
                setTypedLen(OVIE_LINE.length);
                setSpeechActive(false);
                cancelSpeechRef.current = null;
                void startedAt;
            },
        });
        return () => window.clearInterval(id);
    }, [OVIE_LINE]);

    useEffect(() => {
        if (phase !== 'OVIE_REPORT') {
            if (cancelSpeechRef.current) {
                cancelSpeechRef.current();
                cancelSpeechRef.current = null;
            }
            setSpeechActive(false);
            setTypedLen(0);
            return;
        }
        const cleanup = playOvieReport();
        return () => {
            cleanup();
            if (cancelSpeechRef.current) {
                cancelSpeechRef.current();
                cancelSpeechRef.current = null;
            }
        };
    }, [phase, playOvieReport]);

    // ---- ANOMALY: intercepted emergency transmission (auto 1.6 s beat) ----
    // Fires between Ovie's field report and the decision console. Subtle
    // radio-static cue + glitched terminal overlay, then cleans up on its own.
    useEffect(() => {
        if (phase !== 'ANOMALY_TRANSMISSION') return;
        audioEngine.play('anomaly');
        pushLog('00:02 — Anomalous carrier detected on encrypted band. Source unverified.');
        const id = window.setTimeout(() => {
            setPhase('DECISION_SCREEN');
        }, 1600);
        return () => window.clearTimeout(id);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [phase]);

    // Cancel any in-flight speech on unmount.
    useEffect(
        () => () => {
            if (cancelSpeechRef.current) cancelSpeechRef.current();
        },
        [],
    );

    // ---- Navigation -------------------------------------------------------
    const pushLog = useCallback((line: string) => {
        logRef.current = [...logRef.current, line];
        setLog(logRef.current);
    }, []);

    const advance = useCallback(() => {
        audioEngine.play('advance');
        setPhase((p) => {
            const i = PHASE_ORDER.indexOf(p);
            if (i >= 0 && i < PHASE_ORDER.length - 1 && p !== 'DECISION_SCREEN') {
                return PHASE_ORDER[i + 1];
            }
            return p;
        });
    }, []);

    const startOp = useCallback(() => {
        audioEngine.play('boot');
        setRes(INITIAL);
        setPrevRes(INITIAL);
        setLastChoice(null);
        logRef.current = ['00:00 — Operations shift begins. Sector 4 online.'];
        setLog(logRef.current);
        setAlert('ASIVARO CITY METROPOLITAN OPERATIONS CENTRE — ONLINE');
        setPhase('OPERATIONS_INTRO');
    }, []);

    const choose = useCallback(
        (c: Choice) => {
            audioEngine.play('decision');
            setPrevRes(res);
            const next = applyDeltas(res, c.deltas);
            setRes(next);
            setLastChoice(c);
            pushLog(`Decision ${c.id}: ${c.title} — recorded.`);
            EventBus.emit(EVT_TRIGGER_SFX, { type: 'power' });
            setPhase('CONSEQUENCE_SCREEN');
        },
        [res, pushLog],
    );

    const restart = useCallback(() => {
        audioEngine.play('click');
        setPhase('TITLE');
        setRes(INITIAL);
        setPrevRes(INITIAL);
        setLastChoice(null);
        setAlert('');
        setLog([]);
        logRef.current = [];
        EventBus.emit(EVT_PHASE_CHANGED, { phase: 'TITLE' });
    }, []);

    const toggleMute = useCallback(() => {
        setMuted((m) => {
            audioEngine.muted = !m;
            // Muting stops any in-flight OVIE voice immediately; unmuting
            // plays a confirmation click.
            if (!m && cancelSpeechRef.current) {
                cancelSpeechRef.current();
                cancelSpeechRef.current = null;
                setSpeechActive(false);
            }
            if (m) audioEngine.play('click');
            return !m;
        });
    }, []);

    // ---- Keyboard controls -------------------------------------------------
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            const k = e.key.toLowerCase();
            if (k === 'm') {
                toggleMute();
                return;
            }
            if (k === 'r') {
                restart();
                return;
            }
            if (k === 'v' && phase === 'OVIE_REPORT') {
                // Replay OVIE's vocal transmission (subtitles re-sync).
                playOvieReport();
                return;
            }
            if (k === ' ' || k === 'enter') {
                e.preventDefault();
                if (phase === 'TITLE') startOp();
                else if (phase === 'DEBRIEF') restart();
                else if (phase !== 'DECISION_SCREEN' && phase !== 'ANOMALY_TRANSMISSION') advance();
                return;
            }
            if (phase === 'DECISION_SCREEN') {
                if (k === '1' || k === 'a') choose(CHOICES[0]);
                else if (k === '2' || k === 'b') choose(CHOICES[1]);
                else if (k === '3' || k === 'c') choose(CHOICES[2]);
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [phase, advance, choose, startOp, restart, toggleMute, playOvieReport]);

    // ---- Top bar (visible in all operational phases) -----------------------
    const showHud = phase !== 'TITLE';

    return (
        <div id="app">
            {/* The Phaser canvas mounts into #game-container (src/game/main.ts). */}
            <div id="game-container"></div>

            <div id="hud">
                {bootError && !booted && (
                    <div className="screen center">
                        <div className="panel">
                            <h2 className="crimson">TELEMETRY LINK FAILURE</h2>
                            <p className="muted">The operations canvas failed to boot.</p>
                            <button className="btn primary" onClick={() => window.location.reload()}>
                                RELOAD SYSTEMS
                            </button>
                        </div>
                    </div>
                )}

                {/* Persistent HUD */}
                {showHud && (
                    <header className="topbar">
                        <div className="brand">
                            <span className="brand-mark">◆</span>
                            <span className="brand-name">AFTERLIGHT</span>
                            <span className="brand-sub">ASIVARO CITY · EOC SECTOR 4</span>
                        </div>
                        <div className="alertline" role="status" aria-live="polite">
                            <span className="alert-dot" />
                            {alert || 'MONITORING…'}
                        </div>
                        <div className="topbar-actions">
                            <button className="icon-btn" onClick={toggleMute} aria-label={muted ? 'Unmute' : 'Mute'} title="M (mute)">
                                <IconSound muted={muted} />
                            </button>
                            <button className="icon-btn" onClick={restart} aria-label="Restart simulation" title="R (restart)">
                                <IconRestart />
                            </button>
                        </div>
                    </header>
                )}

                {showHud && (
                    <aside className="sidepanel">
                        <div className="panel-title">CITY STATUS</div>
                        <ResourceGauges res={res} />
                        <div className="panel-title mt">OPERATIONS LOG</div>
                        <ul className="log">
                            {log.map((l, i) => (
                                <li key={i}>{l}</li>
                            ))}
                        </ul>
                    </aside>
                )}

                {/* ---------------- TITLE ---------------- */}
                {phase === 'TITLE' && (
                    <div className="screen center">
                        <div className="title-block">
                            <div className="title-kicker">ASIVARO CITY EMERGENCY OPERATIONS COMMAND — SECTOR 4</div>
                            <h1 className="game-title">
                                AFTER<span className="light">LIGHT</span>
                            </h1>
                            <p className="tagline">WHEN EVERYTHING IS CRITICAL, WHAT DO YOU SAVE FIRST?</p>
                            <button className="btn primary big" onClick={startOp} autoFocus>
                                START
                            </button>
                            <p className="hint">SPACE / ENTER to start · 1·2·3 or A·B·C to decide · M mute · R restart</p>
                        </div>
                    </div>
                )}

                {/* ---------------- OPERATIONS INTRO ---------------- */}
                {phase === 'OPERATIONS_INTRO' && (
                    <div className="screen right-aligned">
                        <div className="panel">
                            <div className="chip cyan">SYSTEM ONLINE</div>
                            <h2>ASIVARO CITY METROPOLITAN OPERATIONS CENTRE</h2>
                            <p>
                                Night shift, Sector 4. The city is awake: 2.4 million residents, a coastal grid, three
                                hospitals on rotating load schedules. Five vital signs stream into this console all night.
                            </p>
                            <p className="muted">
                                You are the Emergency Operations Coordinator. Every decision moves the city — and every
                                number on this board is a person, a ward, a neighbourhood.
                            </p>
                            <div className="btn-row">
                                <button className="btn primary" onClick={advance}>
                                    OPEN MONITORING FEED
                                </button>
                            </div>
                        </div>
                    </div>
                )}

                {/* ---------------- CRISIS BRIEFING ---------------- */}
                {phase === 'CRISIS_BRIEFING' && (
                    <div className="screen right-aligned">
                        <div className="panel crisis">
                            <div className="chip red pulse">
                                <IconAlert /> CURRENT CRISIS: BLACKOUT
                            </div>
                            <h2>MAJOR EASTERN-GRID FAILURE</h2>
                            <p>
                                21:47 local. A cascade fault has taken the eastern transmission ring. Sector 4 telemetry
                                is degrading across the board.
                            </p>
                            <ul className="diag">
                                <li>
                                    <span className="x">✕</span> 3 substations offline — East-01, East-02, Marina Junction
                                </li>
                                <li>
                                    <span className="warn">!</span> Asivaro Central Teaching Hospital on auxiliary generators
                                </li>
                                <li>
                                    <span className="warn">!</span> Municipal water booster pumps losing pressure
                                </li>
                                <li>
                                    <span className="x">✕</span> Cellular &amp; emergency repeaters unstable
                                </li>
                            </ul>
                            <div className="btn-row">
                                <button className="btn primary" onClick={advance}>
                                    ACCEPT FIELD REPORT
                                </button>
                            </div>
                        </div>
                    </div>
                )}

                {/* ---------------- OVIE REPORT ---------------- */}
                {phase === 'OVIE_REPORT' && (
                    <div className="screen radio">
                        <div className="radio-panel">
                            <div className="radio-head">
                                <IconRadio />
                                <span>FIELD DISPATCH · CHANNEL 7</span>
                                <span className="spacer" />
                                <button
                                    className="icon-btn"
                                    onClick={() => playOvieReport()}
                                    aria-label="Replay transmission"
                                    title="Replay transmission (V)"
                                >
                                    <IconRestart />
                                </button>
                                <span className="chip amber">ENCRYPTED</span>
                            </div>
                            <div className="radio-body">
                                <OvieAvatar speaking={speechActive} />
                                <div className="radio-text">
                                    <div className="speaker">
                                        OVIE <span className="role">— Senior Field Infrastructure Technician, East Ring</span>
                                    </div>
                                    <p className="dialogue">
                                        “{OVIE_LINE.slice(0, typedLen)}
                                        {typedLen < OVIE_LINE.length && <span className="caret">▍</span>}”
                                    </p>
                                    {typedLen >= OVIE_LINE.length && (
                                        <div className="btn-row">
                                            <button className="btn primary" onClick={advance} autoFocus>
                                                OPEN DECISION CONSOLE
                                            </button>
                                        </div>
                                    )}
                                </div>
                            </div>
                        </div>
                    </div>
                )}

                {/* ---------------- ANOMALY: INTERCEPTED TRANSMISSION ---------------- */}
                {phase === 'ANOMALY_TRANSMISSION' && (
                    <div className="screen center anomaly-screen">
                        <div className="anomaly-box" role="alert" aria-live="assertive">
                            <div className="anomaly-scanlines" aria-hidden />
                            <div className="anomaly-head">
                                <span className="anomaly-led" aria-hidden />
                                <span>INCOMING EMERGENCY TRANSMISSION</span>
                            </div>
                            <div className="anomaly-meta">
                                <div>
                                    SOURCE: <span className="anomaly-unknown">UNKNOWN</span>
                                </div>
                                <div>
                                    STATUS: <span className="anomaly-unverified">UNVERIFIED</span>
                                </div>
                            </div>
                            <div className="anomaly-rule" aria-hidden />
                            <p className="anomaly-quote" data-text="“DO NOT TRUST THE FIRST REPORT.”">
                                “DO NOT TRUST THE FIRST REPORT.”
                            </p>
                            <div className="anomaly-foot">
                                <span className="anomaly-noise" aria-hidden>
                                    <i /><i /><i /><i /><i /><i /><i /><i />
                                </span>
                                <span className="anomaly-hold">CARRIER LOST — SIGNAL DECRYPT FAILED</span>
                            </div>
                        </div>
                    </div>
                )}

                {/* ---------------- DECISION ---------------- */}
                {phase === 'DECISION_SCREEN' && (
                    <div className="screen decision">
                        <div className="decision-head">
                            <div className="chip red pulse">DECISION REQUIRED</div>
                            <h2>ONE PRIORITY SYSTEM. NOT EVERYTHING.</h2>
                            <p className="muted">Select an action — press 1 / 2 / 3 or A / B / C.</p>
                        </div>
                        <div className="cards">
                            {CHOICES.map((c) => (
                                <button className="card" key={c.id} onClick={() => choose(c)}>
                                    <div className="card-key">{c.keyLabel}</div>
                                    <div className="card-id">{c.id}</div>
                                    <h3>{c.title}</h3>
                                    <p>{c.rationale}</p>
                                    <div className="card-deltas">
                                        {RES_META.filter((m) => (c.deltas[m.key] ?? 0) !== 0).map((m) => {
                                            const d = c.deltas[m.key] as number;
                                            return (
                                                <span key={m.key} className={`mini-chip ${d > 0 ? 'up' : 'down'}`}>
                                                    {m.label.split(' ')[0]} {d > 0 ? `+${d}` : d}
                                                </span>
                                            );
                                        })}
                                    </div>
                                </button>
                            ))}
                        </div>
                    </div>
                )}

                {/* ---------------- CONSEQUENCE ---------------- */}
                {phase === 'CONSEQUENCE_SCREEN' && lastChoice && (
                    <div className="screen consequence">
                        <div className="panel wide">
                            <div className="chip green">
                                <IconCheck /> DECISION RECORDED
                            </div>
                            <h2>
                                OPTION {lastChoice.id} — {lastChoice.title}
                            </h2>
                            <div className="consequence-grid">
                                <div>
                                    <div className="panel-title">IMMEDIATE IMPACT</div>
                                    <div className="delta-list">
                                        {RES_META.map((m) => {
                                            const d = lastChoice.deltas[m.key] ?? 0;
                                            const before = prevRes[m.key];
                                            const after = res[m.key];
                                            return (
                                                <div className="delta-row" key={m.key}>
                                                    <span className="delta-name" style={{ color: m.color }}>
                                                        {m.label}
                                                    </span>
                                                    <span className={`delta-chip ${d > 0 ? 'up' : d < 0 ? 'down' : 'flat'}`}>
                                                        {d > 0 ? `+${d}` : d < 0 ? d : '±0'}
                                                    </span>
                                                    <span className="delta-bar">
                                                        <span className="before" style={{ width: `${before}%` }} />
                                                        <span className="after" style={{ width: `${after}%`, background: m.color }} />
                                                    </span>
                                                    <span className="delta-total">{after}</span>
                                                </div>
                                            );
                                        })}
                                    </div>
                                </div>
                                <div>
                                    <div className="panel-title">SITUATION REPORT — ASIVARO CITY</div>
                                    <p className="outcome">{lastChoice.outcome}</p>
                                    <div className="totals">
                                        {RES_META.map((m) => (
                                            <div className="total-chip" key={m.key} style={{ borderColor: m.color }}>
                                                <span style={{ color: m.color }}>{m.label}</span>
                                                <strong>{res[m.key]}</strong>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            </div>
                            <div className="btn-row">
                                <button className="btn primary" onClick={advance} autoFocus>
                                    CONTINUE
                                </button>
                            </div>
                        </div>
                    </div>
                )}

                {/* ---------------- DEBRIEF ---------------- */}
                {phase === 'DEBRIEF' && (
                    <div className="screen consequence">
                        <div className="panel wide">
                            <div className="chip cyan">NEXT CRISIS — STANDBY</div>
                            <h2>SECTOR 4 DEBRIEF · 22:31 LOCAL</h2>
                            <p>
                                The eastern ring stays dark while crews rebuild the relay chain. The console hums. Somewhere
                                across Asivaro City, another siren is already on its way to your desk.
                            </p>
                            <div className="panel-title mt">SHIFT LOG</div>
                            <ul className="log tall">
                                {log.map((l, i) => (
                                    <li key={i}>{l}</li>
                                ))}
                            </ul>
                            <div className="panel-title mt">FINAL RESOURCE STATE</div>
                            <div className="totals">
                                {RES_META.map((m) => (
                                    <div className="total-chip" key={m.key} style={{ borderColor: m.color }}>
                                        <span style={{ color: m.color }}>{m.label}</span>
                                        <strong>{res[m.key]}</strong>
                                    </div>
                                ))}
                            </div>
                            <div className="btn-row">
                                <button className="btn primary" onClick={restart} autoFocus>
                                    BEGIN NEXT SHIFT
                                </button>
                            </div>
                            <p className="hint">STANDBY NOTICE — cascading night emergencies expected before 02:00.</p>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}

export default App;