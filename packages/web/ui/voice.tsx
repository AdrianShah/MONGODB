/**
 * "Listen" on review cards and "Narrate audit trail" on the timeline.
 *
 * The server writes the script and, when it has an ElevenLabs key, the audio. The key never
 * reaches the browser. Without a key, or if ElevenLabs fails, the same script is spoken by the
 * browser's speechSynthesis. Voice is read-only: nothing here can approve or reject.
 */
import { useEffect, useRef, useState } from 'react';
import './voice.css';

interface VoiceConfig {
  elevenlabs: boolean;
  approver: boolean;
}
interface Script {
  text: string;
  audio: string | null;
}

let configCache: { at: number; value: Promise<VoiceConfig> } | undefined;
/** Shared by every button mounted at about the same time; re-asked after a few seconds so a sign-in shows up. */
function voiceConfig(): Promise<VoiceConfig> {
  if (!configCache || Date.now() - configCache.at > 5000) {
    const value = fetch('/api/voice/config', { credentials: 'same-origin' })
      .then((r) => (r.ok ? (r.json() as Promise<VoiceConfig>) : { elevenlabs: false, approver: false }))
      .catch(() => ({ elevenlabs: false, approver: false }));
    configCache = { at: Date.now(), value };
  }
  return configCache.value;
}

const browserSpeech = () => typeof window !== 'undefined' && 'speechSynthesis' in window;

// Only one thing speaks at a time, across all buttons.
let stopCurrent: (() => void) | undefined;

type State = 'idle' | 'loading' | 'playing' | 'error';

function useSpeaker(scriptUrl: string) {
  const [state, setState] = useState<State>('idle');
  const [via, setVia] = useState<'elevenlabs' | 'browser' | null>(null);
  const stopRef = useRef<() => void>(() => {});
  useEffect(() => () => stopRef.current(), []);

  const speakInBrowser = (text: string, done: () => void) => {
    const u = new SpeechSynthesisUtterance(text);
    u.onend = done;
    u.onerror = done;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
    setVia('browser');
    return () => window.speechSynthesis.cancel();
  };

  const play = async () => {
    stopCurrent?.();
    setState('loading');
    let cancelled = false;
    let halt = () => {};
    const done = () => {
      if (stopCurrent === stop) stopCurrent = undefined;
      setState('idle');
    };
    const stop = () => {
      cancelled = true;
      halt();
      done();
    };
    stopRef.current = stop;
    stopCurrent = stop;
    try {
      const res = await fetch(scriptUrl, { credentials: 'same-origin' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const script = (await res.json()) as Script;
      if (cancelled) return;
      if (script.audio) {
        const audioRes = await fetch(script.audio, { credentials: 'same-origin' }).catch(() => undefined);
        if (cancelled) return;
        if (audioRes?.ok) {
          const url = URL.createObjectURL(await audioRes.blob());
          const el = new Audio(url);
          halt = () => {
            el.pause();
            URL.revokeObjectURL(url);
          };
          el.onended = () => {
            URL.revokeObjectURL(url);
            done();
          };
          if (cancelled) return halt();
          setVia('elevenlabs');
          setState('playing');
          await el.play();
          return;
        }
        // ElevenLabs failed (quota, network): fall through to the browser voice.
      }
      if (!browserSpeech()) throw new Error('no speech available');
      halt = speakInBrowser(script.text, done);
      setState('playing');
    } catch {
      if (!cancelled) setState('error');
    }
  };
  return { state, via, play, stop: () => stopRef.current() };
}

function SpeakButton({ scriptUrl, label, testId }: { scriptUrl: string; label: string; testId: string }) {
  const [config, setConfig] = useState<VoiceConfig | null>(null);
  const { state, via, play, stop } = useSpeaker(scriptUrl);
  useEffect(() => {
    let live = true;
    void voiceConfig().then((c) => live && setConfig(c));
    return () => {
      live = false;
    };
  }, []);

  // Approvers only; and with no ElevenLabs key and no browser speech there is nothing to offer.
  if (!config?.approver || (!config.elevenlabs && !browserSpeech())) return null;
  const busy = state === 'loading' || state === 'playing';
  return (
    <span className="voice">
      <button
        type="button"
        className="voice-button"
        onClick={() => (busy ? stop() : void play())}
        aria-pressed={busy}
        data-testid={testId}
        title={config.elevenlabs ? 'Spoken with ElevenLabs. Read-only: it never approves.' : 'Spoken by your browser. Read-only: it never approves.'}
      >
        <span aria-hidden>{busy ? '■' : '▶'}</span> {state === 'loading' ? 'Loading…' : busy ? 'Stop' : label}
      </button>
      {state === 'playing' && via && <span className="voice-via">{via === 'elevenlabs' ? 'ElevenLabs' : 'browser voice'}</span>}
      {state === 'error' && <span className="voice-via error">voice unavailable</span>}
    </span>
  );
}

/** Reads the review card aloud: amount, tier, reason, evidence, rule broken, "1 of 2". */
export function ListenButton({ reviewId }: { reviewId: string }) {
  return <SpeakButton scriptUrl={`/api/voice/review/${encodeURIComponent(reviewId)}`} label="Listen" testId="listen" />;
}

/** Narrates the ticket's audit trail from the same timeline aggregation. */
export function NarrateButton({ traceId }: { traceId: string }) {
  return (
    <SpeakButton scriptUrl={`/api/voice/timeline/${encodeURIComponent(traceId)}`} label="Narrate audit trail" testId="narrate" />
  );
}
