import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { getAdminClient } = vi.hoisted(() => ({ getAdminClient: vi.fn() }));

vi.mock("@aula-agente/database", () => ({ getAdminClient }));

import { syncContactToCrm } from "./crm-sync.js";

const baseContact = {
  id: "wa-contact-1",
  organization_id: "org-1",
  phone: "5511999998888",
  name: "Maria",
};

describe("syncContactToCrm", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    process.env.CRM_SYNC_ORGANIZATION_ID = "org-1";
  });

  afterEach(() => {
    delete process.env.CRM_SYNC_ORGANIZATION_ID;
  });

  it("creates a new CRM contact and activity when no match exists by phone", async () => {
    const insertActivity = vi.fn().mockResolvedValue({ error: null });
    const insertContact = vi.fn(() => ({
      select: () => ({
        single: () => Promise.resolve({ data: { id: "crm-contact-1" }, error: null }),
      }),
    }));
    const from = vi.fn((table: string) => {
      if (table === "contacts") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () => Promise.resolve({ data: null, error: null }),
            }),
          }),
          insert: insertContact,
        };
      }
      if (table === "activities") {
        return { insert: insertActivity };
      }
      throw new Error(`unexpected table ${table}`);
    });

    getAdminClient.mockReturnValue({ from });

    await syncContactToCrm(baseContact);

    expect(insertContact).toHaveBeenCalledWith({ name: "Maria", phone: "5511999998888" });
    expect(insertActivity).toHaveBeenCalledWith({
      contact_id: "crm-contact-1",
      title: "Novo contato via WhatsApp",
      done: false,
    });
  });

  it("reuses an existing CRM contact matched by phone instead of creating a new one", async () => {
    const insertActivity = vi.fn().mockResolvedValue({ error: null });
    const insertContact = vi.fn();
    const from = vi.fn((table: string) => {
      if (table === "contacts") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () =>
                Promise.resolve({ data: { id: "crm-contact-existing" }, error: null }),
            }),
          }),
          insert: insertContact,
        };
      }
      if (table === "activities") {
        return { insert: insertActivity };
      }
      throw new Error(`unexpected table ${table}`);
    });

    getAdminClient.mockReturnValue({ from });

    await syncContactToCrm(baseContact);

    expect(insertContact).not.toHaveBeenCalled();
    expect(insertActivity).toHaveBeenCalledWith({
      contact_id: "crm-contact-existing",
      title: "Novo contato via WhatsApp",
      done: false,
    });
  });

  it("does nothing for contacts outside the configured sync organization", async () => {
    const from = vi.fn();
    getAdminClient.mockReturnValue({ from });

    await syncContactToCrm({ ...baseContact, organization_id: "other-org" });

    expect(from).not.toHaveBeenCalled();
  });

  it("does nothing when CRM_SYNC_ORGANIZATION_ID is not configured", async () => {
    delete process.env.CRM_SYNC_ORGANIZATION_ID;
    const from = vi.fn();
    getAdminClient.mockReturnValue({ from });

    await syncContactToCrm(baseContact);

    expect(from).not.toHaveBeenCalled();
  });

  it("swallows errors instead of throwing to the caller", async () => {
    const from = vi.fn(() => {
      throw new Error("boom");
    });
    getAdminClient.mockReturnValue({ from });

    await expect(syncContactToCrm(baseContact)).resolves.toBeUndefined();
  });
});
