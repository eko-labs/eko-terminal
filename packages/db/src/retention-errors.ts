/** Error metadata only: never copy messages, SQL, parameters, causes or row data into reports. */
const phases = new WeakMap<object, string>();
export async function retentionPhase<T>(phase: string, work: () => Promise<T>): Promise<T> {
  try { return await work(); }
  catch (error) {
    if (typeof error === 'object' && error !== null && !phases.has(error)) phases.set(error, phase);
    throw error;
  }
}
export interface RetentionFailure { failed: true; code: string | null; errorConstructor: string; phase: string }
export function retentionFailure(error: unknown, fallback: string): RetentionFailure {
  const object = typeof error === 'object' && error !== null ? error : undefined;
  const code = (object as {code?: unknown} | undefined)?.code;
  const constructor = object?.constructor?.name;
  return { failed: true, code: typeof code === 'string' && /^[A-Z0-9]{5}$/.test(code) ? code : null,
    errorConstructor: typeof constructor === 'string' && /^[A-Za-z][A-Za-z0-9_]*$/.test(constructor) ? constructor : 'Unknown',
    phase: object ? phases.get(object) ?? fallback : fallback };
}
