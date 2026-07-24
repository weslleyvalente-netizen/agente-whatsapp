import { describe, it, expect } from "vitest";
import { pickAudioFileExtension } from "./audio-transcription.js";

describe("pickAudioFileExtension", () => {
  it("maps audio/mp4 to mp4", () => {
    expect(pickAudioFileExtension("audio/mp4")).toBe("mp4");
  });

  it("maps audio/mpeg and audio/mp3 to mp3", () => {
    expect(pickAudioFileExtension("audio/mpeg")).toBe("mp3");
    expect(pickAudioFileExtension("audio/mp3")).toBe("mp3");
  });

  it("maps audio/wav to wav", () => {
    expect(pickAudioFileExtension("audio/wav")).toBe("wav");
  });

  it("maps audio/webm to webm", () => {
    expect(pickAudioFileExtension("audio/webm")).toBe("webm");
  });

  it("falls back to mp4 for an unrecognized mimetype (e.g. raw WhatsApp ogg/opus)", () => {
    expect(pickAudioFileExtension("audio/ogg; codecs=opus")).toBe("mp4");
  });
});
