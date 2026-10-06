import type {SupabaseClient} from "@supabase/supabase-js";
import {decideSilenceRetirement,toISODateInTimeZone,type Organization} from "@aula-agente/shared";
import {getSilenceRetirementCandidates,retireSilenceTask} from "@aula-agente/database";
import {getRedisConnection} from "@aula-agente/queue";

/**
 * Once a day per organization (flag silence_task_auto_retire_enabled, off by
 * default): cancels AI-created "customer stopped replying" tasks that need no
 * human. Sends nothing and never touches conversations or deals.
 */
export async function runSilenceRetirementCheck(db: SupabaseClient, org: Pick<Organization,"id"|"settings">, now = new Date()): Promise<number> {
 if (org.settings.silence_task_auto_retire_enabled !== true) return 0;
 const claimed = await getRedisConnection().set(`silence-retire:${org.id}:${toISODateInTimeZone(now)}`, "1", "EX", 86400, "NX");
 if (claimed !== "OK") return 0;
 let retired = 0;
 for (const candidate of await getSilenceRetirementCandidates(db, org.id)) {
  try {
   const decision = decideSilenceRetirement({...candidate, now: now.toISOString(), days: org.settings.silence_task_auto_retire_days});
   if (decision.retire && await retireSilenceTask(db, org.id, candidate.rawTask, decision.reason)) retired++;
  } catch (error) {
   console.error("Silence task retirement skipped", candidate.rawTask.id, error);
  }
 }
 if (retired) console.log(`Silence retirement: ${retired} tasks cancelled for org ${org.id}`);
 return retired;
}
