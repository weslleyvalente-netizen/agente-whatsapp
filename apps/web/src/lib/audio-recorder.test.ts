import { describe, expect, it } from "vitest";
import { pickRecorderMimeType, recorderReducer, type RecState } from "./audio-recorder";

describe("pickRecorderMimeType", () => {
  it("prefere webm/opus", () => {
    expect(pickRecorderMimeType(() => true)).toBe("audio/webm;codecs=opus");
  });
  it("cai para audio/webm", () => {
    expect(pickRecorderMimeType((t) => t === "audio/webm")).toBe("audio/webm");
  });
  it("cai para audio/mp4 (iPhone)", () => {
    expect(pickRecorderMimeType((t) => t === "audio/mp4")).toBe("audio/mp4");
  });
  it("retorna null quando nada é suportado", () => {
    expect(pickRecorderMimeType(() => false)).toBeNull();
  });
});

describe("recorderReducer", () => {
  const idle: RecState = { phase: "idle", seconds: 0 };
  it("start vai para recording com 0 s", () => {
    expect(recorderReducer(idle, { type: "start" })).toEqual({ phase: "recording", seconds: 0 });
  });
  it("tick incrementa só em recording", () => {
    expect(recorderReducer({ phase: "recording", seconds: 3 }, { type: "tick" }).seconds).toBe(4);
    expect(recorderReducer({ phase: "review", seconds: 3 }, { type: "tick" }).seconds).toBe(3);
    expect(recorderReducer(idle, { type: "tick" })).toEqual(idle);
  });
  it("em 300 s o próximo tick leva a review", () => {
    expect(recorderReducer({ phase: "recording", seconds: 299 }, { type: "tick" })).toEqual({ phase: "recording", seconds: 300 });
    expect(recorderReducer({ phase: "recording", seconds: 300 }, { type: "tick" })).toEqual({ phase: "review", seconds: 300 });
  });
  it("stop com menos de 1 s descarta", () => {
    expect(recorderReducer({ phase: "recording", seconds: 0 }, { type: "stop" })).toEqual(idle);
  });
  it("stop com 1 s ou mais vai para review", () => {
    expect(recorderReducer({ phase: "recording", seconds: 1 }, { type: "stop" })).toEqual({ phase: "review", seconds: 1 });
  });
  it("send só em review; repetido em sending é ignorado", () => {
    expect(recorderReducer({ phase: "review", seconds: 5 }, { type: "send" }).phase).toBe("sending");
    const sending: RecState = { phase: "sending", seconds: 5 };
    expect(recorderReducer(sending, { type: "send" })).toBe(sending);
    expect(recorderReducer(idle, { type: "send" })).toBe(idle);
  });
  it("failed volta a review; sent volta a idle", () => {
    expect(recorderReducer({ phase: "sending", seconds: 5 }, { type: "failed" })).toEqual({ phase: "review", seconds: 5 });
    expect(recorderReducer({ phase: "sending", seconds: 5 }, { type: "sent" })).toEqual(idle);
  });
  it("discard volta a idle", () => {
    expect(recorderReducer({ phase: "review", seconds: 5 }, { type: "discard" })).toEqual(idle);
  });
});

import { micErrorMessage } from "./audio-recorder";
describe("micErrorMessage", () => {
  it("mapeia permissão negada", () => {
    expect(micErrorMessage({ name: "NotAllowedError" })).toBe("Permita o uso do microfone para gravar áudio.");
    expect(micErrorMessage({ name: "SecurityError" })).toBe("Permita o uso do microfone para gravar áudio.");
  });
  it("mapeia microfone ausente", () => {
    expect(micErrorMessage({ name: "NotFoundError" })).toBe("Nenhum microfone encontrado neste aparelho.");
  });
  it("demais erros", () => {
    expect(micErrorMessage(new Error("x"))).toBe("Não foi possível iniciar a gravação.");
    expect(micErrorMessage(null)).toBe("Não foi possível iniciar a gravação.");
  });
});
