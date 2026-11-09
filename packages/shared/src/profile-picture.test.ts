import { describe, expect, it } from "vitest";
import {
  PROFILE_PICTURE_BUCKET,
  PROFILE_PICTURE_REFRESH_DAYS,
  PROFILE_PICTURE_RETRY_HOURS,
  PROFILE_PICTURE_SIGNED_URL_TTL_SECONDS,
  avatarColorIndex,
  buildProfilePicturePath,
  contactInitials,
  isProfilePicturePathFor,
  shouldRefreshProfilePicture,
} from "./profile-picture.js";

const NOW = new Date("2026-11-08T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const PHONE = "5562999990000";

describe("constantes", () => {
  it("expõe os valores combinados", () => {
    expect(PROFILE_PICTURE_BUCKET).toBe("profile-pictures");
    expect(PROFILE_PICTURE_REFRESH_DAYS).toBe(7);
    expect(PROFILE_PICTURE_RETRY_HOURS).toBe(24);
    expect(PROFILE_PICTURE_SIGNED_URL_TTL_SECONDS).toBe(3600);
  });
});

describe("shouldRefreshProfilePicture", () => {
  it("nunca busca para telefone inválido", () => {
    expect(shouldRefreshProfilePicture({ phone: "109435900932124@lid", profile_picture_path: null, profile_picture_checked_at: null }, NOW)).toBe(false);
    expect(shouldRefreshProfilePicture({ phone: "12", profile_picture_path: null, profile_picture_checked_at: null }, NOW)).toBe(false);
  });
  it("busca quando nunca foi verificado", () => {
    expect(shouldRefreshProfilePicture({ phone: PHONE, profile_picture_path: null, profile_picture_checked_at: null }, NOW)).toBe(true);
  });
  it("com foto, renova só após 7 dias", () => {
    const base = { phone: PHONE, profile_picture_path: "o/c.jpg" };
    expect(shouldRefreshProfilePicture({ ...base, profile_picture_checked_at: ago(6 * DAY) }, NOW)).toBe(false);
    expect(shouldRefreshProfilePicture({ ...base, profile_picture_checked_at: ago(8 * DAY) }, NOW)).toBe(true);
  });
  it("sem foto, tenta de novo só após 24 h", () => {
    const base = { phone: PHONE, profile_picture_path: null };
    expect(shouldRefreshProfilePicture({ ...base, profile_picture_checked_at: ago(23 * HOUR) }, NOW)).toBe(false);
    expect(shouldRefreshProfilePicture({ ...base, profile_picture_checked_at: ago(25 * HOUR) }, NOW)).toBe(true);
  });
  it("data inválida conta como nunca verificado", () => {
    expect(shouldRefreshProfilePicture({ phone: PHONE, profile_picture_path: null, profile_picture_checked_at: "lixo" }, NOW)).toBe(true);
  });
});

describe("contactInitials", () => {
  it("usa as iniciais das duas primeiras palavras, ignorando conectivos", () => {
    expect(contactInitials("Maria da Silva", PHONE)).toBe("MS");
    expect(contactInitials("Ana Paula Souza", PHONE)).toBe("AP");
  });
  it("aceita uma palavra só, em minúsculas", () => {
    expect(contactInitials("joão", PHONE)).toBe("J");
  });
  it("sem nome devolve #", () => {
    expect(contactInitials(null, PHONE)).toBe("#");
    expect(contactInitials("   ", PHONE)).toBe("#");
  });
});

describe("avatarColorIndex", () => {
  it("é estável e fica dentro da paleta", () => {
    const a = avatarColorIndex("abc", 8);
    expect(avatarColorIndex("abc", 8)).toBe(a);
    for (const seed of ["abc", "", "5562999990000", "ç😀"]) {
      const i = avatarColorIndex(seed, 8);
      expect(i).toBeGreaterThanOrEqual(0);
      expect(i).toBeLessThan(8);
    }
  });
});

describe("buildProfilePicturePath", () => {
  it("monta <org>/<contato>.<ext>", () => {
    expect(buildProfilePicturePath({ organizationId: "org", contactId: "contact", extension: "jpg" })).toBe("org/contact.jpg");
    expect(buildProfilePicturePath({ organizationId: "o", contactId: "c", extension: "webp" })).toBe("o/c.webp");
  });
});

describe("isProfilePicturePathFor", () => {
  const ids = { organizationId: "org-1", contactId: "c-1" };
  it("aceita jpg, png e webp do próprio contato", () => {
    for (const ext of ["jpg", "png", "webp"]) expect(isProfilePicturePathFor(`org-1/c-1.${ext}`, ids)).toBe(true);
  });
  it("rejeita outro contato, outra organização, '..', extra segmento, extensão errada e nulos", () => {
    for (const p of ["org-1/c-2.jpg", "org-2/c-1.jpg", "org-1/../org-2/c-1.jpg", "org-1/x/c-1.jpg", "../org-1/c-1.jpg", "org-1/c-1.gif", "org-1/c-1.jpg/", "org-1/c-1", "", null, undefined]) {
      expect(isProfilePicturePathFor(p, ids)).toBe(false);
    }
  });
});
