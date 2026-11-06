export function resolve(specifier, context, nextResolve) {
  if (specifier === 'fastify') return { url: new URL('./role-image-fastify.mjs', import.meta.url).href, shortCircuit: true };
  return nextResolve(specifier, context);
}
