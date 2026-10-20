import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { describe, it, expect } from 'vitest';
const migration = readFileSync(new URL('../../../../supabase/migrations/20261022120000_financing_mock.sql', import.meta.url), 'utf8');
async function setup() {
  const db = new PGlite();
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create table organizations(id uuid primary key); create table opportunities(id uuid primary key,organization_id uuid,status text,owner_id uuid);
    grant all on organizations,opportunities to service_role;
    insert into organizations values('00000000-0000-0000-0000-000000000001');
    insert into opportunities values('00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000001','open',null);`);
  await db.exec(migration);
  const q = async (sql: string, p: unknown[] = []) => (await db.query<any>(sql, p)).rows;
  const consent = (await q(`insert into financing_consents(organization_id,opportunity_id,recorded_by,evidence,banks,allow_requery,expires_at)
    values('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002',gen_random_uuid(),'Consentimento registrado',array['mock-rejected'],true,now()+interval '60 days') returning id`))[0].id;
  const create = async (key = '00000000-0000-0000-0000-000000000003', fingerprint = 'same') => (await q(`select financing_create('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002',$1,$2,$3,1,'ciphertext') id`, [consent,key,fingerprint]))[0].id;
  return { db,q,consent,create };
}
describe('durable financing workflow', () => {
  it('does not grant sensitive tables or RPCs to public clients', async () => {
    const {db,q} = await setup();
    try {
      expect((await q(`select has_table_privilege('anon','financing_requests','SELECT') yes`))[0].yes).toBe(false);
      expect((await q(`select has_function_privilege('authenticated','financing_claim()','EXECUTE') yes`))[0].yes).toBe(false);
    } finally { await db.close(); }
  });
  it('deduplicates requests, fences leases and produces one internal alert', async () => {
    const {db,q,create} = await setup();
    try {
      const id = await create(); expect(await create()).toBe(id);
      await expect(create(undefined,'different')).rejects.toThrow('Idempotency conflict');
      const claim = (await q('select * from financing_claim()'))[0];
      expect(await q('select * from financing_claim()')).toHaveLength(0);
      const results = JSON.stringify([{bank:'mock-rejected',status:'rejected',offers:[]}]);
      expect((await q('select financing_complete($1,gen_random_uuid(),$2,null) ok',[id,results]))[0].ok).toBe(false);
      expect((await q('select financing_complete($1,$2,$3,null) ok',[id,claim.lease_token,results]))[0].ok).toBe(true);
      expect((await q('select financing_complete($1,$2,$3,null) ok',[id,claim.lease_token,results]))[0].ok).toBe(false);
      expect(await q('select * from financing_alerts')).toHaveLength(1);
    } finally { await db.close(); }
  });
  it('revocation during processing cancels without accepting offers', async () => {
    const {db,q,create} = await setup();
    try {
      const id=await create(); const claim=(await q('select * from financing_claim()'))[0];
      await q(`select financing_cancel('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002')`);
      expect((await q('select financing_complete($1,$2,$3,null) ok',[id,claim.lease_token,JSON.stringify([{bank:'mock-rejected',status:'preapproved',offers:[]}])]))[0].ok).toBe(false);
      expect((await q('select state from financing_requests'))[0].state).toBe('cancelled');
      expect(await q('select * from financing_alerts')).toHaveLength(0);
    } finally { await db.close(); }
  });
  it('cancels permanently when a sale closes even if the opportunity reopens before sweep',async()=>{
    const {db,q,create}=await setup();
    try{
      await create();
      await q("update opportunities set status='won'");
      await q("update opportunities set status='open'");
      expect((await q('select state,requery_used from financing_requests'))[0]).toMatchObject({state:'cancelled',requery_used:true});
      expect(await q('select * from financing_claim()')).toHaveLength(0);
    }finally{await db.close();}
  });
  it('expires a requery queued yesterday instead of consulting on the wrong day',async()=>{
    const {db,q,create}=await setup();
    try{
      const id=await create();
      await q("update financing_requests set state='completed',attempt=1,execute_on=(now() at time zone 'America/Sao_Paulo')::date-1 where id=$1",[id]);
      await q("update financing_requests set state='queued' where id=$1",[id]);
      expect(await q('select * from financing_claim()')).toHaveLength(0);
      expect((await q('select state from financing_requests'))[0].state).toBe('cancelled');
    }finally{await db.close();}
  });
  it('creates only one requery, never a third even if the scheduler repeats', async () => {
    const {db,q,create} = await setup();
    try {
      await create(); const claim=(await q('select * from financing_claim()'))[0];
      await q(`update financing_requests set first_started_at=now()-interval '40 days'`);
      const today=(await q(`select (now() at time zone 'America/Sao_Paulo')::date::text as date_value`))[0].date_value;
      await q('select financing_complete($1,$2,$3,$4)',[claim.id,claim.lease_token,JSON.stringify([{bank:'mock-rejected',status:'rejected',offers:[]}]),today]);
      await q('select financing_schedule_requeries()'); await q('select financing_schedule_requeries()');
      expect(await q('select * from financing_requests')).toHaveLength(2);
      const child=(await q('select * from financing_claim()'))[0]; expect(child.attempt).toBe(1);
      await q('select financing_complete($1,$2,$3,$4)',[child.id,child.lease_token,JSON.stringify([{bank:'mock-rejected',status:'rejected',offers:[]}]),today]);
      await q('select financing_schedule_requeries()'); expect(await q('select * from financing_requests')).toHaveLength(2);
    } finally { await db.close(); }
  });
});
