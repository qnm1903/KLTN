import { File } from 'node:buffer';
import { PinataSDK } from 'pinata';

const DEFAULT_GATEWAY_HOST = 'gateway.pinata.cloud';

function normalizeGatewayHost(gatewayHost) {
  return String(gatewayHost || DEFAULT_GATEWAY_HOST)
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/g, '');
}

function buildGatewayUrl(cid, fileName, gatewayHost) {
  const normalizedGatewayHost = normalizeGatewayHost(gatewayHost);
  const encodedFileName = fileName ? `?filename=${encodeURIComponent(fileName)}` : '';
  return `https://${normalizedGatewayHost}/ipfs/${cid}${encodedFileName}`;
}

function createPinataClient(jwt, gatewayHost) {
  return new PinataSDK({
    pinataJwt: jwt,
    pinataGateway: normalizeGatewayHost(gatewayHost)
  });
}

function normalizeMetadata(metadata = {}) {
  const entries = Object.entries(metadata).filter(([, value]) => value !== undefined && value !== null);
  return Object.fromEntries(entries.map(([key, value]) => [key, String(value)]));
}

function extractCid(payload) {
  return payload?.data?.cid || payload?.cid || payload?.IpfsHash || null;
}

export async function uploadEvidenceToIpfs(file, options = {}) {
  const jwt = process.env.PINATA_JWT;
  if (!jwt) {
    throw new Error('PINATA_JWT is required to upload evidence to IPFS');
  }

  const gatewayHost = options.gatewayHost || process.env.PINATA_GATEWAY_HOST || DEFAULT_GATEWAY_HOST;
  const pinata = createPinataClient(jwt, gatewayHost);
  const uploadFile = new File([file.buffer], file.originalname, {
    type: file.mimetype || 'application/octet-stream'
  });

  let uploadBuilder = pinata.upload.public.file(uploadFile);
  const metadata = normalizeMetadata(options.metadata);
  if (Object.keys(metadata).length > 0) {
    uploadBuilder = uploadBuilder.keyvalues(metadata);
  }

  const payload = await uploadBuilder;

  const cid = extractCid(payload);
  if (!cid) {
    throw new Error('Pinata upload did not return a CID');
  }

  return {
    cid,
    fileUrl: buildGatewayUrl(cid, options.publicName || file.originalname, gatewayHost),
    provider: 'pinata',
    raw: payload
  };
}