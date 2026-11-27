// Regressão de 27/11: com duas FKs entre lead_assignments e sales_reps (rep_id e responsible_rep_id), embutir "sales_reps(...)" sem
// dizer a relação faz o PostgREST recusar a consulta ("more than one relationship was found") e derrubou os avisos push.
// Toda consulta que embute sales_reps deve indicar a FK: sales_reps!<nome_da_fk>(...).
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dir = new URL("./", import.meta.url);
const files = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));

describe("embeds do PostgREST com relação explícita", () => {
  it("nenhuma consulta embute sales_reps sem indicar a FK", () => {
    const offenders = files.flatMap((f) => {
      const src = readFileSync(new URL(f, dir), "utf8");
      return [...src.matchAll(/["'`,\s]sales_reps\(/g)].map(() => f);
    });
    expect(offenders).toEqual([]);
  });
});
