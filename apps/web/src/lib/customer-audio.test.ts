import { describe, expect, it } from "vitest";
import { formatAudioDuration, hasStoredAudio } from "./customer-audio";

describe("hasStoredAudio", () => {
  it("só áudio com referência storage:", () => {
    expect(hasStoredAudio({ media_type: "audio", media_url: "storage:customer-audio/a/b/c.mp4" })).toBe(true);
    expect(hasStoredAudio({ media_type: "audio", media_url: null })).toBe(false);
    expect(hasStoredAudio({ media_type: "audio", media_url: "https://x/y.mp3" })).toBe(false);
    expect(hasStoredAudio({ media_type: "image", media_url: "storage:customer-audio/a" })).toBe(false);
  });
});

describe("formatAudioDuration", () => {
  it("formata m:ss", () => {
    expect(formatAudioDuration(7)).toBe("0:07");
    expect(formatAudioDuration(65)).toBe("1:05");
    expect(formatAudioDuration(7.6)).toBe("0:08");
  });
  it("sem duração válida -> null", () => {
    expect(formatAudioDuration(undefined)).toBeNull();
    expect(formatAudioDuration(0)).toBeNull();
    expect(formatAudioDuration("7")).toBeNull();
    expect(formatAudioDuration(NaN)).toBeNull();
  });
});
