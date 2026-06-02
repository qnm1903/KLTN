import { http, createConfig } from 'wagmi'
import { sepolia } from 'wagmi/chains'
import { injected } from 'wagmi/connectors'

export const ESCROW_CONTRACT_ADDRESS = import.meta.env.VITE_ESCROW_CONTRACT_ADDRESS;

export const injectedConnector = injected();

export const wagmiConfig = createConfig({
  chains: [sepolia],
  connectors: [
    injectedConnector, 
  ],
  transports: {
    [sepolia.id]: http(),
  },
})