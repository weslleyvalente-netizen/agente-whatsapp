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
for(const name of ['00010_tasks.sql','00024_opportunities.sql','00029_task_consolidated_pendencies.sql','20261001194818_sales_opportunity_freeze.sql']) await db.exec(readFileSync(root+name,'utf8'));
await db.exec(`ALTER TABLE conversation_qualifications ADD COLUMN cpf_encrypted text, ADD COLUMN birth_date date, ADD COLUMN has_driver_license boolean, ADD COLUMN down_payment_amount numeric, ADD COLUMN product_model text;
CREATE TABLE handoff_events(id uuid primary key,organization_id uuid,conversation_id uuid,trigger_type text,motivo text,resumo text,urgencia text,handed_at timestamptz,first_human_reply_at timestamptz);
CREATE TABLE agents(id uuid primary key,organization_id uuid,tools_config jsonb);
ALTER TABLE conversations ADD COLUMN agent_id uuid;`);
try{await db.exec(readFileSync(root+'20261002023000_sales_marina_queue.sql','utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
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

await db.exec(`UPDATE organizations SET settings=settings||'{"sales_qualified_handoff_task_enabled":true,"default_handoff_assignee_id":"${user}"}'::jsonb WHERE id='${org}';
INSERT INTO wa_contacts VALUES('${id(20)}','${org}');INSERT INTO conversations(id,organization_id,contact_id,status,last_message_at) VALUES('${id(21)}','${org}','${id(20)}','waiting',now());
INSERT INTO messages VALUES('${id(22)}','${org}','${id(21)}','contact','Ok',now(),NULL);
INSERT INTO conversation_qualifications(conversation_id,organization_id,cpf_encrypted,birth_date,has_driver_license,down_payment_amount,product_model) VALUES('${id(21)}','${org}','encrypted','1990-01-01',true,3000,'CG160 Titan');
INSERT INTO handoff_events VALUES('${id(23)}','${org}','${id(21)}','request_human','documentos','Rodar análise da CG160 Titan','normal',now(),NULL);`);
const simulation=()=>db.query('SELECT sync_sales_pipeline($1,$2,$3,$4,$5,$6,$7,$8)',[org,id(21),id(22),null,'financing','awaiting_simulation',false,{product_model:'CG160 Titan',down_payment_amount:3000}]);
await simulation();await simulation();
result=await db.query('SELECT * FROM tasks WHERE conversation_id=$1',[id(21)]);
if(result.rows.length!==1||result.rows[0].type!=='run_quote'||result.rows[0].assignee_id!==user)throw Error('Qualified handoff task missing/duplicated/unassigned');
console.log('PASS qualified handoff makes one shared-account simulation task');
const financing=(await db.query('SELECT * FROM opportunities WHERE contact_id=$1',[id(20)])).rows[0];
await db.query("UPDATE opportunities SET stage='financing_rejected' WHERE id=$1",[financing.id]);await simulation();
result=await db.query('SELECT stage FROM opportunities WHERE id=$1',[financing.id]);if(result.rows[0].stage!=='financing_rejected')throw Error('AI overwrote human bank result');
console.log('PASS human bank result preserved');
await db.query("UPDATE messages SET content='Quero consórcio' WHERE id=$1",[id(22)]);
await db.query('SELECT sync_sales_pipeline($1,$2,$3,$4,$5,$6,$7,$8)',[org,id(21),id(22),null,'consortium','qualification',true,{}]);
result=await db.query('SELECT operation,stage FROM opportunities WHERE id=$1',[financing.id]);
if(result.rows[0].operation!=='financing'||result.rows[0].stage!=='financing_rejected')throw Error('Operation switch overwrote human bank result');
console.log('PASS explicit operation switch preserves human bank result');

// Disabled flag must not create a human task even when qualification is complete.
await db.exec(`UPDATE organizations SET settings=settings||'{"sales_qualified_handoff_task_enabled":false}'::jsonb;INSERT INTO wa_contacts VALUES('${id(30)}','${org}');INSERT INTO conversations(id,organization_id,contact_id,status,last_message_at) VALUES('${id(31)}','${org}','${id(30)}','waiting',now());INSERT INTO messages VALUES('${id(32)}','${org}','${id(31)}','contact','Quero fechar consórcio',now(),NULL);INSERT INTO handoff_events VALUES('${id(33)}','${org}','${id(31)}','request_human','proposta_pronta','Quero fechar','alta',now(),NULL);`);
const close=()=>db.query('SELECT sync_sales_pipeline($1,$2,$3,$4,$5,$6,$7,$8)',[org,id(31),id(32),null,'consortium','decision_negotiation',true,{}]);await close();
result=await db.query('SELECT count(*) AS n FROM tasks WHERE conversation_id=$1',[id(31)]);if(Number(result.rows[0].n)!==0)throw Error('Disabled flag created task');
console.log('PASS flag off creates no task');
const business=(await db.query('SELECT id FROM opportunities WHERE contact_id=$1',[id(30)])).rows[0].id;
await db.exec(`UPDATE organizations SET settings=settings||'{"sales_qualified_handoff_task_enabled":true}'::jsonb;INSERT INTO tasks(organization_id,contact_id,conversation_id,opportunity_id,type,title,description,priority,due_date,created_by_type) VALUES('${org}','${id(30)}','${id(31)}','${business}','awaiting_customer_cpf','CPF','Pendência original','urgent',CURRENT_DATE+20,'ai');`);
await close();await close();
result=await db.query('SELECT * FROM tasks WHERE opportunity_id=$1',[business]);if(result.rows.length!==1||result.rows[0].type!=='awaiting_customer_cpf'||result.rows[0].consolidated_pendencies.length!==2||result.rows[0].consolidated_pendencies[0].description!=='Pendência original')throw Error('Existing task lost pendency/duplicated');
console.log('PASS preserves existing CPF task, priority and future date');
// Failure creating an audit event rolls back assignment and pendency together.
await db.exec(`INSERT INTO handoff_events VALUES('${id(34)}','${org}','${id(31)}','request_human','proposta_pronta','Novo pedido','normal',now()+interval '1 second',NULL);
CREATE FUNCTION reject_handoff_event() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN IF NEW.event_type=''qualified_handoff'' THEN RAISE EXCEPTION ''forced audit failure''; END IF; RETURN NEW; END';CREATE TRIGGER reject_handoff BEFORE INSERT ON task_events FOR EACH ROW EXECUTE FUNCTION reject_handoff_event();`);
let rolledBack=false;try{await close()}catch{rolledBack=true}if(!rolledBack)throw Error('Expected audit failure');
result=await db.query('SELECT consolidated_pendencies FROM tasks WHERE opportunity_id=$1',[business]);if(result.rows[0].consolidated_pendencies.length!==2)throw Error('Pendency survived rollback');
console.log('PASS atomic rollback on event failure');
await db.close();
