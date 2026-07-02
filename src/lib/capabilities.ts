// Feature detection so the app can tell the user up-front whether it will work
// in their browser (rather than failing at "Start rehearsal").

import type { AppSettings } from '../store/settings'
import { isPremiumEngine } from '../tts/premium'
import { ENGINE_INFO } from '../tts/premiumVoices'

export interface Capabilities {
  secureContext: boolean
  getUserMedia: boolean
  webgpu: boolean
  webSpeechRecognition: boolean
  speechSynthesis: boolean
  wasm: boolean
}

export function detectCapabilities(): Capabilities {
  const w = window as unknown as Record<string, unknown>
  return {
    secureContext: typeof window !== 'undefined' && !!window.isSecureContext,
    getUserMedia: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
    webgpu: typeof navigator !== 'undefined' && 'gpu' in navigator,
    webSpeechRecognition: !!(w.SpeechRecognition || w.webkitSpeechRecognition),
    speechSynthesis: typeof window !== 'undefined' && 'speechSynthesis' in window,
    wasm: typeof WebAssembly === 'object',
  }
}

export function browserLabel(): string {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''
  if (/Firefox\//.test(ua)) return 'Firefox'
  if (/Edg\//.test(ua)) return 'Edge'
  if (/OPR\//.test(ua)) return 'Opera'
  if (/Chrome\//.test(ua)) return 'Chrome'
  if (/Safari\//.test(ua)) return 'Safari'
  return 'this browser'
}

export type CompatLevel = 'error' | 'warn' | 'ok'

export interface CompatIssue {
  level: Exclude<CompatLevel, 'ok'>
  message: string
}

/** Assess whether the current settings will work in this browser. */
export function compatibilityReport(caps: Capabilities, settings: AppSettings): CompatIssue[] {
  const issues: CompatIssue[] = []

  if (!caps.secureContext) {
    issues.push({ level: 'error', message: 'A secure context (HTTPS or localhost) is required to use the microphone.' })
  }
  if (!caps.getUserMedia) {
    issues.push({ level: 'error', message: 'This browser has no microphone access, so your lines can’t be scored.' })
  }

  if (settings.recognizer === 'whisper') {
    if (!caps.wasm) {
      issues.push({ level: 'error', message: 'This browser can’t run WebAssembly, which the on-device Whisper recogniser needs.' })
    } else if (!caps.webgpu) {
      issues.push({
        level: 'warn',
        message: `${browserLabel()} has no WebGPU, so Whisper runs on WebAssembly — the first download is larger and transcription is a bit slower. It still works.`,
      })
    }
  }

  if (settings.recognizer === 'webspeech' && !caps.webSpeechRecognition) {
    issues.push({
      level: 'error',
      message: `Web Speech recognition isn’t available in ${browserLabel()}. Switch to Whisper in Settings.`,
    })
  }

  if (settings.tts === 'webspeech' && !caps.speechSynthesis) {
    issues.push({
      level: 'warn',
      message: 'No system speech voices here — choose the Kokoro voice in Settings for the scene partner.',
    })
  }

  // A cloud voice without its key would fail on the first partner line — catch
  // it here, before the rehearsal starts.
  if (isPremiumEngine(settings.tts)) {
    const cfg = settings.premium[settings.tts]
    const usable = !!cfg?.apiKey || (settings.tts === 'elevenlabs' && !!cfg?.proxyUrl)
    if (!usable) {
      issues.push({
        level: 'error',
        message: `The ${ENGINE_INFO[settings.tts].label} voice needs an API key — add one in Settings, or switch to a free voice.`,
      })
    } else if (settings.tts === 'azure' && !cfg?.region) {
      issues.push({ level: 'error', message: 'Azure Speech needs a region (e.g. "uksouth") in Settings.' })
    }
  }

  return issues
}

export function hasBlockingIssue(issues: CompatIssue[]): boolean {
  return issues.some((i) => i.level === 'error')
}
