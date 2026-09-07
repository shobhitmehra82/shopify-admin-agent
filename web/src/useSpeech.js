import { useCallback, useEffect, useRef, useState } from "react";

// Web Speech API. Chrome and Edge expose it prefixed; Safari 16+ ships it
// prefixed too. Firefox has no implementation, so `supported` is false there
// and the mic button is hidden rather than throwing on click.
const SpeechRecognition =
  typeof window !== "undefined" &&
  (window.SpeechRecognition || window.webkitSpeechRecognition);

/**
 * Fixed-window dictation: one press records for `seconds`, stops itself, and
 * hands the transcript to `onCommand` — no second click, nothing to confirm.
 *
 * @param {object} options
 * @param {number} options.seconds Recording window, from config.voice.recordingSeconds.
 * @param {(transcript: string) => void} options.onCommand Called once per
 *   recording, with the settled text. Not called when nothing was heard.
 * @returns {{ supported: boolean, listening: boolean, interim: string,
 *             remaining: number, seconds: number, error: string|null,
 *             toggle: () => void }}
 */
export function useSpeech({ seconds = 3, onCommand }) {
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const [remaining, setRemaining] = useState(seconds);
  const [error, setError] = useState(null);

  const recognition = useRef(null);
  // Transcript halves are refs, not state: onend needs the values synchronously,
  // and a state update from onresult would not have landed by then.
  const finalText = useRef("");
  const interimText = useRef("");
  const stopTimer = useRef(null);
  const ticker = useRef(null);
  // Set by onerror so onend doesn't overwrite a real problem (denied mic) with
  // the generic "didn't catch that".
  const hardError = useRef(false);

  // Held in refs so the recogniser is built once. Rebuilding it whenever the
  // parent re-renders would abort an in-progress recording.
  const onCommandRef = useRef(onCommand);
  const secondsRef = useRef(seconds);
  useEffect(() => {
    onCommandRef.current = onCommand;
  }, [onCommand]);
  useEffect(() => {
    secondsRef.current = seconds;
    // Keep the idle readout honest when config changes.
    if (!listening) setRemaining(seconds);
  }, [seconds, listening]);

  const clearTimers = () => {
    clearTimeout(stopTimer.current);
    clearInterval(ticker.current);
    stopTimer.current = null;
    ticker.current = null;
  };

  useEffect(() => {
    if (!SpeechRecognition) return;

    const instance = new SpeechRecognition();
    // The window is what ends the recording, not a pause in speech: someone
    // saying "add two of the... silver one" must not be cut off at the gap.
    instance.continuous = true;
    instance.interimResults = true;
    instance.lang = navigator.language || "en-US";

    instance.onresult = (event) => {
      let pending = "";
      // The recogniser re-sends revised results, so walk from resultIndex and
      // separate what it has committed to from what it may still change.
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) finalText.current += result[0].transcript;
        else pending += result[0].transcript;
      }
      interimText.current = pending;
      setInterim(pending);
    };

    instance.onerror = (event) => {
      // "aborted" and "no-speech" are normal outcomes of stopping or staying
      // quiet, not failures worth showing.
      if (event.error !== "aborted" && event.error !== "no-speech") {
        hardError.current = true;
        setError(
          event.error === "not-allowed"
            ? "Microphone access denied — allow it in your browser settings."
            : `Speech recognition failed: ${event.error}`
        );
      }
    };

    // The single place a recording finishes, however it got there: the window
    // elapsed, the user stopped it early, or the recogniser gave up.
    instance.onend = () => {
      clearTimers();
      setListening(false);
      setInterim("");

      // stop() flushes buffered audio as a final result, but a word clipped by
      // the window can be left as interim — send it rather than losing it.
      const transcript = (finalText.current || interimText.current).trim();
      finalText.current = "";
      interimText.current = "";

      if (transcript) onCommandRef.current(transcript);
      else if (!hardError.current) setError("Didn't catch that — try again.");
    };

    recognition.current = instance;
    return () => {
      instance.onresult = null;
      instance.onerror = null;
      instance.onend = null;
      clearTimers();
      instance.abort();
    };
  }, []);

  const toggle = useCallback(() => {
    const instance = recognition.current;
    if (!instance) return;

    if (listening) {
      // Ends the window early. stop() rather than abort() so what was already
      // said is still transcribed and sent.
      instance.stop();
      return;
    }

    setError(null);
    hardError.current = false;
    finalText.current = "";
    interimText.current = "";
    setInterim("");

    const limit = secondsRef.current;
    setRemaining(limit);

    try {
      instance.start();
    } catch {
      // start() throws InvalidStateError if it is somehow already running;
      // the recogniser is the source of truth, so just reflect that.
    }
    setListening(true);

    // The auto-stop. Everything after it runs through onend above.
    stopTimer.current = setTimeout(() => instance.stop(), limit * 1000);

    // Drives the countdown readout. Measured against a start timestamp so a
    // throttled background tab can't make the bar drift out of step.
    const startedAt = Date.now();
    ticker.current = setInterval(() => {
      setRemaining(Math.max(0, limit - (Date.now() - startedAt) / 1000));
    }, 100);
  }, [listening]);

  return {
    supported: Boolean(SpeechRecognition),
    listening,
    interim,
    remaining,
    seconds,
    error,
    toggle,
  };
}
