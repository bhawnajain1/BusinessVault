import { log } from './log';

// §8 Low-Stock Alerts — short attention sound.
//
// A 220 ms two-tone beep synthesised with WebAudio — no asset needed,
// keeps bundle small, and volume/pitch stay under our control. Browser
// autoplay policy blocks AudioContext writes on tabs that have never
// received a user gesture; we catch the failure quietly and log it so
// silent alerts don't get diagnosed as a "sound broken" bug — they're
// exactly the browser policy the spec asks us to handle gracefully.
//
// Reuses one AudioContext across calls so we don't leak per-alert. The
// context is lazily created on first play — creating one on module import
// counts as a "no-gesture" write on some browsers and puts it into
// suspended state before anyone asks for a beep.

let ctx: AudioContext | null = null;

function ensureCtx(): AudioContext | null {
  if (ctx) return ctx;
  try {
    const Ctor: typeof AudioContext | undefined =
      (window as unknown as { AudioContext?: typeof AudioContext }).AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!Ctor) return null;
    ctx = new Ctor();
    return ctx;
  } catch (e) {
    log.warn('lowStockSound', 'AudioContext unavailable', {
      error: (e as Error).message,
    });
    return null;
  }
}

/**
 * Play the low-stock beep. Resolves silently if autoplay is blocked or
 * audio is otherwise unavailable — never throws. `force` bypasses the
 * "AudioContext must be running" guard so the Settings > Test Sound
 * button can still request a play attempt during the gesture handler.
 */
export async function playLowStockSound(force = false): Promise<void> {
  const c = ensureCtx();
  if (!c) return;
  try {
    if (c.state === 'suspended') {
      // Only resume if the caller is a direct gesture handler; for
      // automatic alerts we bail so we don't queue up beeps that will
      // fire all at once when the user next clicks.
      if (!force) {
        log.info('lowStockSound', 'skipping beep: audio context suspended');
        return;
      }
      await c.resume();
    }
    const now = c.currentTime;
    // Two-note chirp: E5 (659 Hz) → A5 (880 Hz), 100 ms each, quick
    // fade-out envelope so it doesn't click. Total ~220 ms — long enough
    // to draw attention, short enough to not annoy.
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(659, now);
    osc.frequency.setValueAtTime(880, now + 0.1);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.15, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.22);
    osc.connect(gain).connect(c.destination);
    osc.start(now);
    osc.stop(now + 0.24);
  } catch (e) {
    log.warn('lowStockSound', 'beep failed', { error: (e as Error).message });
  }
}
