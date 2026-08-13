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
});
