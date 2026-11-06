"use client";

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { SELLER_AUDIO_MAX_SECONDS, micErrorMessage, pickRecorderMimeType, recorderReducer, type RecState } from "@/lib/audio-recorder";

function detectMimeType(): string | null {
  if (typeof window === "undefined" || typeof MediaRecorder === "undefined") return null;
  if (!navigator.mediaDevices?.getUserMedia) return null;
  return pickRecorderMimeType((t) => MediaRecorder.isTypeSupported(t));
}

export function useAudioRecorder() {
  const [state, dispatch] = useReducer(recorderReducer, { phase: "idle", seconds: 0 } as RecState);
  const [error, setError] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [supported, setSupported] = useState(true);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const blobRef = useRef<Blob | null>(null);
  const urlRef = useRef<string | null>(null);
  const cancelledRef = useRef(false);
  const mimeRef = useRef<string | null>(null);
  const startingRef = useRef(false);
  const sendingRef = useRef(false);
  const unmountedRef = useRef(false);
  const phaseRef = useRef(state.phase);
  phaseRef.current = state.phase;

  useEffect(() => {
    mimeRef.current = detectMimeType();
    setSupported(mimeRef.current !== null);
  }, []);

  const releaseStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  const clearPreview = useCallback(() => {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = null;
    blobRef.current = null;
    setPreviewUrl(null);
  }, []);

  // Para o gravador sem produzir áudio (descarte/unmount).
  const abort = useCallback(() => {
    cancelledRef.current = true;
    const rec = recorderRef.current;
    recorderRef.current = null;
    if (rec && rec.state !== "inactive") {
      try { rec.stop(); } catch { /* já parado */ }
    }
    releaseStream();
    chunksRef.current = [];
  }, [releaseStream]);

  // Timer de 1 s enquanto grava.
  useEffect(() => {
    if (state.phase !== "recording") return;
    const id = setInterval(() => dispatch({ type: "tick" }), 1000);
    return () => clearInterval(id);
  }, [state.phase]);

  // Saiu de "recording" (stop, limite de 300 s ou gravação curta demais).
  useEffect(() => {
    if (state.phase === "recording") return;
    const rec = recorderRef.current;
    if (!rec || rec.state === "inactive") return;
    if (state.phase === "idle") cancelledRef.current = true; // < 1 s: descartada
    rec.stop();
  }, [state.phase]);

  useEffect(() => {
    unmountedRef.current = false; // strict mode re-monta o efeito
    return () => {
      unmountedRef.current = true;
      abort();
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    };
  }, [abort]);

  // Limite: para exatamente em 300 s (gravação <= 300 s).
  useEffect(() => {
    if (state.phase === "recording" && state.seconds >= SELLER_AUDIO_MAX_SECONDS) dispatch({ type: "stop" });
  }, [state.phase, state.seconds]);

  const start = useCallback(async () => {
    if (startingRef.current || state.phase !== "idle") return;
    const mimeType = mimeRef.current;
    if (!mimeType) { setSupported(false); return; }
    startingRef.current = true;
    setError(null);
    clearPreview();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (unmountedRef.current) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      streamRef.current = stream;
      const recorder = new MediaRecorder(stream, { mimeType });
      chunksRef.current = [];
      cancelledRef.current = false;
      recorder.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      recorder.onerror = () => {
        abort();
        clearPreview();
        setError("Não foi possível iniciar a gravação.");
        dispatch({ type: "discard" });
      };
      recorder.onstop = () => {
        const cancelled = cancelledRef.current;
        const chunks = chunksRef.current;
        chunksRef.current = [];
        if (recorderRef.current === recorder) recorderRef.current = null;
        releaseStream();
        if (cancelled || chunks.length === 0) return;
        const blob = new Blob(chunks, { type: recorder.mimeType || mimeType });
        blobRef.current = blob;
        urlRef.current = URL.createObjectURL(blob);
        setPreviewUrl(urlRef.current);
      };
      recorderRef.current = recorder;
      recorder.start();
      dispatch({ type: "start" });
    } catch (e) {
      releaseStream();
      if (!unmountedRef.current) setError(micErrorMessage(e));
    } finally {
      startingRef.current = false;
    }
  }, [state.phase, abort, clearPreview, releaseStream]);

  const stop = useCallback(() => dispatch({ type: "stop" }), []);

  const discard = useCallback(() => {
    if (sendingRef.current || phaseRef.current === "sending") return;
    abort();
    clearPreview();
    dispatch({ type: "discard" });
  }, [abort, clearPreview]);

  const send = useCallback(async (upload: (blob: Blob, seconds: number) => Promise<void>) => {
    if (sendingRef.current || state.phase !== "review") return;
    const blob = blobRef.current;
    if (!blob) return;
    sendingRef.current = true;
    dispatch({ type: "send" });
    try {
      await upload(blob, state.seconds);
      clearPreview();
      dispatch({ type: "sent" });
    } catch (e) {
      dispatch({ type: "failed" }); // mantém a gravação para nova tentativa
      throw e;
    } finally {
      sendingRef.current = false;
    }
  }, [state.phase, state.seconds, clearPreview]);

  const canSend = state.phase === "review" && previewUrl !== null;

  return { supported, canSend, phase: state.phase, seconds: state.seconds, error, start, stop, discard, send, previewUrl };
}
