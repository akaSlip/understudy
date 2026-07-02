import type { AppSettings } from '../store/settings'
import type { Recognizer } from './recognizer'
import { WebSpeechRecognizer, webSpeechSupported } from './webSpeechRecognizer'
import { WhisperRecognizer } from './whisperRecognizer'

export function createRecognizer(settings: AppSettings): Recognizer {
  if (settings.recognizer === 'webspeech' && webSpeechSupported()) {
    return new WebSpeechRecognizer()
  }
  return new WhisperRecognizer(settings.whisperModel, { endSilenceMs: settings.endSilenceMs })
}
