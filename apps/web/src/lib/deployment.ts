import { NETWORKS, CHAIN_NETWORK, type PublicConfig } from '@eko/shared';
import { useShell } from '../store/shell';
import { SHELL_COPY } from '../copy/shell';
import { BUILD_CHAIN_ID, CHAIN_KEY } from './chain';

/** This build's network entry: the wallet chain, its name and explorer. */
export const BUILD_NETWORK = NETWORKS[CHAIN_NETWORK[CHAIN_KEY]];

/**
 * A deployment error, or null. The web is built for one chain (VITE_EKO_CHAIN) and the server starts on one chain
 * (EKO_CHAIN); when the server reports a different chain in PublicConfig.chain, every signature this build would ask
 * for (SIWE, approvals, swaps, session keys) targets the wrong chain, so signing is blocked rather than guessed.
 * A server that reports no chain predates the field and is assumed to match.
 */
export function deploymentMismatch(config: Pick<PublicConfig, 'chain'> | null | undefined): string | null {
  const served = config?.chain;
  if (!served || (served.key === CHAIN_KEY && served.id === BUILD_CHAIN_ID)) return null;
  return SHELL_COPY.deploymentError(`${BUILD_NETWORK.name} (chain ${BUILD_CHAIN_ID})`, `${served.name} (chain ${served.id})`);
}

/** Throws the deployment error before any wallet prompt. */
export function assertDeploymentChain(config: Pick<PublicConfig, 'chain'> | null | undefined = useShell.getState().config) {
  const message = deploymentMismatch(config);
  if (message) throw new Error(message);
}
