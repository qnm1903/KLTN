import { http, createConfig } from 'wagmi'
import { sepolia } from 'wagmi/chains'
import { injected } from 'wagmi/connectors'

export const ESCROW_CONTRACT_ADDRESS = import.meta.env.VITE_ESCROW_CONTRACT_ADDRESS || '0x1CB56be434B6A3c678FEDf82A7206e06845D93F0';

// Đảm bảo có chữ "export const wagmiConfig" ở đây
export const wagmiConfig = createConfig({
  chains: [sepolia],
  connectors: [
    injected(),
  ],
  transports: {
    [sepolia.id]: http(),
  },
})