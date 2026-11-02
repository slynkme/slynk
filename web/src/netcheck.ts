// Diagnostic: can this browser reach xx network gateways directly?
//
// Browsers reach gateways at "<first 54 hex chars of gateway ID>.xxnode.io",
// which carry publicly trusted certificates (the native client uses raw IPs).
// The probe makes the same kind of gRPC-web call the real client will, with
// an empty request: a gRPC status coming back proves the certificate, CORS
// and gRPC-web all work from this browser.
//
// This does not verify the NDF signature; the real client will.

const NDF_URL = 'https://elixxir-bins.s3.us-west-1.amazonaws.com/ndf/mainnet.json'
const GATEWAY_DOMAIN = 'xxnode.io'
const MAX_GW_ID_HEX = 64 - GATEWAY_DOMAIN.length - 1

interface NdfGateway {
  Id: string
  Address: string
}

export interface Ndf {
  Timestamp: string
  Gateways: NdfGateway[]
  Nodes: unknown[]
}

export interface Gateway {
  host: string
  port: string
}

export async function fetchNdf(): Promise<Ndf> {
  const res = await fetch(NDF_URL, { cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' })
  if (!res.ok) throw new Error(`network definition download failed (HTTP ${res.status})`)

  // The file is base64 of a small protobuf: the NDF JSON plus its signature.
  const raw = atob((await res.text()).trim())
  const start = raw.indexOf('{"Timestamp"')
  if (start < 0) throw new Error('network definition not found in download')
  return JSON.parse(raw.slice(start, jsonEnd(raw, start) + 1)) as Ndf
}

// jsonEnd returns the index of the brace that closes the object at start.
function jsonEnd(s: string, start: number): number {
  let depth = 0
  let inString = false
  for (let i = start; i < s.length; i++) {
    const c = s[i]
    if (inString) {
      if (c === '\\') i++
      else if (c === '"') inString = false
    } else if (c === '"') inString = true
    else if (c === '{') depth++
    else if (c === '}' && --depth === 0) return i
  }
  throw new Error('network definition is truncated')
}

export function sampleGateways(ndf: Ndf, n: number): Gateway[] {
  const all = ndf.Gateways.map((g) => {
    const id = Uint8Array.from(atob(g.Id), (c) => c.charCodeAt(0))
    const hex = Array.from(id, (b) => b.toString(16).padStart(2, '0')).join('')
    return { host: `${hex.slice(0, MAX_GW_ID_HEX)}.${GATEWAY_DOMAIN}`, port: g.Address.split(':').pop() ?? '' }
  })
  const picks = new Uint32Array(all.length)
  crypto.getRandomValues(picks)
  return all
    .map((g, i) => ({ g, r: picks[i] }))
    .sort((a, b) => a.r - b.r)
    .slice(0, n)
    .map((x) => x.g)
}

export async function probe(g: Gateway, timeoutMs = 8000): Promise<boolean> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const res = await fetch(`https://${g.host}:${g.port}/mixmessages.Gateway/RequestMessages`, {
      method: 'POST',
      headers: { 'content-type': 'application/grpc-web+proto', 'x-grpc-web': '1' },
      body: new Uint8Array(5), // one empty gRPC-web frame
      cache: 'no-store',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      signal: ctl.signal,
    })
    return res.headers.has('grpc-status')
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}
