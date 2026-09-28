import { databaseCode } from '@eko/db';

/** Allow only a SQLSTATE and fixed classifications; raw errors may contain provider credentials. */
export function enginesHalt(error:unknown) {
  const code=databaseCode(error);
  return {event:'engines_halted',class:code ? 'database' : 'runtime',...(code ? {code} : {})};
}
