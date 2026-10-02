import {describe,it,expect} from 'vitest';
import {classifySalesQueue,sortSalesQueue} from './sales-queue.js';
const now='2026-10-02T11:00:00Z';
const base={id:'a',created_at:'2026-10-01',status:'open',stage:'qualification',waiting_on:null,next_action_due_date:null,frozen_until:null,sales_state:{readyForHuman:false,customerReplied:false,humanPending:false,taskCount:1},tasks:[]};
describe('Marina operational queue',()=>{
 it('puts qualified handoffs before overdue silent leads',()=>{
  const ready={...base,id:'ready',sales_state:{...base.sales_state,readyForHuman:true}};
  const silent={...base,id:'silent',tasks:[{type:'customer_unresponsive',due_date:'2026-09-01',priority:'urgent'}]};
  expect(classifySalesQueue(silent,now).group).toBe('no_response');
  expect(sortSalesQueue([silent,ready],now).map(x=>x.id)).toEqual(['ready','silent']);
 });
 it('does not put future frozen returns in the action queue',()=>{
  expect(classifySalesQueue({...base,frozen_until:'2026-10-10',sales_state:{...base.sales_state,readyForHuman:true}},now).group).toBe('scheduled');
 });
 it('prioritizes a customer reply even on an unresponsive task',()=>{
  expect(classifySalesQueue({...base,sales_state:{...base.sales_state,customerReplied:true},tasks:[{type:'customer_unresponsive',due_date:'2026-09-01',priority:'normal'}]},now).group).toBe('customer_replied');
 });
 it('keeps bank waits separate from human action',()=>{
  expect(classifySalesQueue({...base,waiting_on:'bank_or_admin'},now).group).toBe('waiting');
 });
 it('puts due commitments ahead of other overdue tasks',()=>{
  expect(classifySalesQueue({...base,tasks:[{type:'scheduled_callback',due_date:'2026-10-02',priority:'normal'}]},now).group).toBe('due_today');
 });
 it('orders urgent then oldest due date within an actionable group without mutation',()=>{
  const a={...base,id:'normal',sales_state:{...base.sales_state,readyForHuman:true},tasks:[{type:'run_quote',priority:'normal',due_date:'2026-10-01'}]};
  const b={...base,id:'urgent',sales_state:{...base.sales_state,readyForHuman:true},tasks:[{type:'run_quote',priority:'urgent',due_date:'2026-10-02'}]};
  const rows=[a,b];expect(sortSalesQueue(rows,now).map(x=>x.id)).toEqual(['urgent','normal']);expect(rows[0].id).toBe('normal');
 });
});

it('keeps a bank result awaiting the team actionable even without a task',()=>{
 expect(classifySalesQueue({...base,stage:'financing_rejected',waiting_on:'team',tasks:[]},now).group).toBe('action');
});
it('does not hide a qualified pendency behind the silent primary type',()=>{
 const task={type:'customer_unresponsive',priority:'high',due_date:'2026-10-20',consolidated_pendencies:[{type:'run_quote',priority:'high',due_date:'2026-10-01'}]};
 expect(classifySalesQueue({...base,tasks:[task]},now).group).toBe('overdue');
});
it('respects a due callback before the fallback action for a bank result',()=>{
 expect(classifySalesQueue({...base,stage:'financing_rejected',waiting_on:'team',tasks:[{type:'scheduled_callback',priority:'urgent',due_date:'2026-10-02'}]},now).group).toBe('due_today');
});
