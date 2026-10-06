import {describe,it,expect} from 'vitest';
import {decideSilenceRetirement,type SilenceRetirementInput} from './silence-retirement.js';
const now='2026-10-10T12:00:00Z';
const ok:SilenceRetirementInput={task:{status:'pending',type:'customer_unresponsive',created_by_type:'ai',consolidated_pendencies:[]},otherOpenTasks:0,lastCustomerMessageAt:'2026-10-01T12:00:00Z',reachedOutAfterCustomer:true,humanTouchAfterCustomer:false,hasPendingHandoff:false,isHumanTakeover:false,openOpportunities:[{stage:'interest_received'}],now};
const retire=(o:Partial<SilenceRetirementInput>)=>decideSilenceRetirement({...ok,...o}).retire;
describe('silence task retirement',()=>{
 it('retires a silent, untouched early-stage task',()=>{expect(retire({})).toBe(true);expect(retire({openOpportunities:[]})).toBe(true);});
 it('keeps recent silence',()=>{expect(retire({lastCustomerMessageAt:'2026-10-05T12:00:00Z'})).toBe(false);});
 it('respects the configured days but never below the minimum',()=>{
  expect(retire({lastCustomerMessageAt:'2026-10-05T12:00:00Z',days:4})).toBe(true);
  expect(retire({lastCustomerMessageAt:'2026-10-09T12:00:00Z',days:0})).toBe(false);
 });
 it('keeps tasks created by humans or of other types',()=>{
  expect(retire({task:{...ok.task,created_by_type:'human'}})).toBe(false);
  expect(retire({task:{...ok.task,type:'scheduled_callback'}})).toBe(false);
 });
 it('keeps tasks with pending send, other pendencies or other open tasks',()=>{
  expect(retire({task:{...ok.task,followup_pending_message_id:'m'}})).toBe(false);
  expect(retire({task:{...ok.task,consolidated_pendencies:[{type:'request_documents'}]}})).toBe(false);
  expect(retire({otherOpenTasks:1})).toBe(false);
 });
 it('keeps handoff, takeover and human touch',()=>{
  expect(retire({hasPendingHandoff:true})).toBe(false);
  expect(retire({isHumanTakeover:true})).toBe(false);
  expect(retire({humanTouchAfterCustomer:true})).toBe(false);
 });
 it('requires that we reached out',()=>{expect(retire({reachedOutAfterCustomer:false})).toBe(false);});
 it('keeps advanced, frozen or scheduled deals',()=>{
  expect(retire({openOpportunities:[{stage:'simulation_sent'}]})).toBe(false);
  expect(retire({openOpportunities:[{stage:'qualification',frozen_until:'2026-11-01'}]})).toBe(false);
  expect(retire({openOpportunities:[{stage:'qualification',waiting_on:'scheduled_date'}]})).toBe(false);
  expect(retire({openOpportunities:[{stage:'qualification',next_action_due_date:'2026-10-12'}]})).toBe(false);
 });
 it('keeps closed tasks',()=>{expect(retire({task:{...ok.task,status:'completed'}})).toBe(false);});
});
