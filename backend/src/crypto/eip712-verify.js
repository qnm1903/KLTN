import { ethers } from 'ethers';

function normalizeAddress(value) {
  return String(value || '').trim().toLowerCase();
}

function assertObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
}

export function verifyEIP712Signature({
  domain,
  types,
  message,
  signature,
  expectedSigner,
  primaryType
}) {
  assertObject(domain, 'domain');
  assertObject(types, 'types');
  assertObject(message, 'message');

  if (!signature || typeof signature !== 'string') {
    throw new Error('signature is required');
  }
  if (!expectedSigner || typeof expectedSigner !== 'string') {
    throw new Error('expectedSigner is required');
  }

  const signerAddress = normalizeAddress(expectedSigner);
  if (!ethers.isAddress(signerAddress)) {
    throw new Error('expectedSigner must be a valid address');
  }

  const resolvedTypes = primaryType
    ? { [primaryType]: types[primaryType] }
    : { ...types };

  const recoveredAddress = normalizeAddress(
    ethers.verifyTypedData(domain, resolvedTypes, message, signature)
  );

  return {
    valid: recoveredAddress === signerAddress,
    recoveredAddress,
    signerAddress
  };
}