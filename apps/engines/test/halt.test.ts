import { expect, it } from 'vitest';
import { enginesHalt } from '../src/halt.js';

it('logs SQLSTATE and a fixed error class without raw database or provider text',()=>{
  const error=Object.assign(new Error('provider https://example.invalid/private-token'),{code:'40P01'});
  expect(enginesHalt(error)).toEqual({event:'engines_halted',code:'40P01',class:'database'});
  expect(JSON.stringify(enginesHalt(error))).not.toContain('private-token');
  expect(enginesHalt({code:'https://example.invalid'})).toEqual({event:'engines_halted',class:'runtime'});
  expect(enginesHalt(null)).toEqual({event:'engines_halted',class:'runtime'});
});
