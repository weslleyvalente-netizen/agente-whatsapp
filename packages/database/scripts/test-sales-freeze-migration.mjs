const {PGlite}=await import(process.argv[2] || '@electric-sql/pglite');
import {fileURLToPath} from 'node:url';
import {readFileSync} from 'node:fs';
const db=new PGlite();
await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid primary key); CREATE SCHEMA extensions;
CREATE FUNCTION extensions.uuid_generate_v4() RETURNS uuid LANGUAGE sql AS 'SELECT gen_random_uuid()';
CREATE FUNCTION update_updated_at() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN NEW.updated_at=now(); RETURN NEW; END';
CREATE TABLE organizations(id uuid primary key,settings jsonb);
CREATE TABLE organization_members(organization_id uuid,user_id uuid);
CREATE TABLE wa_contacts(id uuid primary key,organization_id uuid);
CREATE TABLE conversations(id uuid primary key,organization_id uuid,contact_id uuid,status text,last_message_at timestamptz);
CREATE TABLE messages(id uuid primary key,organization_id uuid,conversation_id uuid,role text,content text,created_at timestamptz,evolution_message_id text);
CREATE TABLE conversation_qualifications(conversation_id uuid,organization_id uuid);`);
const root=fileURLToPath(new URL('../../../supabase/migrations/',import.meta.url));
for(const name of ['00010_tasks.sql','00024_opportunities.sql','00029_task_consolidated_pendencies.sql','20261001193000_sales_opportunity_freeze.sql']) await db.exec(readFileSync(root+name,'utf8'));
console.log('Migration SQL loaded');
const org='00000000-0000-0000-0000-000000000001',user='00000000-0000-0000-0000-000000000002',contact='00000000-0000-0000-0000-000000000003',opp='00000000-0000-0000-0000-000000000004',convo='00000000-0000-0000-0000-000000000005';
await db.exec(`INSERT INTO organizations VALUES('${org}','{"sales_opportunity_freeze_enabled":true,"sales_auto_pipeline_enabled":true}');INSERT INTO auth.users VALUES('${user}');INSERT INTO organization_members VALUES('${org}','${user}');INSERT INTO wa_contacts VALUES('${contact}','${org}');INSERT INTO conversations VALUES('${convo}','${org}','${contact}','open',now());INSERT INTO opportunities(id,organization_id,contact_id,operation,initial_operation,stage) VALUES('${opp}','${org}','${contact}','consortium','consortium','qualification');
INSERT INTO tasks(organization_id,contact_id,opportunity_id,type,title,description,priority,due_date,created_by_type) VALUES('${org}','${contact}','${opp}','awaiting_customer_cpf','CPF','Aguardando CPF','urgent',CURRENT_DATE,'ai');`);
const freeze=()=>db.query(`SELECT set_opportunity_freeze($1,$2,$3,(now() AT TIME ZONE 'America/Sao_Paulo')::date+10,'Retomar mês que vem')`,[org,opp,user]);
await freeze();await freeze();
let result=await db.query('SELECT consolidated_pendencies,type,priority FROM tasks');
if(result.rows.length!==1||result.rows[0].consolidated_pendencies.length!==2||result.rows[0].type!=='awaiting_customer_cpf')throw Error('Pendências ou prioridade perdidas');
console.log('PASS freeze preserves CPF; repeat is idempotent');
await db.query('SELECT set_opportunity_freeze($1,$2,$3,NULL,$4)',[org,opp,user,'Cliente voltou']);
result=await db.query('SELECT consolidated_pendencies,status FROM tasks');
if(result.rows[0].consolidated_pendencies.length!==1||result.rows[0].status==='cancelled')throw Error('Thaw dropped existing pendency');
const audit=await db.query('SELECT frozen_at FROM opportunities WHERE id=$1',[opp]);if(!audit.rows[0].frozen_at)throw Error('Thaw forgot cancellation watermark');
console.log('PASS thaw removes only freeze callback and retains cancellation watermark');
// Invalid actor and invalid date must leave both business and task untouched.
for(const args of [[org,opp,contact,null,'Sem autorização'],[org,opp,user,'2000-01-01','Data vencida']]){
 let rejected=false;try{await db.query('SELECT set_opportunity_freeze($1,$2,$3,$4,$5)',args)}catch{rejected=true}
 if(!rejected)throw Error('Invalid freeze accepted');
}
console.log('PASS invalid actor/date rejected');
const id=n=>`00000000-0000-0000-0000-${String(n).padStart(12,'0')}`;
await db.exec(`INSERT INTO wa_contacts VALUES('${id(10)}','${org}');INSERT INTO conversations VALUES('${id(11)}','${org}','${id(10)}','open',now());INSERT INTO messages VALUES('${id(12)}','${org}','${id(11)}','contact','Quero consórcio',now(),NULL);`);
const sync=(stage='interest_received',response=null)=>db.query('SELECT sync_sales_pipeline($1,$2,$3,$4,$5,$6,$7,$8)',[org,id(11),id(12),response,'consortium',stage,true,{}]);
await sync();await sync();
result=await db.query('SELECT * FROM opportunities WHERE contact_id=$1',[id(10)]);
if(result.rows.length!==1)throw Error('Duplicate pipeline creation');
const automatic=result.rows[0].id;
await sync('qualification');await sync('interest_received');
result=await db.query('SELECT stage FROM opportunities WHERE id=$1',[automatic]);
if(result.rows[0].stage!=='qualification')throw Error('Stage regressed');
let rejected=false;try{await sync('simulation_sent')}catch{rejected=true}
if(!rejected)throw Error('Proposal advanced without confirmed message');
await db.exec(`INSERT INTO messages VALUES('${id(13)}','${org}','${id(11)}','agent','12x R$ 500,00',now(),'confirmed');`);
await sync('simulation_sent',id(13));
result=await db.query('SELECT stage FROM opportunities WHERE id=$1',[automatic]);
if(result.rows[0].stage!=='simulation_sent')throw Error('Confirmed proposal did not advance');
await db.exec(`UPDATE opportunities SET status='won' WHERE id='${automatic}'`);
await sync();
result=await db.query('SELECT count(*) AS count FROM opportunities WHERE contact_id=$1',[id(10)]);
if(Number(result.rows[0].count)!==1)throw Error('Recreated closed business');
console.log('PASS pipeline idempotency, no regression, confirmed proposal, closed business preserved');
// Force an event failure: task and freeze must roll back with it.
await db.exec(`CREATE FUNCTION reject_freeze_event() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RAISE EXCEPTION ''forced event failure''; END';CREATE TRIGGER reject_freeze BEFORE INSERT ON opportunity_events FOR EACH ROW EXECUTE FUNCTION reject_freeze_event();`);
rejected=false;try{await freeze()}catch{rejected=true}
if(!rejected)throw Error('Rollback test failed');
result=await db.query('SELECT frozen_until FROM opportunities WHERE id=$1',[opp]);
if(result.rows[0].frozen_until!==null)throw Error('Freeze survived rollback');
result=await db.query('SELECT consolidated_pendencies FROM tasks WHERE opportunity_id=$1',[opp]);
if(result.rows[0].consolidated_pendencies.length!==1)throw Error('Task survived failed freeze');
console.log('PASS atomic rollback of freeze and callback');
await db.close();
