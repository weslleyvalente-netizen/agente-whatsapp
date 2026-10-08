/**
 * Carga única da distribuição de leads: deixa TODA a carteira existente com um vendedor (a Marina).
 * Só leads NOVOS (sem dono) entram no rodízio. Não cria atribuições (lead_assignments) nem SLA.
 *
 * SIMULAÇÃO por padrão: somente leitura, imprime as contagens.
 * Só grava com --apply (e --confirm=<organization_id>), depois de a migration 20261007120000 estar aplicada
 * (usa conversations.assigned_at e opportunities.owner_assigned_at).
 *
 * Executar a partir da raiz do repositório:
 *   node --env-file=.env --experimental-strip-types packages/database/scripts/assign-legacy-leads.ts \
 *     --organization=<id> --rep-user=<user_id da Marina> [--only-active] [--apply --confirm=<id>]
 *
 * O que muda (apenas onde NÃO há dono vendedor hoje, isto é, dono vazio ou conta compartilhada/legada):
 *  - oportunidades abertas: owner_id = Marina, owner_assigned_at = agora (+ evento owner_changed)
 *  - conversas: assigned_to = Marina, assigned_at = agora (todas; --only-active limita a open/waiting)
 *  - tarefas abertas (pending/in_progress/rescheduled) com responsável vazio/humano não vendedor: assignee = Marina
 * Nunca toca: dono que já é outro vendedor (sales_reps), tarefas da IA, negócios ganhos/perdidos.
 */
import {getAdminClient} from '../dist/index.js';

const arg = (name: string) => process.argv.find(x => x.startsWith(`--${name}=`))?.split('=')[1];
const flag = (name: string) => process.argv.includes(`--${name}`);
const organizationId = arg('organization');
const repUserId = arg('rep-user');
const apply = flag('apply');
const onlyActive = flag('only-active');
if (!organizationId || !repUserId) throw new Error('Informe --organization=<id> e --rep-user=<user_id do vendedor>');
if (apply && arg('confirm') !== organizationId) throw new Error('Para gravar, repita --confirm=<organization_id> (mesmo valor de --organization).');

const db = getAdminClient();
const OPEN_TASK = ['pending', 'in_progress', 'rescheduled'];

async function all<T = any>(query: () => any): Promise<T[]> {
  const rows: T[] = [];
  for (let offset = 0; ; offset += 500) {
    const { data, error } = await query().range(offset, offset + 499);
    if (error) throw error;
    rows.push(...(data ?? []));
    if ((data ?? []).length < 500) return rows;
  }
}

async function chunked(ids: string[], size: number, fn: (chunk: string[]) => Promise<void>) {
  for (let i = 0; i < ids.length; i += size) await fn(ids.slice(i, i + size));
}

const members = await all(() => db.from('organization_members').select('user_id,role').eq('organization_id', organizationId).order('user_id'));
if (!members.some(m => m.user_id === repUserId)) throw new Error('--rep-user não é membro desta organização.');
// Antes da migration a tabela ainda não existe: na simulação isso é normal (nenhum vendedor cadastrado).
let reps: any[] = [];
let salesRepsTableMissing = false;
try {
  reps = await all(() => db.from('sales_reps').select('id,user_id,display_name,availability').eq('organization_id', organizationId).order('rotation_order'));
} catch (err: any) {
  if (err?.code !== 'PGRST205') throw err;
  salesRepsTableMissing = true;
}
if (apply && salesRepsTableMissing) throw new Error('A migration 20261007120000 ainda não foi aplicada (tabela sales_reps ausente). Aplique antes de gravar.');
const otherSellerUsers = new Set(reps.filter(r => r.user_id !== repUserId).map(r => r.user_id as string));
const isLegacyOwner = (userId: string | null) => !userId || !otherSellerUsers.has(userId); // sem dono, dono legado ou o próprio vendedor
const needsChange = (userId: string | null) => userId !== repUserId && isLegacyOwner(userId);

const opps = (await all(() => db.from('opportunities').select('id,owner_id,status').eq('organization_id', organizationId).eq('status', 'open').order('id'))).filter(o => needsChange(o.owner_id));
const convs = (await all(() => db.from('conversations').select('id,assigned_to,status').eq('organization_id', organizationId).order('id')))
  .filter(c => needsChange(c.assigned_to) && (!onlyActive || ['open', 'waiting'].includes(c.status)));
const tasks = (await all(() => db.from('tasks').select('id,assignee_id,assignee_type,status').eq('organization_id', organizationId).in('status', OPEN_TASK).order('id')))
  .filter(t => t.assignee_type !== 'ai' && needsChange(t.assignee_id));

const byStatus = (rows: any[]) => rows.reduce((acc: Record<string, number>, r) => ({ ...acc, [r.status]: (acc[r.status] ?? 0) + 1 }), {});
const report = {
  mode: apply ? 'APLICAR' : 'SIMULACAO (somente leitura)',
  organizationId,
  repUserId,
  sellersInSalesReps: reps.map(r => `${r.display_name} (${r.availability})${r.user_id === repUserId ? ' <- este vendedor' : ''}`),
  warnings: [
    ...(salesRepsTableMissing ? ['Tabela sales_reps ainda não existe (migrations não aplicadas): a simulação assume que ninguém mais é vendedor.'] : []),
    ...(reps.some(r => r.user_id === repUserId) ? [] : ['O vendedor ainda não está em sales_reps (cadastre antes de ligar a distribuição).']),
  ],
  willChange: {
    opportunitiesOpen: opps.length,
    conversations: convs.length,
    conversationsByStatus: byStatus(convs),
    tasksOpen: tasks.length,
  },
  untouched: {
    note: 'Donos que já são outro vendedor, tarefas da IA e negócios ganhos/perdidos não são alterados.',
  },
};
console.log(JSON.stringify(report, null, 2));
if (!apply) {
  console.log('\nSimulação concluída: nada foi gravado. Para gravar: acrescente --apply --confirm=' + organizationId);
  process.exit(0);
}

const now = new Date().toISOString();
await chunked(opps.map(o => o.id), 100, async ids => {
  const { error } = await db.from('opportunities').update({ owner_id: repUserId, owner_assigned_at: now }).eq('organization_id', organizationId).in('id', ids);
  if (error) throw error;
});
for (let i = 0; i < opps.length; i += 100) {
  const events = opps.slice(i, i + 100).map(o => ({
    organization_id: organizationId, opportunity_id: o.id, event_type: 'owner_changed',
    previous_value: { owner_id: o.owner_id }, new_value: { owner_id: repUserId },
    evidence: 'Carga inicial da carteira para o vendedor (distribuição de leads)', changed_by_type: 'system',
  }));
  const { error } = await db.from('opportunity_events').insert(events);
  if (error) throw error;
}
await chunked(convs.map(c => c.id), 100, async ids => {
  const { error } = await db.from('conversations').update({ assigned_to: repUserId, assigned_at: now }).eq('organization_id', organizationId).in('id', ids);
  if (error) throw error;
});
await chunked(tasks.map(t => t.id), 100, async ids => {
  const { error } = await db.from('tasks').update({ assignee_type: 'human', assignee_id: repUserId }).eq('organization_id', organizationId).in('id', ids);
  if (error) throw error;
});
console.log(JSON.stringify({ applied: true, at: now, opportunities: opps.length, conversations: convs.length, tasks: tasks.length }, null, 2));
