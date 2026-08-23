// Replace only the CLI's RPC factory. Keep its real manifest, verifier and signal handlers.
export async function load(url, context, nextLoad) {
  if (!url.endsWith('/src/rpc/clients.ts')) return nextLoad(url, context);
  return { format: 'module', shortCircuit: true, source: `
    export function createMeteredClients(_env, options) {
      const mode = process.env.EKO_VERIFY_TEST_CASE;
      return {
        public: {
          getChainId: async () => {
            if (mode === 'daily-budget') options.alert('rpc_budget_exhausted', {provider:'paid'});
            if (mode === 'unreachable') throw new Error('fixture RPC unavailable');
            if (mode === 'SIGINT' || mode === 'SIGTERM') {
              console.log('mock RPC pending');
              return new Promise(() => {});
            }
            return 4663;
          },
          getBlockNumber: async () => {
            options.onSessionBudget();
            throw Object.assign(new Error('rpc_session_budget_reached'), {code:'rpc_session_budget_reached'});
          },
        },
        meter: { stop() {}, async close() {} },
      };
    }
  ` };
}
