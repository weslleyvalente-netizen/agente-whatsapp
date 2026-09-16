import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSendVehiclePhotoTool } from "./send-vehicle-photo.js";
import * as searchCatalog from "./search-catalog.js";

const createMessage = vi.fn();
const addToQueue = vi.fn();

vi.mock("@aula-agente/database", () => ({
  createMessage: (...args: unknown[]) => createMessage(...args),
  getAdminClient: () => ({}),
}));

vi.mock("@aula-agente/queue", () => ({
  getSendMessageQueue: () => ({ add: (...args: unknown[]) => addToQueue(...args) }),
}));

const context = { conversationId: "conv-1", organizationId: "org-1", instanceId: "inst-1", phone: "5562999999999" };

beforeEach(() => {
  createMessage.mockClear();
  createMessage.mockResolvedValue({ id: "msg-1" });
  addToQueue.mockClear();
});

describe("createSendVehiclePhotoTool", () => {
  it("does not enqueue a send and reports honestly when the vehicle has no image at all", async () => {
    // Real production case: catalog's "FAZER FZ15 ABS CONNECTED" has
    // imageUrl: null and no extraImages either. Previously this tool
    // resolved that into a broken "...manus.spacenull" URL, enqueued the
    // send anyway, and told the model "Foto enviada." even though nothing
    // ever reached the customer.
    vi.spyOn(searchCatalog, "fetchCatalog").mockResolvedValue([
      { id: 1, modelo: "FAZER FZ15 ABS CONNECTED", marca: "YAMAHA", ano: 2026, preco: 25900, imageUrl: null, extraImages: [] },
    ]);

    const toolDef = createSendVehiclePhotoTool(context);
    const result = await toolDef.execute!({ modelo: "FAZER FZ15 ABS CONNECTED" }, {} as never);

    expect(result).not.toContain("Foto enviada");
    expect(createMessage).not.toHaveBeenCalled();
    expect(addToQueue).not.toHaveBeenCalled();
  });

  it("sends the photo using the first extraImages entry when imageUrl is null but extraImages exist", async () => {
    vi.spyOn(searchCatalog, "fetchCatalog").mockResolvedValue([
      {
        id: 1,
        modelo: "FAZER FZ15 ABS CONNECTED",
        marca: "YAMAHA",
        ano: 2026,
        preco: 25900,
        imageUrl: null,
        extraImages: [{ url: "/manus-storage/vehicles/1786450742608_f55c92e6.png" }],
      },
    ]);

    const toolDef = createSendVehiclePhotoTool(context);
    const result = await toolDef.execute!({ modelo: "FAZER FZ15 ABS CONNECTED" }, {} as never);

    expect(result).toContain("Foto enviada");
    expect(addToQueue).toHaveBeenCalledWith(
      "send-message",
      expect.objectContaining({ mediaUrl: "https://catalogo.motoetrilha.com.br/manus-storage/vehicles/1786450742608_f55c92e6.png" })
    );
  });

  // Real production case: the catalog has "BROS 160 CBS" twice (Preta
  // R$27.900, Azul R$28.970). The agent called this tool twice meaning to
  // send one photo of each, but without a way to say which color, both
  // calls resolved to the same row — the customer got the blue photo
  // twice and never saw the black one.
  it("sends the correct photo when two vehicles share the same modelo but differ by cor", async () => {
    vi.spyOn(searchCatalog, "fetchCatalog").mockResolvedValue([
      { id: 57, modelo: "BROS 160 CBS", marca: "HONDA", ano: 2026, preco: 28970, cor: "Azul", imageUrl: "/vehicles/azul.png" },
      { id: 49, modelo: "BROS 160 CBS", marca: "HONDA", ano: 2026, preco: 27900, cor: "Preta", imageUrl: "/vehicles/preta.png" },
    ]);

    const toolDef = createSendVehiclePhotoTool(context);
    await toolDef.execute!({ modelo: "BROS 160 CBS", cor: "Azul" }, {} as never);
    await toolDef.execute!({ modelo: "BROS 160 CBS", cor: "Preta" }, {} as never);

    expect(addToQueue).toHaveBeenNthCalledWith(
      1,
      "send-message",
      expect.objectContaining({ mediaUrl: "https://catalogo.motoetrilha.com.br/vehicles/azul.png" })
    );
    expect(addToQueue).toHaveBeenNthCalledWith(
      2,
      "send-message",
      expect.objectContaining({ mediaUrl: "https://catalogo.motoetrilha.com.br/vehicles/preta.png" })
    );
  });
});
