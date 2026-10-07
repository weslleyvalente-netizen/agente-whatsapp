import {describe,it,expect,vi,beforeEach,afterEach} from 'vitest';
import {trailingThrottle} from './throttle.js';
beforeEach(()=>vi.useFakeTimers());afterEach(()=>vi.useRealTimers());
describe('trailingThrottle',()=>{
 it('runs the first call immediately',()=>{const fn=vi.fn();trailingThrottle(fn,1000)();expect(fn).toHaveBeenCalledTimes(1);});
 it('collapses a burst into one trailing run after the wait',()=>{
  const fn=vi.fn();const t=trailingThrottle(fn,1000);
  t();for(let i=0;i<50;i++)t();
  expect(fn).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(999);expect(fn).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(1);expect(fn).toHaveBeenCalledTimes(2);
  vi.advanceTimersByTime(5000);expect(fn).toHaveBeenCalledTimes(2);
 });
 it('runs again immediately after the cooldown has passed',()=>{
  const fn=vi.fn();const t=trailingThrottle(fn,1000);t();vi.advanceTimersByTime(1500);t();expect(fn).toHaveBeenCalledTimes(2);
 });
 it('cancel drops the pending trailing run',()=>{
  const fn=vi.fn();const t=trailingThrottle(fn,1000);t();t();t.cancel();vi.advanceTimersByTime(2000);expect(fn).toHaveBeenCalledTimes(1);
 });
});
